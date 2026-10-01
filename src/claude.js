import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { getSession, saveSession, clearSession, getActiveToken } from './store.js';

// 실행 중인 SDK query 객체 추적 (세션별)
const runningQueries = new Map();

// 메인 턴이 끝난 뒤 백그라운드 작업(셸·서브에이전트)을 기다리는 최대 시간. 메인이 마지막으로 idle 이 된 시점부터 잰다.
// 브릿지는 입력을 열어 둔 채(streaming input) 기다리므로 CLI 자체 대기 한도는 적용되지 않고 이 값을 브릿지가 집행한다
// (.env 로 조정, 0 = 무제한)
const DEFAULT_BG_WAIT_CEILING_MS = 60 * 60 * 1000;
// 턴이 끝나고 남은 작업이 없을 때 입력을 닫기 전 잠깐 기다린다 — 결과 직후 도착한 완료 알림이 다음 턴을 열 수 있도록
const CLOSE_GRACE_MS = 1500;

/**
 * 실행 중인 Claude query를 중단
 */
export function stopClaudeQuery(sessionKey) {
  const q = runningQueries.get(sessionKey);
  if (q) {
    q.abort();
    return true;
  }
  return false;
}

/**
 * query 에 넣는 입력 스트림. string prompt 를 쓰면 SDK 가 첫 result 에서 stdin 을 닫고,
 * 그러면 CLI 가 백그라운드 셸을 5초 만에 종료하고 이후 턴의 AskUserQuestion 도 막힌다.
 * 그래서 입력을 직접 열어 두고, 브릿지가 끝났다고 판단할 때 닫는다
 */
function createInputStream() {
  const pending = [];
  let wake = null;
  let closed = false;
  return {
    push(text) {
      if (closed) return false;
      pending.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '' });
      wake?.();
      return true;
    },
    close() {
      closed = true;
      wake?.();
    },
    messages: (async function* () {
      while (true) {
        while (pending.length) yield pending.shift();
        if (closed) return;
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
      }
    })(),
  };
}

const TOOL_EMOJI = {
  Read: '📖', Edit: '✏️', Write: '📝', Bash: '💻',
  Grep: '🔍', Glob: '📁', WebFetch: '🌐', WebSearch: '🔎',
  Task: '🤖', Agent: '🤖', default: '⚙️',
};

function truncate(s, len = 50) {
  return s && s.length > len ? s.substring(0, len) + '…' : s;
}

