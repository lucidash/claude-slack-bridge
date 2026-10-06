import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { getSession, saveSession, clearSession, getActiveToken } from './store.js';
import { describeTool, truncate } from './format.js';

// 실행 중인 SDK query (세션별) — 중단·메시지 주입·상태 확인용
const liveQueries = new Map();

// 메인 턴이 끝난 뒤 백그라운드 작업(셸·서브에이전트)을 기다리는 최대 시간. 메인이 마지막으로 idle 이 된 시점부터 잰다.
// 브릿지는 입력을 열어 둔 채(streaming input) 기다리므로 CLI 자체 대기 한도는 적용되지 않고 이 값을 브릿지가 집행한다
// (.env 로 조정, 0 = 무제한)
const DEFAULT_BG_WAIT_CEILING_MS = 60 * 60 * 1000;
// 턴이 끝나고 남은 작업이 없을 때 입력을 닫기 전 잠깐 기다린다 — 결과 직후 도착한 완료 알림이 다음 턴을 열 수 있도록.
// 대기 중에 완료 알림을 이미 받았다면 곧 그 알림으로 턴이 열리므로 더 길게 기다린다
const CLOSE_GRACE_MS = 1500;
const NOTIFIED_CLOSE_GRACE_MS = 15000;
const MAX_ACTIVITIES = 20;

// 스레드에 effort 지정이 없을 때 SDK 엔진이 쓰는 기본값 (`!effort` 안내문도 이 값을 표시한다)
export const DEFAULT_EFFORT = 'xhigh';

/**
 * 실행 중인 Claude query를 중단 (백그라운드 작업도 함께 종료된다)
 */
export function stopClaudeQuery(sessionKey) {
  const q = liveQueries.get(sessionKey);
  if (q) {
    q.abort();
    return true;
  }
  return false;
}

/**
 * 턴 사이(백그라운드 작업 대기 중)인 query 에 사용자 메시지를 넣어 다음 턴을 연다. 넣지 못하면 false
 */
export function sendToClaudeQuery(sessionKey, text) {
  return liveQueries.get(sessionKey)?.send(text) ?? false;
}

/**
 * @returns {'turn'|'idle'|'closing'|null} turn: 턴 진행 중, idle: 턴 사이(백그라운드 대기), closing: 입력을 닫고 종료 중
 */
export function getClaudeQueryState(sessionKey) {
  return liveQueries.get(sessionKey)?.state() ?? null;
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

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => c?.text || '').join('\n');
  return '';
}

/**
 * Claude Code를 Agent SDK로 실행한다. 턴이 끝나도 백그라운드 작업이 남아 있으면 query 를 열어 두고,
 * 작업 완료 알림이나 sendToClaudeQuery() 로 넣은 메시지마다 턴이 이어진다
 *
 * @param {string} sessionKey - 스레드 기반 세션 키
 * @param {string} prompt - 첫 턴 프롬프트
 * @param {string|null} workdir - 작업 디렉토리
 * @param {object} handlers
 * @param {function} [handlers.onTurnStart] - 두 번째 턴부터 턴이 시작될 때 ({ notifications: [{description, status}] }) — 직전 result 이후 끝난 백그라운드 작업
 * @param {function} [handlers.onText] - 메인 스레드 텍스트 블록 (text)
 * @param {function} [handlers.onToolUse] - 메인 스레드 도구 호출 ({ id, name, input, messageId })
 * @param {function} [handlers.onToolResult] - 메인 스레드 도구 결과 ({ id, isError, text })
 * @param {function} [handlers.onSubagentProgress] - 서브에이전트 진행 ({ toolUseId, lastTool, toolUses, summary })
 * @param {function} [handlers.onBackgroundTasks] - 백그라운드 작업 변경 (tasks) — 한 번이라도 백그라운드에 오른 작업 전체
 * @param {function} [handlers.onTurnEnd] - 턴 종료 (await 됨) ({ text, resultText, usage, rateLimit, background })
 * @param {function} [handlers.onProgress] - !status 용 진행 상태 (activities, usage, rateLimit)
 * @param {function} [handlers.onAskUser] - AskUserQuestion 릴레이 (questions, signal) => Promise<answers>
 * @param {function} [handlers.onSessionReady] - 새 세션 ID 확정 (sessionId)
 * @returns {Promise<{usage: object|null, rateLimit: object|null, backgroundKill: {ceilingMs: number, tasks: string[]}|null}>}
 *   backgroundKill 은 백그라운드 작업이 대기 한도로 강제 종료됐을 때만 채워진다
 */
