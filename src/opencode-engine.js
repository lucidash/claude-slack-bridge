// opencode CLI 를 plain child process 로 spawn 해서 운영하는 엔진.
//
// claude SDK / pty-claude 와 인터페이스 동일:
//   runOpencode(sessionKey, prompt, workdir, { onProgress, onSessionReady, model, effort })
//     → { result, usage, rateLimit }
//
// 동작 요약:
//   1. `opencode run --format json` 을 spawn (node-pty 불필요 — 순수 stdin/stdout JSON lines)
//      - prompt 는 stdin 으로 전달 (멀티라인/긴 프롬프트 안전, ARG_MAX 회피)
//   2. stdout JSON events 파싱
//      - 모든 이벤트의 sessionID → 세션 발견/저장 (새 세션이면 onSessionReady)
//      - type:text part → result 누적
//      - part.type === 'tool' → onProgress 활동 마커
//      - type:step_finish part.tokens → usage
//   3. resume: `-s <sessionID>`
//
// 제약 (pty-claude 와 동급):
//   - AskUserQuestion 릴레이 미지원 (onAskUser 미사용 — permission 은 opencode 설정을 따름)
//   - rate-limit 이벤트 없음 → rateLimit 항상 null
//
// 모델: `!model` 로 지정할 때는 opencode 형식(`provider/model`, 예: `openai/gpt-5.1`) 사용.
// claude 스타일 별칭(sonnet 등)은 opencode 에서 인식하지 못하므로 이 엔진에서는 무시.

import { spawn } from 'child_process';
import readline from 'readline';
import { getSession, saveSession, clearSession } from './store.js';

const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';
const TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS || 30 * 60 * 1000);

// 실행 중인 프로세스 추적 (세션별) — !stop 대응
const runningProcs = new Map(); // sessionKey → { proc, abort }

export function stopOpencodeQuery(sessionKey) {
  const entry = runningProcs.get(sessionKey);
  if (!entry) return false;
  entry.abort();
  return true;
}

function truncate(s, len = 60) {
  return s && s.length > len ? s.slice(0, len) + '…' : s;
}

function summarizeTool(part) {
  const name = part.tool || 'tool';
  const title = part.state?.title || '';
  return title ? `${name}: ${truncate(title)}` : name;
}

function normalizeUsage(t) {
  if (!t) return null;
  const cache = t.cache || {};
  return {
    inputTokens: (t.input || 0) + (cache.read || 0) + (cache.write || 0),
    outputTokens: (t.output || 0) + (t.reasoning || 0),
    contextWindow: 0, // opencode 는 컨텍스트 윈도우를 명시 노출하지 않음
  };
}

/**
 * @param {string} sessionKey - 스레드별 세션 키 (claude 와 세션 ID 체계가 다르므로 같은 store 를 공유하되 스레드당 하나의 엔진만 사용)
 * @param {string} prompt - 사용자 프롬프트
 * @param {string|null} workdir - 작업 디렉토리
 * @param {object} callbacks
 *   - onProgress(activities, usage, rateLimit)
 *   - onSessionReady(sid)
 *   - model: provider/model 형식 그대로 `-m` 전달
 *   - effort: `--variant` 로 전달 (high/max/minimal 등)
 * @returns {Promise<{result: string, usage: object|null, rateLimit: object|null}>}
 */
export async function runOpencode(sessionKey, prompt, workdir, callbacks = {}) {
  const { onProgress, onSessionReady, model: modelOverride, effort: effortOverride } = callbacks;

  let existingSid = getSession(sessionKey);
  const isResume = !!existingSid;

  const args = ['run', '--format', 'json'];
  if (existingSid) args.push('-s', existingSid);
  if (modelOverride) args.push('-m', modelOverride);
  if (effortOverride) args.push('--variant', effortOverride);
  if (process.env.OPENCODE_AUTO === 'true') args.push('--auto');

  console.log(`[opencode:${sessionKey}] spawn ${OPENCODE_BIN} ${args.join(' ')}`);
  const proc = spawn(OPENCODE_BIN, args, {
    cwd: workdir || process.env.HOME,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let aborted = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.log(`[opencode:${sessionKey}] timeout (${TIMEOUT_MS}ms), killing process`);
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  }, TIMEOUT_MS);
  timeout.unref();

  runningProcs.set(sessionKey, {
    proc,
    abort: () => {
      aborted = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 3000).unref();
    },
  });

  const activities = [];
  const toolMarkers = new Map(); // tool part id → 마커 문자열
  const texts = [];
  let lastUsage = null;
  let sid = existingSid || null;
  let sessionReadyEmitted = false;
  let errorMessage = null;

  function pushProgress() {
    activities.length = 0;
    activities.push(...toolMarkers.values());
    if (activities.length > 50) activities.splice(0, activities.length - 50);
    if (onProgress) onProgress([...activities], lastUsage, null);
  }

  proc.stdin.end(prompt, 'utf8');

  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let j;
    try { j = JSON.parse(line); } catch { return; }

    // 모든 이벤트에 sessionID 가 실려 있음 — 새 세션이면 저장
    if (j.sessionID && !sid) {
      sid = j.sessionID;
      if (!isResume) {
        saveSession(sessionKey, sid);
        console.log(`[opencode:${sessionKey}] new session ${sid}`);
        if (onSessionReady && !sessionReadyEmitted) {
          onSessionReady(sid);
          sessionReadyEmitted = true;
        }
      }
    }

    const p = j.part || {};

    if (j.type === 'text' && typeof p.text === 'string') {
      texts.push(p.text);
    }

    if (p.type === 'tool') {
      const id = p.id || p.callID || `${p.tool}:${p.messageID}`;
      toolMarkers.set(id, `🔧 ${summarizeTool(p)}`);
      pushProgress();
    }

    if (j.type === 'step_finish' && p.tokens) {
      lastUsage = normalizeUsage(p.tokens);
      pushProgress();
    }

    if (j.type === 'error') {
      errorMessage = p.message || p.error?.message || JSON.stringify(p).slice(0, 300);
    }
  });

  const exitCode = await new Promise((resolve) => {
    proc.on('close', (code) => resolve(code));
    proc.on('error', (err) => {
      console.error(`[opencode:${sessionKey}] spawn error: ${err.message}`);
      resolve(-1);
    });
  });

  runningProcs.delete(sessionKey);
  clearTimeout(timeout);

  if (aborted) {
    throw new Error('중단됨 (사용자 요청)');
  }

  if (timedOut) {
    throw new Error(`opencode 실행 시간 초과 (${Math.round(TIMEOUT_MS / 60000)}분)`);
  }

  if (exitCode !== 0) {
    const detail = errorMessage || stderrTail.trim().split('\n').pop() || `exit code ${exitCode}`;
    if (isResume && sid === existingSid) {
      clearSession(sessionKey);
      console.log(`[opencode:${sessionKey}] resume failed for ${existingSid}, cleared. ${detail}`);
      throw new Error(`세션 resume 실패 (${existingSid}): ${detail}\n새 세션으로 다시 시도해주세요.`);
    }
    throw new Error(`opencode 실행 실패: ${detail}`);
  }

  const result = texts.join('\n\n').trim();
  if (!result && errorMessage) {
    throw new Error(`opencode 실행 실패: ${errorMessage}`);
  }

  return { result: result || '(빈 응답)', usage: lastUsage, rateLimit: null };
}
