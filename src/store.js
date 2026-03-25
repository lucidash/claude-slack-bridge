import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BRIDGE_DIR = join(homedir(), '.claude', 'slack-bridge');
const SESSIONS_FILE = join(BRIDGE_DIR, 'sessions.json');
const THREADS_FILE = join(BRIDGE_DIR, 'threads.json');
const WORKDIRS_FILE = join(BRIDGE_DIR, 'workdirs.json');
const INBOX_FILE = join(BRIDGE_DIR, 'inbox.json');
const PAUSED_FILE = join(BRIDGE_DIR, 'paused.json');
const CRONS_FILE = join(BRIDGE_DIR, 'crons.json');
const SYNC_POINTS_FILE = join(BRIDGE_DIR, 'sync-points.json');
const WATCHES_FILE = join(BRIDGE_DIR, 'watches.json');
const PROCESSING_FILE = join(BRIDGE_DIR, 'processing.json');

// 디렉토리 및 파일 초기화
if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
for (const file of [SESSIONS_FILE, THREADS_FILE, WORKDIRS_FILE, PAUSED_FILE, WATCHES_FILE, PROCESSING_FILE]) {
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({}, null, 2));
}
if (!existsSync(CRONS_FILE)) {
  writeFileSync(CRONS_FILE, JSON.stringify([], null, 2));
}
if (!existsSync(SYNC_POINTS_FILE)) {
  writeFileSync(SYNC_POINTS_FILE, JSON.stringify({}, null, 2));
}
if (!existsSync(INBOX_FILE)) {
  writeFileSync(INBOX_FILE, JSON.stringify({ messages: [], lastChecked: null }, null, 2));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// 세션 관리 (스레드 단위)
export function getSession(sessionKey) {
  return readJson(SESSIONS_FILE)[sessionKey];
}

export function saveSession(sessionKey, sessionId) {
  const sessions = readJson(SESSIONS_FILE);
  sessions[sessionKey] = sessionId;
  writeJson(SESSIONS_FILE, sessions);
}

export function clearSession(sessionKey) {
  const sessions = readJson(SESSIONS_FILE);
  delete sessions[sessionKey];
  writeJson(SESSIONS_FILE, sessions);
}

export function getAllSessions() {
  return readJson(SESSIONS_FILE);
}

// 작업 디렉토리 관리 (사용자 단위)
export function getWorkdir(userId) {
  return readJson(WORKDIRS_FILE)[userId] || null;
}

export function saveWorkdir(userId, dir) {
  const workdirs = readJson(WORKDIRS_FILE);
  workdirs[userId] = dir;
  writeJson(WORKDIRS_FILE, workdirs);
}

// 스레드 관리
export function saveThread(threadKey, userId, workdir = null) {
  const threads = readJson(THREADS_FILE);
  const data = { userId, createdAt: new Date().toISOString() };
  if (workdir) data.workdir = workdir;
  threads[threadKey] = data;
  writeJson(THREADS_FILE, threads);
}

export function isActiveThread(threadKey) {
  return !!readJson(THREADS_FILE)[threadKey];
}

export function getThreadWorkdir(threadKey) {
  return readJson(THREADS_FILE)[threadKey]?.workdir || null;
}

export function getThread(threadKey) {
  return readJson(THREADS_FILE)[threadKey] || null;
}

export function setThreadSilent(threadKey, silent = true) {
  const threads = readJson(THREADS_FILE);
  if (threads[threadKey]) {
    threads[threadKey].silent = silent;
    writeJson(THREADS_FILE, threads);
  }
}

export function isThreadSilent(threadKey) {
  return readJson(THREADS_FILE)[threadKey]?.silent || false;
}

export function archiveThread(threadKey, splitTo) {
  const threads = readJson(THREADS_FILE);
  if (threads[threadKey]) {
    threads[threadKey].archived = true;
    threads[threadKey].splitTo = splitTo;
    writeJson(THREADS_FILE, threads);
  }
}

export function isArchivedThread(threadKey) {
  const thread = readJson(THREADS_FILE)[threadKey];
  return thread?.archived ? { splitTo: thread.splitTo } : null;
}

// STT 결과 저장 (인메모리, 스레드 단위)
const sttResults = new Map();

export function saveSttResult(threadKey, text) {
  sttResults.set(threadKey, text);
}

export function popSttResult(threadKey) {
  const text = sttResults.get(threadKey);
  if (text) sttResults.delete(threadKey);
  return text || null;
}

// 인박스
export function appendInbox(message) {
  const inbox = readJson(INBOX_FILE);
  inbox.messages.push(message);
  writeJson(INBOX_FILE, inbox);
}

export function getInbox() {
  return readJson(INBOX_FILE);
}

export function clearInbox() {
  writeJson(INBOX_FILE, { messages: [], lastChecked: null });
}

// 스레드 일시정지 (pause/resume)
export function pauseThread(threadKey, userId) {
  const paused = readJson(PAUSED_FILE);
  if (paused[threadKey]) return;
  paused[threadKey] = { userId, pausedAt: String(Date.now() / 1000), notified: false };
  writeJson(PAUSED_FILE, paused);
}

export function resumeThread(threadKey) {
  const paused = readJson(PAUSED_FILE);
  const info = paused[threadKey];
  delete paused[threadKey];
  writeJson(PAUSED_FILE, paused);
  return info;
}

export function getPausedThread(threadKey) {
  return readJson(PAUSED_FILE)[threadKey] || null;
}

export function markPauseNotified(threadKey) {
  const paused = readJson(PAUSED_FILE);
  if (paused[threadKey]) {
    paused[threadKey].notified = true;
    writeJson(PAUSED_FILE, paused);
  }
}

// 세션 ID로 원래 작업 디렉토리 찾기
// Claude CLI는 세션을 ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl 에 저장
// encoded-cwd 규칙: 경로의 '/'와 '.'을 '-'로 치환
export function findSessionWorkdir(sessionId) {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;

  // 세션 파일이 있는 프로젝트 디렉토리 찾기
  let encodedDir = null;
  try {
    const dirs = readdirSync(projectsDir);
    for (const dir of dirs) {
      if (existsSync(join(projectsDir, dir, `${sessionId}.jsonl`))) {
        encodedDir = dir;
        break;
      }
    }
  } catch { return null; }
  if (!encodedDir) return null;

  // 인코딩된 디렉토리명을 실제 경로로 디코딩
  // 각 레벨의 실제 디렉토리 목록과 대조하여 역추적
  const encoded = encodedDir.substring(1); // 선행 '-' 제거 ('/' 에 해당)

  function solve(rest, currentPath) {
    if (!rest) return currentPath;

    let entries;
    try {
      entries = readdirSync(currentPath).filter(e => {
        try { return statSync(join(currentPath, e)).isDirectory(); }
        catch { return false; }
      });
    } catch { return null; }

    for (const entry of entries) {
      // 디렉토리명을 Claude CLI 방식으로 인코딩하여 비교
      const enc = entry.replace(/[/.]/g, '-');

      if (rest === enc) {
        return join(currentPath, entry);
      }
      if (rest.startsWith(enc + '-')) {
        const result = solve(rest.substring(enc.length + 1), join(currentPath, entry));
        if (result) return result;
      }
    }
    return null;
  }

  return solve(encoded, '/');
}

// 세션별 PR URL 조회 (~/.claude/.pr-urls/{sessionId})
export function getSessionPrUrl(sessionId) {
  if (!sessionId) return null;
  const file = join(homedir(), '.claude', '.pr-urls', sessionId);
  try {
    return existsSync(file) ? readFileSync(file, 'utf-8').trim() : null;
  } catch { return null; }
}

// 세션 파일 읽기
export function findSessionFile(sessionId) {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;
  try {
    for (const dir of readdirSync(projectsDir)) {
      const file = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(file)) return file;
    }
  } catch { /* ignore */ }
  return null;
}