function shortenPath(p) {
  return p ? truncate(p.replace(/^.*\//, ''), 40) : null;
}

function extractToolDetail(toolName, input) {
  try {
    switch (toolName) {
      case 'Read': case 'Write': case 'Edit':
        return shortenPath(input.file_path);
      case 'Bash':
        return truncate(input.command, 60);
      case 'Grep':
        return truncate(input.pattern, 50);
      case 'Glob':
        return truncate(input.pattern, 40);
      case 'WebSearch':
        return truncate(input.query, 50);
      case 'WebFetch':
        return truncate(input.url, 50);
      case 'Task': case 'Agent':
        return truncate(input.description, 40);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * 실행 중인 백그라운드 작업 목록을 진행 표시용 줄로 변환 (없으면 빈 배열)
 * @param {Array<{description: string, lastTool?: string, toolUses?: number}>|undefined} tasks
 */
export function formatBackgroundTasks(tasks, max = 3) {
  if (!tasks?.length) return [];
  const lines = [`🔄 백그라운드 작업 ${tasks.length}개 진행 중`];
  for (const t of tasks.slice(0, max)) {
    const detail = t.lastTool ? ` (${t.lastTool}${t.toolUses ? ` · 도구 ${t.toolUses}회` : ''})` : '';
    lines.push(`  · ${truncate(t.description, 60)}${detail}`);
  }
  if (tasks.length > max) lines.push(`  · 외 ${tasks.length - max}개`);
  return lines;
}

/**
 * Claude Code를 Agent SDK로 실행하고 스트리밍 결과를 반환
 * @param {string} sessionKey - 스레드 기반 세션 키
 * @param {string} prompt - 사용자 프롬프트
 * @param {string|null} workdir - 작업 디렉토리
 * @param {object} callbacks - 콜백 함수들
 * @param {function|null} callbacks.onProgress - 진행상황 콜백 (activities, usage, rateLimit, backgroundTasks)
 * @param {function|null} callbacks.onAskUser - AskUserQuestion 릴레이 콜백 (questions) => Promise<answers>
 * @returns {Promise<{result: string, usage: object|null, rateLimit: object|null, backgroundKill: {ceilingMs: number, tasks: string[]}|null}>}
 *   최종 응답 텍스트와 usage 정보. backgroundKill 은 백그라운드 작업이 대기 한도로 강제 종료됐을 때만 채워진다
 */
export async function runClaudeCode(sessionKey, prompt, workdir, { onProgress, onAskUser, onSessionReady, model: modelOverride, effort: effortOverride } = {}) {
  let sessionId = getSession(sessionKey);
  const isResume = !!sessionId;

  const allowedDirs = process.env.CLAUDE_ALLOWED_DIRS || '';
  const skipPermissions = process.env.CLAUDE_SKIP_PERMISSIONS === 'true';
  const model = modelOverride || process.env.CLAUDE_MODEL || 'sonnet';

  // SDK options 구성
  // systemPrompt: preset을 사용해야 CLI가 ~/.claude/settings.json (language, skills 등)을 정상 로드함
  // systemPrompt를 생략하면 SDK가 빈 문자열("")을 전달하여 기본 시스템 프롬프트가 무시됨
  // CLAUDECODE 환경변수 제거 (nested session 방지)
  const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...cleanEnv } = process.env;

  // 활성 계정 토큰이 있으면 CLAUDE_CODE_OAUTH_TOKEN 오버라이드
  // 없으면 기존 동작(머신 기본 로그인) 유지
  const activeToken = getActiveToken();
  if (activeToken) cleanEnv.CLAUDE_CODE_OAUTH_TOKEN = activeToken;

  const ceilingMs = Number(cleanEnv.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? DEFAULT_BG_WAIT_CEILING_MS);

  // CLI stderr 는 콜백을 넘기지 않으면 버려진다 — pm2 로그에 남긴다
  const stderr = (data) => {
    for (const line of data.split('\n')) {
      if (line.trim()) console.error(`[Claude:stderr] ${sessionKey} ${line}`);
    }
  };

  const options = {
    model,
    effort: effortOverride || 'max',
    cwd: workdir || undefined,
    additionalDirectories: allowedDirs ? allowedDirs.split(',').map(d => d.trim()) : undefined,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    env: cleanEnv,
    stderr,
    ...(skipPermissions
      ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
      : {}),
  };

  if (isResume) {
    options.resume = sessionId;
    console.log(`[Claude] Resuming session ${sessionId} for ${sessionKey}`);
  } else {
    sessionId = randomUUID();
    options.sessionId = sessionId;
    saveSession(sessionKey, sessionId);
    console.log(`[Claude] New session ${sessionId} for ${sessionKey}`);
  }

  // canUseTool 콜백: AskUserQuestion은 Slack으로 릴레이, 나머지는 자동 승인
  // bypassPermissions 에서는 SDK 가 "canUseTool will not be invoked" 경고(CLAUDE_SDK_CAN_USE_TOOL_SHADOWED)를 출력하지만
  // AskUserQuestion 은 bypassPermissions 에서도 이 콜백이 호출되므로 경고는 무시해도 된다
  const abortController = new AbortController();
  const canUseTool = async (toolName, input) => {
    if (toolName === 'AskUserQuestion' && onAskUser) {
      try {
        // AskUserQuestion 호출 시점까지 쌓인 텍스트를 함께 전달 (컨텍스트 표시용)
        const pendingText = finalResult.trim();
        if (pendingText) finalResult = '';
        const answers = await onAskUser(input.questions, abortController.signal, pendingText);
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      } catch (err) {
        return { behavior: 'deny', message: err.message || 'AskUserQuestion 거부됨' };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };

  const input = createInputStream();
  input.push(prompt);

  const q = query({
    prompt: input.messages,
    options: {
      ...options,
      canUseTool,
    },
  });

  // abort + close 래퍼 저장
  runningQueries.set(sessionKey, {
    abort: () => {
      abortController.abort(); // onAskUser의 signal을 fire하여 pending 질문 reject
      input.close();
      try { q.close(); } catch { /* 이미 종료됨 */ } // SDK subprocess 종료
    },
  });

  let finalResult = '';
  const activities = [];
  let lastUsage = null;
  let resultUsage = null;
  let contextWindow = 1000000;
  let lastRateLimit = null;
  let initHandled = false;

  // 백그라운드 작업 — 진행 표시와 강제 종료 안내용
  let backgroundTasks = []; // background_tasks_changed 는 살아있는 작업 전체를 보내므로 통째로 교체
  const taskProgress = new Map(); // task_id → { lastTool, toolUses }
  let backgroundKill = null;

  // 턴 사이: 남은 백그라운드 작업이 없으면 입력을 닫아 끝내고, 있으면 대기 한도 타이머를 건다
  let idle = false;
  let inputClosed = false;
  let closeTimer = null;
  let ceilingTimer = null;
  const clearTimers = () => {
    clearTimeout(closeTimer);
    clearTimeout(ceilingTimer);
    closeTimer = ceilingTimer = null;
  };
  const closeInput = () => {
    if (inputClosed) return;
    inputClosed = true;
    clearTimers();
    input.close();
  };
  const stopAtCeiling = async () => {
    ceilingTimer = null;
    if (!idle || inputClosed) return;
    backgroundKill = { ceilingMs, tasks: backgroundTasks.map(t => t.description) };
    console.log(`[Claude] Background wait ceiling (${ceilingMs}ms) reached for ${sessionKey}: stopping ${backgroundTasks.length} task(s)`);
    for (const t of backgroundTasks) {
      await q.stopTask(t.id).catch(err => console.warn(`[Claude] stopTask ${t.id} failed: ${err.message}`));
    }
    closeInput();
  };
  const scheduleIdleCheck = () => {
    if (!idle || inputClosed) return;
    if (backgroundTasks.length === 0) {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (idle && backgroundTasks.length === 0) closeInput();
      }, CLOSE_GRACE_MS);
    } else if (ceilingMs > 0 && !ceilingTimer) {
      ceilingTimer = setTimeout(stopAtCeiling, ceilingMs);
    }
  };
  const markBusy = () => {
    idle = false;
    clearTimers();
  };

  const reportProgress = () => {
    if (!onProgress) return;
    const tasks = backgroundTasks.map(t => ({ ...t, ...taskProgress.get(t.id) }));
    onProgress(activities, lastUsage, lastRateLimit, tasks);
  };

  try {
    for await (const msg of q) {
      // init 이벤트 — 백그라운드 작업 완료 알림으로 턴이 이어지면 다시 오므로 한 번만 처리
      if (msg.type === 'system' && msg.subtype === 'init') {
        markBusy();
        if (!initHandled) {
          initHandled = true;
          if (msg.session_id && !isResume) {
            if (msg.session_id !== sessionId) {
              sessionId = msg.session_id;
              saveSession(sessionKey, sessionId);
            }
            if (onSessionReady) onSessionReady(sessionId);
          }
        }
      }

      // 백그라운드 작업 목록 / 진행
      if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
        backgroundTasks = msg.tasks.filter(t => !t.ambient).map(t => ({ id: t.task_id, description: t.description }));
        reportProgress();
        scheduleIdleCheck();
      }
      if (msg.type === 'system' && msg.subtype === 'task_progress') {
        taskProgress.set(msg.task_id, { lastTool: msg.last_tool_name, toolUses: msg.usage?.tool_uses });
        if (backgroundTasks.some(t => t.id === msg.task_id)) reportProgress();
      }

      // assistant 메시지 — 도구 사용 추적 + 텍스트 수집
      // 서브에이전트 메시지(parent_tool_use_id)는 진행 표시에만 쓰고 최종 응답·ctx 에서는 뺀다
      if (msg.type === 'assistant' && msg.message?.content) {
        const fromSubagent = !!msg.parent_tool_use_id;
        if (!fromSubagent) markBusy();
        if (msg.message.usage && !fromSubagent) {
          const u = msg.message.usage;
          lastUsage = {
            inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
            outputTokens: u.output_tokens || 0,
            contextWindow,
          };
        }
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            if (!fromSubagent) finalResult += block.text;
          } else if (block.type === 'tool_use') {
            const toolName = block.name || 'unknown';
            const emoji = TOOL_EMOJI[toolName] || TOOL_EMOJI.default;
            const detail = extractToolDetail(toolName, block.input || {});
            const marker = detail ? `${emoji} ${toolName}: ${detail}` : `${emoji} ${toolName}`;
            activities.push(fromSubagent ? `↳ ${marker}` : marker);
            // 도구 사용 마커를 출력에 포함 (raw 출력)
            if (!fromSubagent) finalResult += `\n${marker}\n`;
          }
        }
        if (lastUsage && !fromSubagent) {
          console.log(`[Claude] Usage: ${lastUsage.inputTokens} / ${lastUsage.contextWindow} tokens`);
        }
        reportProgress();
      }

      // rate limit 이벤트 — 5h 사용률 추적
      if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
        const rl = msg.rate_limit_info;
        if (rl.utilization != null) {
          lastRateLimit = {
            pct: Math.round(rl.utilization * 100),
            resetsAt: rl.resetsAt || null,
            type: rl.rateLimitType || null,
          };
        }
      }

      // result 이벤트 — 턴 종료
      // 백그라운드 작업이 남아 있으면 입력을 열어 둔 채 기다리고, 완료 알림마다 턴이 이어져 result 가 여러 번 올 수 있다
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          // msg.result는 마지막 assistant 턴의 텍스트만 포함할 수 있으므로,
          // 스트리밍 중 누적된 텍스트가 더 길면 그것을 사용
          if (msg.result) {
            if (!finalResult || msg.result.length >= finalResult.length) {
              finalResult = msg.result;
            } else {
              console.log(`[Claude] Using accumulated text (${finalResult.length} chars) over msg.result (${msg.result.length} chars)`);
            }
          }
          if (msg.modelUsage) {
            const entries = Object.entries(msg.modelUsage);
            const mainEntry = entries.find(([k]) => !k.includes('haiku')) || entries[0];
            if (mainEntry) {
              const primary = mainEntry[1];
              if (primary?.contextWindow) contextWindow = primary.contextWindow;
              resultUsage = {
                inputTokens: lastUsage?.inputTokens || 0,
                outputTokens: lastUsage?.outputTokens || 0,
                contextWindow,
                costUSD: msg.total_cost_usd || 0,
              };
            }
          }
          // 이어지는 턴(백그라운드 완료 알림)의 텍스트가 붙지 않도록 문단을 나눈다
          if (finalResult && !finalResult.endsWith('\n')) finalResult += '\n\n';
          idle = true;
          scheduleIdleCheck();
        } else {
          // error result
          const errMsg = msg.error || msg.subtype || 'Unknown error';
          if (isResume && msg.subtype === 'error_during_execution') {
            clearSession(sessionKey);
            console.log(`[Claude] Resume failed for session ${sessionId}, cleared. Error: ${errMsg}`);
            throw new Error(`세션 resume 실패 (${sessionId}): ${errMsg}\n새 세션으로 다시 시도해주세요.`);
          }
          throw new Error(errMsg);
        }
      }
    }
    if (abortController.signal.aborted) throw new Error('중단됨 (사용자 요청)');
  } catch (err) {
    if (abortController.signal.aborted) {
      throw new Error('중단됨 (사용자 요청)');
    }
    // resume 실패 처리
    if (isResume && !getSession(sessionKey)) {
      // 이미 clearSession 된 경우 (위 result 핸들러에서)
      throw err;
    }
    if (isResume) {
      clearSession(sessionKey);
      console.log(`[Claude] Resume failed for session ${sessionId}, cleared. Error: ${err.message}`);
      throw new Error(`세션 resume 실패 (${sessionId}): ${err.message}\n새 세션으로 다시 시도해주세요.`);
    }
    throw err;
  } finally {
    clearTimers();
    input.close();
    runningQueries.delete(sessionKey);
  }

  const usage = resultUsage || lastUsage;
  if (backgroundKill) {
    console.log(`[Claude] Background tasks killed at wait ceiling for ${sessionKey}: ${backgroundKill.tasks.join(', ') || '(unknown)'}`);
  }
  return { result: finalResult.trim(), usage, rateLimit: lastRateLimit, backgroundKill };
}
