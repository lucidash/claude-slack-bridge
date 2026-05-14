// Claude TUI 를 node-pty 로 spawn 해서 인터랙티브 모드로 운영하는 엔진.
//
// SDK `query()` 와 인터페이스 동일:
//   runClaudeViaPty(sessionKey, prompt, workdir, { onProgress, onSessionReady, model, effort })
//     → { result, usage, rateLimit }
//
// 동작 요약:
//   1. claude binary 를 pty 로 spawn (`--dangerously-skip-permissions` + 선택 옵션)
//   2. xterm-headless 로 spawn 직후 화면만 추적 (security guide, INSERT 모드 진입)
//   3. "/" 키 입력 → backspace 로 cancel → session 활성화 trigger (turn 안 씀)
//   4. ~/.claude/sessions/<pid>.json polling 으로 sessionId 발견
//   5. 실제 prompt 송신
//   6. ~/.claude/projects/<encoded-cwd>/<sid>.jsonl 파일을 tail
//      - assistant.message.content 누적 → result
//      - assistant.message.usage → usage
//      - assistant.stop_reason === 'end_turn' → 응답 완료
//      - tool_use / thinking → onProgress 활동 알림

import { spawn as ptySpawn } from 'node-pty';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import xtermPkg from '@xterm/headless';
import { getSession, saveSession } from './store.js';

const { Terminal } = xtermPkg;

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/muzi/.local/bin/claude';
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// 실행 중인 pty (세션별)
const runningPtys = new Map(); // sessionKey → { pty, abort }

export function stopClaudePtyQuery(sessionKey) {
  const entry = runningPtys.get(sessionKey);
  if (!entry) return false;
  entry.abort();
  return true;
}

