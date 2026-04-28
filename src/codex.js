import { spawn } from 'child_process';
import readline from 'readline';
import { getSession, saveSession, clearSession } from './store.js';
import { randomUUID } from 'crypto';

// 실행 중인 Codex 프로세스 추적 (세션별)
const runningQueries = new Map();

/**
 * 실행 중인 Codex query를 중단
 */
export function stopCodexQuery(sessionKey) {
  const entry = runningQueries.get(sessionKey);
  if (entry) {
    entry.abort();
    return true;
  }
  return false;
}

const ITEM_EMOJI = {
  command_execution: '💻',
  file_change: '✏️',
  web_search: '🔎',
  mcp_tool_call: '⚙️',
  reasoning: '🧠',
  todo_list: '📋',
  error: '❌',
  agent_message: '💬',
};

function truncate(s, len = 50) {
  return s && s.length > len ? s.substring(0, len) + '…' : s;
}

function extractItemDetail(item) {
  try {
    switch (item.type) {
      case 'command_execution':
        return truncate(item.command, 60);
      case 'file_change':
        return item.changes?.map(c => `${c.kind} ${c.path.replace(/^.*\//, '')}`).join(', ');
      case 'web_search':
        return truncate(item.query, 50);
      case 'mcp_tool_call':
        return truncate(`${item.server}/${item.tool}`, 50);
      case 'reasoning':
        return truncate(item.text, 40);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Codex CLI 바이너리 경로 결정
 */
function getCodexPath() {
  return process.env.CODEX_PATH || 'codex';
}

/**
 * Codex를 실행하고 스트리밍 결과를 반환
 * runClaudeCode()와 동일한 인터페이스
 *
 * @param {string} sessionKey - 스레드 기반 세션 키
 * @param {string} prompt - 사용자 프롬프트
 * @param {string|null} workdir - 작업 디렉토리
 * @param {object} callbacks - 콜백 함수들
 * @returns {Promise<{result: string, usage: object|null, rateLimit: null}>}
 */
export async function runCodex(sessionKey, prompt, workdir, { onProgress, onSessionReady, model: modelOverride, effort: effortOverride } = {}) {
  let threadId = getSession(sessionKey);
  const isResume = !!threadId;

  const model = modelOverride || process.env.CODEX_MODEL || 'o3';
  const codexPath = getCodexPath();

  // CLI args 구성
  const args = ['exec', '--experimental-json'];

  // 모델
  args.push('--model', model);

  // YOLO 모드: 모든 승인 스킵 + 샌드박스 해제
  args.push('--sandbox', 'danger-full-access');
  args.push('--config', 'approval_policy="never"');

  // 작업 디렉토리
  if (workdir) {
    args.push('--cd', workdir);
  }

  // reasoning effort
  if (effortOverride) {
    const effortMap = { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };
    const codexEffort = effortMap[effortOverride] || effortOverride;
    args.push('--config', `model_reasoning_effort="${codexEffort}"`);
  }

  // 추가 디렉토리
  const allowedDirs = process.env.CODEX_ALLOWED_DIRS || process.env.CLAUDE_ALLOWED_DIRS || '';
  if (allowedDirs) {
    for (const dir of allowedDirs.split(',').map(d => d.trim()).filter(Boolean)) {
      args.push('--add-dir', dir);
    }
  }

  // git repo 체크 스킵
  args.push('--skip-git-repo-check');

  // 세션 재개
  if (isResume) {
    args.push('resume', threadId);
    console.log(`[Codex] Resuming thread ${threadId} for ${sessionKey}`);
  } else {
    console.log(`[Codex] New thread for ${sessionKey}`);
  }

  // 프로세스 spawn
  const abortController = new AbortController();
  const child = spawn(codexPath, args, {
    env: { ...process.env },
    signal: abortController.signal,
  });

  let spawnError = null;
  child.once('error', (err) => { spawnError = err; });

  // stdin에 프롬프트 전송
  child.stdin.write(prompt);
  child.stdin.end();

  const stderrChunks = [];
  if (child.stderr) {
    child.stderr.on('data', (data) => stderrChunks.push(data));
  }

  // abort 래퍼 저장
  runningQueries.set(sessionKey, {
    abort: () => {
      abortController.abort();
      try { if (!child.killed) child.kill(); } catch { /* ignore */ }
    },
  });

  let finalResult = '';
  const activities = [];
  let lastUsage = null;

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // malformed line 스킵
      }

      // thread.started → 세션(스레드) ID 저장
      if (event.type === 'thread.started') {
        threadId = event.thread_id;
        if (!isResume) {
          saveSession(sessionKey, threadId);
          console.log(`[Codex] Thread started: ${threadId}`);
          if (onSessionReady) onSessionReady(threadId);
        }
      }

      // item.started / item.updated → 진행 상태 추적
      if (event.type === 'item.started' || event.type === 'item.updated') {
        const item = event.item;
        if (item && item.type !== 'agent_message') {
          const emoji = ITEM_EMOJI[item.type] || '⚙️';
          const detail = extractItemDetail(item);
          const marker = detail ? `${emoji} ${item.type}: ${detail}` : `${emoji} ${item.type}`;
          // 중복 방지: 같은 id의 마커가 이미 있으면 업데이트
          const existingIdx = activities.findIndex(a => a.startsWith(`${emoji} ${item.type}:`) && a === marker);
          if (existingIdx === -1) {
            activities.push(marker);
          }
          if (onProgress) onProgress(activities, lastUsage, null);
        }
      }

      // item.completed → 텍스트 수집 + 도구 마커
      if (event.type === 'item.completed') {
        const item = event.item;
        if (item.type === 'agent_message') {
          finalResult += (finalResult ? '\n' : '') + item.text;
        } else {
          const emoji = ITEM_EMOJI[item.type] || '⚙️';
          const detail = extractItemDetail(item);
          const marker = detail ? `${emoji} ${item.type}: ${detail}` : `${emoji} ${item.type}`;
          finalResult += `\n${marker}\n`;
        }
      }

      // turn.completed → usage 정보
      if (event.type === 'turn.completed') {
        if (event.usage) {
          lastUsage = {
            inputTokens: (event.usage.input_tokens || 0) + (event.usage.cached_input_tokens || 0),
            outputTokens: event.usage.output_tokens || 0,
            contextWindow: 0, // Codex는 context window 정보 미제공
          };
          console.log(`[Codex] Usage: in=${lastUsage.inputTokens} out=${lastUsage.outputTokens}`);
        }
        if (onProgress) onProgress(activities, lastUsage, null);
      }

      // turn.failed → 에러
      if (event.type === 'turn.failed') {
        const errMsg = event.error?.message || 'Turn failed';
        if (isResume) {
          clearSession(sessionKey);
          console.log(`[Codex] Resume failed for thread ${threadId}, cleared. Error: ${errMsg}`);
          throw new Error(`세션 resume 실패 (${threadId}): ${errMsg}\n새 세션으로 다시 시도해주세요.`);
        }
        throw new Error(errMsg);
      }

      // error event → 치명적 에러
      if (event.type === 'error') {
        throw new Error(event.message || 'Codex stream error');
      }
    }

    if (spawnError) {
      if (spawnError.code === 'ENOENT') {
        throw new Error(`Codex CLI를 찾을 수 없습니다 (\`${codexPath}\`).\n설치: https://github.com/openai/codex\n또는 \`CODEX_PATH\` 환경변수로 바이너리 경로를 지정하세요.`);
      }
      throw spawnError;
    }
    const { code, signal } = await exitPromise;
    if (code !== 0 || signal) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      // resume 실패 시 세션 정리
      if (isResume) {
        clearSession(sessionKey);
        throw new Error(`세션 resume 실패 (${threadId}): Codex exited with ${detail}\n새 세션으로 다시 시도해주세요.`);
      }
      throw new Error(`Codex exited with ${detail}: ${stderr.substring(0, 200)}`);
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      throw new Error('중단됨 (사용자 요청)');
    }
    throw err;
  } finally {
    rl.close();
    child.removeAllListeners();
    try { if (!child.killed) child.kill(); } catch { /* ignore */ }
    runningQueries.delete(sessionKey);
  }

  return { result: finalResult.trim(), usage: lastUsage, rateLimit: null };
}
