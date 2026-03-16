import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { getSession, saveSession, clearSession } from './store.js';

// 실행 중인 SDK query 객체 추적 (세션별)
const runningQueries = new Map();

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

const TOOL_EMOJI = {
  Read: '📖', Edit: '✏️', Write: '📝', Bash: '💻',
  Grep: '🔍', Glob: '📁', WebFetch: '🌐', WebSearch: '🔎',
  Task: '🤖', default: '⚙️',
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
      case 'Task':
        return truncate(input.description, 40);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Claude Code를 Agent SDK로 실행하고 스트리밍 결과를 반환
 * @param {string} sessionKey - 스레드 기반 세션 키
 * @param {string} prompt - 사용자 프롬프트
 * @param {string|null} workdir - 작업 디렉토리
 * @param {object} callbacks - 콜백 함수들
 * @param {function|null} callbacks.onProgress - 진행상황 콜백 (activities, usage)
 * @param {function|null} callbacks.onAskUser - AskUserQuestion 릴레이 콜백 (questions) => Promise<answers>
 * @returns {Promise<{result: string, usage: object|null}>} 최종 응답 텍스트와 usage 정보
 */
export async function runClaudeCode(sessionKey, prompt, workdir, { onProgress, onAskUser, onSessionReady } = {}) {
  let sessionId = getSession(sessionKey);
  const isResume = !!sessionId;

  const allowedDirs = process.env.CLAUDE_ALLOWED_DIRS || '';
  const skipPermissions = process.env.CLAUDE_SKIP_PERMISSIONS === 'true';
  const model = process.env.CLAUDE_MODEL || 'sonnet';

  // SDK options 구성
  // systemPrompt: preset을 사용해야 CLI가 ~/.claude/settings.json (language, skills 등)을 정상 로드함
  // systemPrompt를 생략하면 SDK가 빈 문자열("")을 전달하여 기본 시스템 프롬프트가 무시됨
  // CLAUDECODE 환경변수 제거 (nested session 방지)
  const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...cleanEnv } = process.env;

  const options = {
    model,
    cwd: workdir || undefined,
    additionalDirectories: allowedDirs ? allowedDirs.split(',').map(d => d.trim()) : undefined,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    env: cleanEnv,
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

  const q = query({
    prompt,
    options: {
      ...options,
      canUseTool,
    },
  });

  // abort + close 래퍼 저장
  runningQueries.set(sessionKey, {
    abort: () => {
      abortController.abort(); // onAskUser의 signal을 fire하여 pending 질문 reject
      q.close().catch(() => {}); // SDK subprocess 종료
    },
  });

  let finalResult = '';
  const activities = [];
  let lastUsage = null;
  let resultUsage = null;
  let contextWindow = 1000000;

  try {
    for await (const msg of q) {
      // init 이벤트
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (msg.session_id && !isResume) {
          if (msg.session_id !== sessionId) {
            sessionId = msg.session_id;
            saveSession(sessionKey, sessionId);
          }
          if (onSessionReady) onSessionReady(sessionId);
        }
      }

      // assistant 메시지 — 도구 사용 추적 + 텍스트 수집
      if (msg.type === 'assistant' && msg.message?.content) {
        if (msg.message.usage) {
          const u = msg.message.usage;
          lastUsage = {
            inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
            outputTokens: u.output_tokens || 0,
            contextWindow,
          };
        }
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            finalResult += block.text;
          } else if (block.type === 'tool_use') {
            const toolName = block.name || 'unknown';
            const emoji = TOOL_EMOJI[toolName] || TOOL_EMOJI.default;
            const detail = extractToolDetail(toolName, block.input || {});
            const marker = detail ? `${emoji} ${toolName}: ${detail}` : `${emoji} ${toolName}`;
            activities.push(marker);
            // 도구 사용 마커를 출력에 포함 (raw 출력)
            finalResult += `\n${marker}\n`;
          }
        }
        if (lastUsage) {
          console.log(`[Claude] Usage: ${lastUsage.inputTokens} / ${lastUsage.contextWindow} tokens`);
        }
        if (onProgress) onProgress(activities, lastUsage);
      }

      // result 이벤트 — 최종 결과
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
    runningQueries.delete(sessionKey);
  }

  const usage = resultUsage || lastUsage;
  return { result: finalResult.trim(), usage };
}