function encodeCwd(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

function readSessionMeta(pid) {
  const file = join(SESSIONS_DIR, `${pid}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 100, label, signal }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error(`aborted: ${label}`);
    const v = predicate();
    if (v) return v;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout: ${label}`);
}

function bufferText(term) {
  const lines = [];
  const buf = term.buffer.active;
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n');
}

function extractText(msg) {
  if (!msg?.content) return '';
  return msg.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n')
    .trim();
}

function summarizeToolUse(c) {
  if (c.type !== 'tool_use') return null;
  const name = c.name || 'tool';
  const input = c.input || {};
  // 흔한 도구 입력의 한 줄 요약
  if (input.command) return `${name}(${truncate(input.command, 60)})`;
  if (input.file_path) return `${name}(${input.file_path})`;
  if (input.path) return `${name}(${input.path})`;
  if (input.pattern) return `${name}(${truncate(input.pattern, 50)})`;
  if (input.url) return `${name}(${input.url})`;
  return name;
}

function truncate(s, len) {
  if (!s) return s;
  return s.length > len ? s.slice(0, len) + '…' : s;
}

/**
 * @param {string} sessionKey - 스레드별 세션 키
 * @param {string} prompt - 사용자 프롬프트
 * @param {string|null} workdir - 작업 디렉토리
 * @param {object} callbacks
 *   - onProgress(activities, usage, rateLimit)
 *   - onSessionReady(sid)
 *   - model, effort
 * @returns {Promise<{result: string, usage: object|null, rateLimit: object|null}>}
 */
export async function runClaudeViaPty(sessionKey, prompt, workdir, callbacks = {}) {
  const { onProgress, onSessionReady, model: modelOverride, effort: effortOverride } = callbacks;

  const existingSid = getSession(sessionKey);
  const args = ['--dangerously-skip-permissions'];
  if (existingSid) args.unshift('--resume', existingSid);
  if (modelOverride) args.push('--model', modelOverride);
  if (effortOverride) args.push('--effort', effortOverride);

  const env = { ...process.env, TERM: 'xterm-256color' };
  // bridge 의 인증과 분리하고 싶을 때 사용자가 CLAUDE_PTY_HOME 으로 별도 home 지정 가능
  if (process.env.CLAUDE_PTY_HOME) env.HOME = process.env.CLAUDE_PTY_HOME;

  const pty = ptySpawn(CLAUDE_BIN, args, {
    name: 'xterm-256color',
    cols: 120, rows: 40,
    cwd: workdir || env.HOME,
    env,
  });

  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  pty.onData((data) => { term.write(data); });

  const abortController = new AbortController();
  const signal = abortController.signal;
  runningPtys.set(sessionKey, {
    pty,
    abort: () => {
      abortController.abort();
      try { if (!pty.killed) pty.kill(); } catch { /* ignore */ }
    },
  });

  const activities = [];
  let lastUsage = null;
  let lastAssistantMsg = null;
  let sessionReadyEmitted = !!existingSid;

  function pushActivity(s) {
    activities.push(s);
    if (activities.length > 50) activities.shift();
    if (onProgress) onProgress([...activities], lastUsage, null);
  }

  try {
    // 1) security guide pass (resume 시에는 안 뜸)
    try {
      await waitFor(() => bufferText(term).includes('trust this folder'),
        { timeoutMs: 4000, label: 'security guide', signal });
      pty.write('\r');
    } catch { /* 없으면 무시 */ }

    // 2) INSERT 모드 진입 대기
    await waitFor(() => bufferText(term).includes('-- INSERT --'),
      { timeoutMs: 8000, label: 'INSERT mode', signal });
    await new Promise(r => setTimeout(r, 300));

    // 3) 새 세션이면 "/" + backspace 로 session 활성화 trigger
    if (!existingSid) {
      pty.write('/');
      await new Promise(r => setTimeout(r, 200));
      pty.write('\x7f'); // backspace
      await new Promise(r => setTimeout(r, 200));
    }

    // 4) sessions/<pid>.json polling → sessionId 발견
    const meta = await waitFor(() => readSessionMeta(pty.pid),
      { timeoutMs: 8000, label: 'session meta', signal });
    const sid = meta.sessionId;

    if (!existingSid) {
      saveSession(sessionKey, sid);
      if (onSessionReady && !sessionReadyEmitted) {
        onSessionReady(sid);
        sessionReadyEmitted = true;
      }
    }

    // 5) jsonl tail 시작점 기록
    const jsonlPath = join(PROJECTS_DIR, encodeCwd(meta.cwd), `${sid}.jsonl`);
    let offset = existsSync(jsonlPath) ? statSync(jsonlPath).size : 0;

    // 6) prompt 송신
    pty.write(prompt + '\r');
    pushActivity('💬 prompt sent');

    // 7) jsonl tail → end_turn 까지
    const result = await tailUntilEndTurn({
      jsonlPath, getOffset: () => offset, setOffset: (o) => { offset = o; },
      pid: pty.pid, signal, onAssistantChunk: (msg) => {
        if (msg.usage) {
          lastUsage = normalizeUsage(msg.usage);
          if (onProgress) onProgress([...activities], lastUsage, null);
        }
        for (const c of msg.content || []) {
          if (c.type === 'tool_use') {
            const sum = summarizeToolUse(c);
            if (sum) pushActivity(`🔧 ${sum}`);
          }
        }
      },
      onThinking: () => pushActivity('🧠 thinking'),
      onToolResult: () => pushActivity('📥 tool result'),
    });

    return { result: result.text, usage: result.usage || lastUsage, rateLimit: null };

  } finally {
    try { pty.kill(); } catch { /* ignore */ }
    runningPtys.delete(sessionKey);
  }
}

function normalizeUsage(u) {
  if (!u) return null;
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return {
    inputTokens: input,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheCreationTokens: u.cache_creation_input_tokens || 0,
    contextWindow: 0, // pty 에서는 모름 (SDK 처럼 명시 노출 안 됨)
  };
}

async function tailUntilEndTurn({ jsonlPath, getOffset, setOffset, pid, signal, onAssistantChunk, onThinking, onToolResult, timeoutMs = 30 * 60 * 1000 }) {
  const start = Date.now();
  let lastAssistant = null;
  let lastUsage = null;

  while (Date.now() - start < timeoutMs) {
    if (signal.aborted) throw new Error('aborted');
    await new Promise(r => setTimeout(r, 200));

    if (!existsSync(jsonlPath)) continue;
    const stat = statSync(jsonlPath);
    const offset = getOffset();
    if (stat.size <= offset) continue;

    const fd = openSync(jsonlPath, 'r');
    let chunk;
    try {
      chunk = Buffer.alloc(stat.size - offset);
      readSync(fd, chunk, 0, chunk.length, offset);
      setOffset(stat.size);
    } finally {
      closeSync(fd);
    }

    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }

      if (j.type === 'assistant' && j.message) {
        lastAssistant = j.message;
        if (j.message.usage) lastUsage = j.message.usage;
        if (onAssistantChunk) onAssistantChunk(j.message);
        if (j.message.stop_reason === 'end_turn') {
          return { text: extractText(j.message), usage: lastUsage ? normalizeUsage(lastUsage) : null };
        }
      } else if (j.type === 'thinking' && onThinking) {
        onThinking();
      } else if (j.type === 'tool_result' && onToolResult) {
        onToolResult();
      }
    }
  }

  return {
    text: lastAssistant ? extractText(lastAssistant) : '(timeout — no end_turn)',
    usage: lastUsage ? normalizeUsage(lastUsage) : null,
  };
}