export function readSessionSummary(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return null;

  const content = readFileSync(file, 'utf-8');
  const lines = content.trim().split('\n');

  let cwd = null;
  const turns = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // cwd 추출 (첫 이벤트에서)
      if (!cwd && event.cwd) cwd = event.cwd;

      // 사용자 메시지
      if (event.type === 'user' && !event.isMeta) {
        const msg = event.message;
        if (!msg) continue;
        const text = typeof msg.content === 'string'
          ? msg.content
          : (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        if (text) turns.push({ role: 'user', text });
      }

      // 어시스턴트 메시지
      if (event.type === 'assistant') {
        const content = event.message?.content || [];
        const texts = content.filter(b => b.type === 'text').map(b => b.text).join('');
        const tools = content.filter(b => b.type === 'tool_use').map(b => b.name);
        if (texts || tools.length > 0) {
          turns.push({ role: 'assistant', text: texts, tools });
        }
      }
    } catch { /* skip malformed lines */ }
  }

  return { cwd, turns };
}

// Sync points — 브릿지가 마지막으로 세션을 사용한 시점 (turn index)
export function saveSyncPoint(sessionId, turnCount) {
  const points = readJson(SYNC_POINTS_FILE);
  points[sessionId] = turnCount;
  writeJson(SYNC_POINTS_FILE, points);
}

export function getSyncPoint(sessionId) {
  return readJson(SYNC_POINTS_FILE)[sessionId] || 0;
}

// Cron jobs
export function getCrons() {
  return readJson(CRONS_FILE);
}

export function saveCrons(jobs) {
  writeJson(CRONS_FILE, jobs);
}

export function getAllThreads() {
  return readJson(THREADS_FILE);
}

// Channel Watches
export function getWatches() {
  return readJson(WATCHES_FILE);
}

export function getWatch(channelId) {
  return readJson(WATCHES_FILE)[channelId] || null;
}

export function saveWatch(channelId, config) {
  const watches = readJson(WATCHES_FILE);
  watches[channelId] = { ...watches[channelId], ...config };
  writeJson(WATCHES_FILE, watches);
  return watches[channelId];
}

export function removeWatch(channelId) {
  const watches = readJson(WATCHES_FILE);
  const removed = watches[channelId];
  delete watches[channelId];
  writeJson(WATCHES_FILE, watches);
  return removed || null;
}

// ── Processing 메시지 추적 (서버 재시작 시 stale 정리용) ──

export function saveProcessing(sessionKey, { channel, ts, threadTs }) {
  const data = readJson(PROCESSING_FILE);
  data[sessionKey] = { channel, ts, threadTs, startedAt: new Date().toISOString() };
  writeJson(PROCESSING_FILE, data);
}

export function clearProcessing(sessionKey) {
  const data = readJson(PROCESSING_FILE);
  delete data[sessionKey];
  writeJson(PROCESSING_FILE, data);
}

export function getStaleProcessing() {
  const data = readJson(PROCESSING_FILE);
  const entries = Object.entries(data);
  if (entries.length > 0) writeJson(PROCESSING_FILE, {});
  return entries;
}

export { BRIDGE_DIR, SESSIONS_FILE, INBOX_FILE };