export async function runClaudeCode(sessionKey, prompt, workdir, handlers = {}) {
  const {
    onTurnStart, onText, onToolUse, onToolResult, onSubagentProgress, onBackgroundTasks, onTurnEnd,
    onProgress, onAskUser, onSessionReady, model: modelOverride, effort: effortOverride,
  } = handlers;
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
    effort: effortOverride || DEFAULT_EFFORT,
    cwd: workdir || undefined,
    additionalDirectories: allowedDirs ? allowedDirs.split(',').map(d => d.trim()) : undefined,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    env: cleanEnv,
    stderr,
    // 서브에이전트가 무엇을 하는지 ~30초마다 한 줄 요약 (task_progress.summary) — 진행 표시용
    agentProgressSummaries: true,
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
        const answers = await onAskUser(input.questions, abortController.signal);
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

  // 턴 상태 — 첫 턴은 프롬프트를 넣는 순간 시작된 것으로 본다
  let inTurn = true;
  let inputClosed = false;
  let sentSinceResult = false; // 마지막 result 이후 넣은 메시지 — 곧 턴이 열리므로 입력을 닫지 않는다
  let closeTimer = null;
  let ceilingTimer = null;
  let backgroundKill = null;
  const currentState = () => (inTurn ? 'turn' : inputClosed ? 'closing' : 'idle');

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

  liveQueries.set(sessionKey, {
    abort: () => {
      abortController.abort(); // onAskUser의 signal을 fire하여 pending 질문 reject
      closeInput();
      try { q.close(); } catch { /* 이미 종료됨 */ } // SDK subprocess 종료
    },
    send: (text) => {
      if (currentState() !== 'idle') return false;
      clearTimers();
      sentSinceResult = true;
      return input.push(text);
    },
    state: currentState,
  });

  let lastUsage = null;
  let resultUsage = null;
  let contextWindow = 1000000;
  let lastRateLimit = null;
  let initHandled = false;
  let turnText = '';
  const activities = [];

  // 백그라운드 작업 — 한 번이라도 백그라운드 목록에 오른 작업 (task_id → 정보). 현황 카드는 끝난 작업도 함께 보여준다
  const tasks = new Map();
  const taskToolUse = new Map(); // task_id → 이 작업을 띄운 tool_use_id (서브에이전트 진행을 카드에 연결)
  let notifiedSinceResult = [];
  const liveTasks = () => [...tasks.values()].filter(t => t.status === 'running');
  const emitBackground = () => onBackgroundTasks?.([...tasks.values()].map(t => ({ ...t })));

  const reportProgress = () => onProgress?.(activities, lastUsage, lastRateLimit);
  const pushActivity = (marker) => {
    activities.push(marker);
    if (activities.length > MAX_ACTIVITIES) activities.shift();
  };

  const startTurn = () => {
    inTurn = true;
    sentSinceResult = false;
    clearTimers();
    const notifications = notifiedSinceResult;
    notifiedSinceResult = [];
    onTurnStart?.({ notifications });
  };

  // 턴 사이: 남은 백그라운드 작업이 없으면 입력을 닫고, 있으면 대기 한도 타이머를 건다
  const stopAtCeiling = async () => {
    ceilingTimer = null;
    if (currentState() !== 'idle') return;
    const remaining = liveTasks();
    backgroundKill = { ceilingMs, tasks: remaining.map(t => t.description) };
    console.log(`[Claude] Background wait ceiling (${ceilingMs}ms) reached for ${sessionKey}: stopping ${remaining.length} task(s)`);
    for (const t of remaining) {
      await q.stopTask(t.id).catch(err => console.warn(`[Claude] stopTask ${t.id} failed: ${err.message}`));
    }
    closeInput();
  };
  const scheduleIdleCheck = () => {
    if (currentState() !== 'idle' || sentSinceResult) return;
    if (liveTasks().length === 0) {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (currentState() === 'idle' && !sentSinceResult && liveTasks().length === 0) closeInput();
      }, notifiedSinceResult.length ? NOTIFIED_CLOSE_GRACE_MS : CLOSE_GRACE_MS);
    } else if (ceilingMs > 0 && !ceilingTimer) {
      ceilingTimer = setTimeout(stopAtCeiling, ceilingMs);
    }
  };

  try {
    for await (const msg of q) {
      if (msg.type === 'system') {
        // init 이벤트 — 턴마다 다시 온다. 세션 처리는 처음 한 번만
        if (msg.subtype === 'init') {
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
          if (!inTurn) startTurn();
        }

        if (msg.subtype === 'task_started' && msg.tool_use_id) {
          taskToolUse.set(msg.task_id, msg.tool_use_id);
        }

        // background_tasks_changed 는 살아있는 작업 전체를 보낸다 (REPLACE). 빠진 작업은 곧 task_notification 으로 결과가 온다
        if (msg.subtype === 'background_tasks_changed') {
          const live = new Set();
          for (const t of msg.tasks) {
            if (t.ambient) continue;
            live.add(t.task_id);
            const cur = tasks.get(t.task_id);
            if (cur) {
              Object.assign(cur, { type: t.task_type, description: t.description, status: 'running', endedAt: null });
            } else {
              tasks.set(t.task_id, { id: t.task_id, type: t.task_type, description: t.description, status: 'running', startedAt: Date.now() });
            }
          }
          for (const t of tasks.values()) {
            if (t.status === 'running' && !live.has(t.id)) Object.assign(t, { status: 'completed', endedAt: Date.now() });
          }
          emitBackground();
          scheduleIdleCheck();
        }

        if (msg.subtype === 'task_progress') {
          const info = {};
          if (msg.last_tool_name) info.lastTool = msg.last_tool_name;
          if (msg.usage?.tool_uses) info.toolUses = msg.usage.tool_uses;
          if (msg.summary) info.summary = msg.summary;
          const t = tasks.get(msg.task_id);
          if (t) {
            Object.assign(t, info);
            emitBackground();
          }
          const toolUseId = msg.tool_use_id || taskToolUse.get(msg.task_id);
          if (toolUseId) onSubagentProgress?.({ toolUseId, ...info });
        }

        // 서브에이전트 안에서 돈 작업도 같이 알림이 오므로, 백그라운드 목록에 올랐던 작업만 반영한다.
        // 턴 사이에 온 알림은 다음 턴을 여는 계기라 다음 턴 머리말로 넘긴다 (턴 도중 알림은 그 턴 안에서 처리된다)
        if (msg.subtype === 'task_notification') {
          const t = tasks.get(msg.task_id);
          if (t) {
            Object.assign(t, { status: msg.status, endedAt: t.endedAt || Date.now() });
            if (!inTurn) notifiedSinceResult.push({ description: t.description, status: msg.status });
            emitBackground();
            scheduleIdleCheck();
          }
        }
      }

      // assistant 메시지 — 텍스트·도구 호출. 서브에이전트 메시지(parent_tool_use_id)는 진행 표시에만 쓴다
      if (msg.type === 'assistant' && msg.message?.content) {
        const fromSubagent = !!msg.parent_tool_use_id;
        if (!fromSubagent && !inTurn) startTurn();
        if (msg.message.usage && !fromSubagent) {
          const u = msg.message.usage;
          lastUsage = {
            inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
            outputTokens: u.output_tokens || 0,
            contextWindow,
          };
        }
        for (const block of msg.message.content) {
          if (block.type === 'text' && !fromSubagent) {
            turnText += block.text;
            onText?.(block.text);
          } else if (block.type === 'tool_use') {
            const { emoji, label } = describeTool(block.name || 'unknown', block.input || {});
            pushActivity(`${fromSubagent ? '↳ ' : ''}${emoji} ${truncate(label, 60)}`);
            if (!fromSubagent) {
              onToolUse?.({ id: block.id, name: block.name || 'unknown', input: block.input || {}, messageId: msg.message.id });
            }
          }
        }
        reportProgress();
      }

      // 메인 스레드 도구 결과
      if (msg.type === 'user' && !msg.parent_tool_use_id && !msg.isReplay && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            onToolResult?.({ id: block.tool_use_id, isError: !!block.is_error, text: toolResultText(block.content) });
          }
        }
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

      // result 이벤트 — 턴 종료. 백그라운드 작업이 남아 있으면 query 는 계속 열려 있다
      if (msg.type === 'result') {
        if (msg.subtype !== 'success') {
          // error result
          const errMsg = msg.error || msg.subtype || 'Unknown error';
          if (isResume && msg.subtype === 'error_during_execution') {
            clearSession(sessionKey);
            console.log(`[Claude] Resume failed for session ${sessionId}, cleared. Error: ${errMsg}`);
            throw new Error(`세션 resume 실패 (${sessionId}): ${errMsg}\n새 세션으로 다시 시도해주세요.`);
          }
          throw new Error(errMsg);
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
        inTurn = false;
        const text = turnText;
        turnText = '';
        await onTurnEnd?.({
          text,
          resultText: msg.result || '',
          usage: resultUsage || lastUsage,
          rateLimit: lastRateLimit,
          background: [...tasks.values()].map(t => ({ ...t })),
        });
        scheduleIdleCheck();
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
    liveQueries.delete(sessionKey);
  }

  if (backgroundKill) {
    console.log(`[Claude] Background tasks killed at wait ceiling for ${sessionKey}: ${backgroundKill.tasks.join(', ') || '(unknown)'}`);
  }
  return { usage: resultUsage || lastUsage, rateLimit: lastRateLimit, backgroundKill };
}
