// 다른 Claude Code 프로세스(로컬 터미널 등)가 열어 둔 세션 확인·종료.
// CLI 는 실행 중 ~/.claude/sessions/<pid>.json 에 pid·sessionId·procStart 를 기록한다. 같은 세션을 두 프로세스가 이어가면
// 따로 진행되고(같은 작업을 두 번 한다) 같은 기록 파일에 서로 다른 분기가 섞이므로, 이어받기 전에 확인한다
import { readdirSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
const ENTRYPOINT_LABEL = { cli: '터미널', 'sdk-ts': 'SDK', 'sdk-py': 'SDK' };
const TERMINATE_WAIT_MS = 10000;

// 부모 pid 와 시작 시각 (UTC ctime 형식 — procStart 와 같은 형식). 프로세스가 없으면 null
function readProcess(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim();
    const [ppid, ...start] = out.split(/\s+/);
    return { ppid: Number(ppid), start: start.join(' ') };
  } catch {
    return null;
  }
}

/**
 * 이 세션을 열어 두고 있는 다른 프로세스. 끝났거나 PID 가 재사용된 기록(시작 시각이 다름)은 제외한다.
 * 브릿지가 실행한 프로세스도 제외한다 — 같은 스레드의 이전 실행이 아직 종료 중일 수 있다
 * @returns {{pid: number, name: string|null, entrypoint: string|null}[]}
 */
export function findSessionHolders(sessionId) {
  let files;
  try {
    files = readdirSync(SESSIONS_DIR).filter(f => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const holders = [];
  for (const file of files) {
    let info;
    try {
      info = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
    } catch {
      continue;
    }
    if (info.sessionId !== sessionId || !Number.isInteger(info.pid)) continue;
    const proc = readProcess(info.pid);
    if (!proc || proc.ppid === process.pid) continue;
    if (info.procStart && proc.start !== info.procStart.replace(/\s+/g, ' ')) continue;
    holders.push({ pid: info.pid, name: info.name || null, entrypoint: info.entrypoint || null });
  }
  return holders;
}

/** 예: `PID 8926 (likey-features-b6, 터미널)` */
export function describeSessionHolders(holders) {
  return holders.map((h) => {
    const info = [h.name, ENTRYPOINT_LABEL[h.entrypoint] || h.entrypoint].filter(Boolean).join(', ');
    return `PID ${h.pid}${info ? ` (${info})` : ''}`;
  }).join(', ');
}

/**
 * 다른 프로세스가 열어 둔 세션이면 이어받지 않도록 예외를 발생시킨다. 스레드의 세션 매핑은 삭제하지 않는다
 */
export function assertSessionNotHeld(sessionId) {
  const holders = findSessionHolders(sessionId);
  if (!holders.length) return;
  throw new Error(`이 세션은 다른 곳에서 실행 중이라 이어받지 않았습니다 — ${describeSessionHolders(holders)}\n`
    + `두 곳에서 이어가면 따로 진행되고 기록이 분기합니다. 그쪽을 종료하거나 \`!session ${sessionId} takeover\` 로 종료하고 이어받으세요.`);
}

/**
 * 세션을 열어 둔 프로세스를 SIGTERM 으로 종료하고 종료 완료를 기다린다 (`!session <id> takeover`)
 * @returns {Promise<object[]>} 기다려도 종료되지 않은 프로세스
 */
export async function terminateSessionHolders(sessionId, holders) {
  for (const h of holders) {
    try { process.kill(h.pid, 'SIGTERM'); } catch { /* 이미 종료 */ }
  }
  const deadline = Date.now() + TERMINATE_WAIT_MS;
  let remaining = findSessionHolders(sessionId);
  while (remaining.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    remaining = findSessionHolders(sessionId);
  }
  return remaining;
}
