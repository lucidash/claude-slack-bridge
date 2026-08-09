import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const testDir = mkdtempSync(join(tmpdir(), 'claude-slack-codex-test-'));
const fakeCodexPath = join(testDir, 'fake-codex');
const tracePath = join(testDir, 'trace.jsonl');

writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');

const trace = process.env.FAKE_CODEX_TRACE;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const record = value => fs.appendFileSync(trace, JSON.stringify(value) + '\\n');
let resumed = false;
let turnSequence = 0;
let pendingQuestionTurnId = null;
const activeTurns = new Map();
const initializeDelayMs = Number(process.env.FAKE_CODEX_INIT_DELAY_MS) || 0;
const interruptDelayMs = Number(process.env.FAKE_CODEX_INTERRUPT_DELAY_MS) || 0;
const threadStartDelayMs = Number(process.env.FAKE_CODEX_THREAD_START_DELAY_MS) || 0;
const threadResumeDelayMs = Number(process.env.FAKE_CODEX_THREAD_RESUME_DELAY_MS) || 0;
const turnStartDelayMs = Number(process.env.FAKE_CODEX_TURN_START_DELAY_MS) || 0;
const fatalTerminalDelayMs = Number(process.env.FAKE_CODEX_FATAL_TERMINAL_DELAY_MS) || 0;
const failThreadResume = process.env.FAKE_CODEX_THREAD_RESUME_FAIL === 'true';
let collisionThreadRead = null;

function sendThreadRead(id, threadId) {
  send({ jsonrpc: '2.0', id, result: { thread: {
    id: threadId, cwd: '/workspace/project', updatedAt: 1700000000,
    turns: [{ items: [
      { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: '요청' }] },
      { type: 'commandExecution', id: 'c1', command: 'pwd' },
      { type: 'agentMessage', id: 'a1', text: '응답' },
    ] }],
  } } });
}

function complete(turnId, prefix) {
  const active = activeTurns.get(turnId);
  if (!active) return;
  const { threadId } = active;
  const resultPrefix = prefix || active.prefix;
  send({ jsonrpc: '2.0', method: 'item/started', params: {
    threadId, turnId, startedAtMs: Date.now(),
    item: { type: 'commandExecution', id: 'tool-' + turnId, command: 'pwd', cwd: '/tmp', status: 'inProgress' },
  } });
  send({ jsonrpc: '2.0', method: 'item/completed', params: {
    threadId, turnId, completedAtMs: Date.now(),
    item: { type: 'commandExecution', id: 'tool-' + turnId, command: 'pwd', cwd: '/tmp', status: 'completed', exitCode: 0 },
  } });
  send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
    threadId, turnId, itemId: 'message-' + turnId, delta: resultPrefix,
  } });
  send({ jsonrpc: '2.0', method: 'item/completed', params: {
    threadId, turnId, completedAtMs: Date.now(),
    item: { type: 'agentMessage', id: 'message-' + turnId, text: resultPrefix },
  } });
  send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
    threadId, turnId,
    tokenUsage: {
      total: { totalTokens: 115, inputTokens: 110, cachedInputTokens: 12, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 },
      last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 },
      modelContextWindow: 200000,
    },
  } });
  send({ jsonrpc: '2.0', method: 'turn/completed', params: {
    threadId, turn: { id: turnId, status: 'completed', items: [], error: null },
  } });
  activeTurns.delete(turnId);
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  record(message);

  if (collisionThreadRead && message.id === collisionThreadRead.id && message.method == null) {
    const pendingRead = collisionThreadRead;
    collisionThreadRead = null;
    sendThreadRead(pendingRead.id, pendingRead.threadId);
    return;
  }
  if (message.id === 900 && Object.hasOwn(message, 'result')) {
    const answer = message.result?.answers?.choice?.answers?.[0];
    complete(pendingQuestionTurnId, answer === '두 번째' ? 'ASK_OK' : 'ASK_BAD');
    pendingQuestionTurnId = null;
    return;
  }
  if (message.id == null) return;

  switch (message.method) {
    case 'initialize':
      setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake' } }), initializeDelayMs);
      break;
    case 'thread/start':
      resumed = false;
      setTimeout(() => {
        send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-test', cwd: message.params.cwd } } });
      }, threadStartDelayMs);
      break;
    case 'thread/resume':
      resumed = true;
      setTimeout(() => {
        if (failThreadResume) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'resume failed' } });
        } else {
          send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: message.params.threadId, cwd: message.params.cwd } } });
        }
      }, threadResumeDelayMs);
      break;
    case 'account/rateLimits/read':
      send({ jsonrpc: '2.0', id: message.id, result: { rateLimits: {
        limitId: 'codex', limitName: 'Codex',
        primary: { usedPercent: 23.4, windowDurationMins: 300, resetsAt: 2000000000 },
      } } });
      break;
    case 'turn/start': {
      const prompt = message.params.input?.[0]?.text || '';
      const turnId = 'turn-' + (++turnSequence);
      activeTurns.set(turnId, {
        threadId: message.params.threadId,
        prefix: resumed ? 'RESUMED_OK' : 'FAKE_OK',
      });
      send({ jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: message.params.threadId,
        turn: { id: turnId, status: 'inProgress', items: [], error: null },
      } });
      setTimeout(() => {
        send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
      }, turnStartDelayMs);
      if (prompt.includes('ASK')) {
        pendingQuestionTurnId = turnId;
        send({ jsonrpc: '2.0', id: 900, method: 'item/tool/requestUserInput', params: {
          threadId: message.params.threadId, turnId, itemId: 'question-1', isBlocking: true,
          questions: [{ id: 'choice', header: '선택', question: '어느 것?', isOther: false, isSecret: false,
            options: [{ label: '첫 번째', description: '1' }, { label: '두 번째', description: '2' }] }],
        } });
      } else if (prompt === 'AUTO_RESOLVE_QUESTION') {
        const requestId = 901;
        send({ jsonrpc: '2.0', id: requestId, method: 'item/tool/requestUserInput', params: {
          threadId: message.params.threadId, turnId, itemId: 'question-auto', isBlocking: true,
          questions: [{ id: 'auto', header: '자동', question: '계속할까요?', isOther: false, isSecret: false,
            options: [{ label: '계속', description: '계속 진행' }, { label: '중단', description: '중단' }] }],
        } });
        setImmediate(() => {
          send({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: {
            threadId: message.params.threadId, requestId,
          } });
          complete(turnId, 'AUTO_RESOLVED');
        });
      } else if (prompt === 'SPARSE_RATE_LIMIT') {
        send({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: {
          rateLimits: { credits: { hasCredits: true, unlimited: false, balance: '10' } },
        } });
        setImmediate(() => complete(turnId));
      } else if (prompt === 'FATAL_DELAY') {
        send({ jsonrpc: '2.0', method: 'error', params: {
          threadId: message.params.threadId, turnId,
          error: { message: 'fatal turn error' }, willRetry: false,
        } });
        setTimeout(() => {
          send({ jsonrpc: '2.0', method: 'turn/completed', params: {
            threadId: message.params.threadId,
            turn: { id: turnId, status: 'failed', items: [], error: { message: 'fatal turn error' } },
          } });
          activeTurns.delete(turnId);
        }, fatalTerminalDelayMs);
      } else if (prompt.startsWith('DELAY:')) {
        const delayMs = Number(prompt.split(':')[1].split(/\s/)[0]);
        setTimeout(() => complete(turnId), delayMs);
      } else if (!prompt.includes('SLOW')) {
        setImmediate(() => complete(turnId));
      }
      break;
    }
    case 'turn/interrupt':
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      if (activeTurns.has(message.params.turnId)) {
        const interrupted = activeTurns.get(message.params.turnId);
        setTimeout(() => {
          send({ jsonrpc: '2.0', method: 'turn/completed', params: {
            threadId: interrupted.threadId,
            turn: { id: message.params.turnId, status: 'interrupted', items: [], error: null },
          } });
          activeTurns.delete(message.params.turnId);
        }, interruptDelayMs);
      }
      break;
    case 'thread/read':
      if (message.params.threadId === 'thread-collision') {
        collisionThreadRead = { id: message.id, threadId: message.params.threadId };
        send({ jsonrpc: '2.0', id: message.id, method: 'item/tool/requestUserInput', params: {
          threadId: message.params.threadId, turnId: 'turn-collision', itemId: 'question-collision', isBlocking: true,
          questions: [{ id: 'collision', header: '충돌', question: '계속할까요?', isOther: false, isSecret: false, options: [] }],
        } });
      } else {
        sendThreadRead(message.id, message.params.threadId);
      }
      break;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } });
  }
});
`, { mode: 0o755 });
chmodSync(fakeCodexPath, 0o755);

process.env.BRIDGE_DATA_DIR = join(testDir, 'bridge-data');
process.env.CODEX_PATH = fakeCodexPath;
process.env.FAKE_CODEX_TRACE = tracePath;
process.env.CODEX_SANDBOX = 'read-only';

const {
  readCodexSessionSummary,
  runCodex,
  shutdownCodexAppServer,
  stopCodexQuery,
} = await import('../src/codex.js');
const {
  clearSession,
  getSession,
  getThread,
  saveSession,
  saveThread,
  setThreadEngine,
  setThreadModel,
} = await import('../src/store.js');

function traceMessages() {
  try {
    const content = readFileSync(tracePath, 'utf8').trim();
    return content ? content.split('\n').map(JSON.parse) : [];
  } catch {
    return [];
  }
}

async function waitForTrace(predicate, timeoutMs = 1_000, startIndex = 0) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = traceMessages().slice(startIndex).find(predicate);
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('fake Codex trace 대기 시간 초과');
}

function turnPrompt(message) {
  return message.method === 'turn/start' ? message.params.input?.[0]?.text : null;
}

after(async () => {
  await shutdownCodexAppServer();
});

test('신규 thread를 만들고 스트리밍 결과와 usage를 수집한다', async () => {
  let readyId = null;
  const progress = [];
  const output = await runCodex('session-new', 'HELLO', testDir, {
    onSessionReady: id => { readyId = id; },
    onProgress: (activities, usage, rateLimit) => progress.push({ activities: [...activities], usage, rateLimit }),
  });

  assert.equal(readyId, 'thread-test');
  assert.equal(output.result, 'FAKE_OK');
  assert.equal(output.usage.inputTokens, 10);
  assert.equal(output.usage.contextWindow, 200000);
  assert.equal(output.rateLimit.pct, 23);
  assert.ok(progress.some(entry => entry.activities.some(value => value.includes('commandExecution'))));
});

test('저장된 thread를 thread/resume으로 이어간다', async () => {
  let readyCount = 0;
  const output = await runCodex('session-new', 'RESUME', testDir, {
    onSessionReady: () => { readyCount += 1; },
  });
  assert.equal(output.result, 'RESUMED_OK');
  assert.equal(readyCount, 0);
});

test('Codex 사용자 질문을 Slack 질문 콜백으로 중계한다', async () => {
  const output = await runCodex('session-question', 'ASK', testDir, {
    onAskUser: async questions => {
      assert.equal(questions[0].provider, 'Codex');
      assert.equal(questions[0].options[1].label, '두 번째');
      return { '어느 것?': '두 번째' };
    },
  });
  assert.equal(output.result, 'ASK_OK');
});

test('서버가 해제한 사용자 질문 waiter를 함께 취소한다', async () => {
  await shutdownCodexAppServer();
  let questionAborted = false;

  const output = await runCodex('session-auto-question', 'AUTO_RESOLVE_QUESTION', testDir, {
    onAskUser: (_questions, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        questionAborted = true;
        reject(new Error('질문 해제됨'));
      }, { once: true });
    }),
  });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(output.result, 'AUTO_RESOLVED');
  assert.equal(questionAborted, true);
});

test('sparse rate-limit 알림이 기존 primary 상태를 지우지 않는다', async () => {
  await shutdownCodexAppServer();
  const output = await runCodex('session-sparse-rate-limit', 'SPARSE_RATE_LIMIT', testDir);
  assert.equal(output.rateLimit?.pct, 23);
  assert.equal(output.rateLimit?.resetsAt, 2000000000);
});

test('실행 중인 turn을 turn/interrupt로 중단한다', async () => {
  const running = runCodex('session-stop', 'SLOW', testDir);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stopCodexQuery('session-stop'), true);
  await assert.rejects(running, /중단됨/);
  await new Promise(resolve => setTimeout(resolve, 20));

  const trace = traceMessages();
  const interrupt = trace.find(message => message.method === 'turn/interrupt');
  assert.equal(interrupt.params.threadId, 'thread-test');
  assert.match(interrupt.params.turnId, /^turn-/);
});

test('잘못된 Codex 보안 설정을 고권한 기본값으로 대체하지 않는다', async () => {
  const originalSandbox = process.env.CODEX_SANDBOX;
  const originalApproval = process.env.CODEX_APPROVAL_POLICY;
  let sandboxError = null;
  let approvalError = null;

  try {
    process.env.CODEX_SANDBOX = 'workspace_write';
    process.env.CODEX_APPROVAL_POLICY = 'never';
    sandboxError = await runCodex('session-invalid-sandbox', 'INVALID_SANDBOX', testDir)
      .then(() => null, error => error);

    process.env.CODEX_SANDBOX = 'read-only';
    process.env.CODEX_APPROVAL_POLICY = 'on_request';
    approvalError = await runCodex('session-invalid-approval', 'INVALID_APPROVAL', testDir)
      .then(() => null, error => error);
  } finally {
    process.env.CODEX_SANDBOX = originalSandbox;
    if (originalApproval == null) delete process.env.CODEX_APPROVAL_POLICY;
    else process.env.CODEX_APPROVAL_POLICY = originalApproval;
  }

  assert.match(sandboxError?.message || '', /CODEX_SANDBOX/);
  assert.match(approvalError?.message || '', /CODEX_APPROVAL_POLICY/);
});

test('잘못된 Codex 네트워크 설정을 허용으로 승격하지 않는다', async () => {
  const originalNetworkAccess = process.env.CODEX_NETWORK_ACCESS;
  let networkError = null;

  try {
    process.env.CODEX_NETWORK_ACCESS = 'flase';
    networkError = await runCodex('session-invalid-network', 'INVALID_NETWORK', testDir)
      .then(() => null, error => error);
  } finally {
    if (originalNetworkAccess == null) delete process.env.CODEX_NETWORK_ACCESS;
    else process.env.CODEX_NETWORK_ACCESS = originalNetworkAccess;
  }

  assert.match(networkError?.message || '', /CODEX_NETWORK_ACCESS/);
});

test('App Server 초기화 중인 실행도 중단할 수 있다', async () => {
  await shutdownCodexAppServer();
  process.env.FAKE_CODEX_INIT_DELAY_MS = '120';
  const traceStart = traceMessages().length;
  let stopped;
  let outcome;

  try {
    const running = runCodex('session-init-stop', 'INIT_STOP', testDir);
    await new Promise(resolve => setTimeout(resolve, 20));
    stopped = stopCodexQuery('session-init-stop');
    outcome = await running.then(
      value => ({ status: 'fulfilled', value }),
      error => ({ status: 'rejected', error }),
    );
  } finally {
    delete process.env.FAKE_CODEX_INIT_DELAY_MS;
    await shutdownCodexAppServer();
  }

  const newTrace = traceMessages().slice(traceStart);
  assert.equal(stopped, true);
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /중단됨/);
  assert.equal(newTrace.some(message => turnPrompt(message) === 'INIT_STOP'), false);
});

test('interrupt terminal 알림 전에는 실행 Promise를 해제하지 않는다', async () => {
  await shutdownCodexAppServer();
  process.env.FAKE_CODEX_INTERRUPT_DELAY_MS = '120';
  let stopped;
  let settledEarly;
  let outcome;

  try {
    const running = runCodex('session-interrupt-terminal', 'SLOW_INTERRUPT', testDir);
    await waitForTrace(message => turnPrompt(message) === 'SLOW_INTERRUPT');
    const observed = running.then(
      value => ({ status: 'fulfilled', value }),
      error => ({ status: 'rejected', error }),
    );
    let settled = false;
    observed.finally(() => { settled = true; });
    stopped = stopCodexQuery('session-interrupt-terminal');
    await new Promise(resolve => setTimeout(resolve, 30));
    settledEarly = settled;
    outcome = await observed;
  } finally {
    delete process.env.FAKE_CODEX_INTERRUPT_DELAY_MS;
    await shutdownCodexAppServer();
  }

  assert.equal(stopped, true);
  assert.equal(settledEarly, false);
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /중단됨/);
});

test('같은 Codex thread의 turn을 Slack 세션 사이에서도 직렬화한다', async () => {
  await shutdownCodexAppServer();
  saveSession('session-shared-a', 'thread-shared');
  saveSession('session-shared-b', 'thread-shared');

  const first = runCodex('session-shared-a', 'SLOW_SHARED_FIRST', testDir);
  await waitForTrace(message => turnPrompt(message) === 'SLOW_SHARED_FIRST');
  const second = runCodex('session-shared-b', 'SHARED_SECOND', testDir);
  await new Promise(resolve => setTimeout(resolve, 30));
  const secondStartedEarly = traceMessages().some(message => turnPrompt(message) === 'SHARED_SECOND');

  assert.equal(stopCodexQuery('session-shared-a'), true);
  const [firstOutcome, secondOutcome] = await Promise.all([
    first.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error })),
    second.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error })),
  ]);

  assert.equal(secondStartedEarly, false);
  assert.equal(firstOutcome.status, 'rejected');
  assert.equal(secondOutcome.status, 'fulfilled');
  assert.equal(secondOutcome.value.result, 'RESUMED_OK');
});

test('취소된 대기자 뒤의 turn도 기존 실행이 끝날 때까지 기다린다', async () => {
  await shutdownCodexAppServer();
  saveSession('session-tail-a', 'thread-tail');
  saveSession('session-tail-b', 'thread-tail');
  saveSession('session-tail-c', 'thread-tail');
  const traceStart = traceMessages().length;
  let firstObserved;
  let secondObserved;
  let thirdObserved;
  let thirdStartedEarly = false;

  try {
    firstObserved = runCodex('session-tail-a', 'SLOW_TAIL_FIRST', testDir)
      .then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
    await waitForTrace(message => turnPrompt(message) === 'SLOW_TAIL_FIRST', 1_000, traceStart);
    secondObserved = runCodex('session-tail-b', 'TAIL_CANCELLED_WAITER', testDir)
      .then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
    await new Promise(resolve => setTimeout(resolve, 20));
    thirdObserved = runCodex('session-tail-c', 'TAIL_THIRD', testDir)
      .then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(stopCodexQuery('session-tail-b'), true);
    await new Promise(resolve => setTimeout(resolve, 50));
    thirdStartedEarly = traceMessages().slice(traceStart)
      .some(message => turnPrompt(message) === 'TAIL_THIRD');
  } finally {
    await shutdownCodexAppServer();
    await Promise.all([firstObserved, secondObserved, thirdObserved].filter(Boolean));
  }

  assert.equal(thirdStartedEarly, false);
});

test('서버 request ID가 pending client request와 같아도 방향을 구분한다', async () => {
  await shutdownCodexAppServer();
  const traceStart = traceMessages().length;
  let summary;

  try {
    summary = await readCodexSessionSummary('thread-collision');
  } finally {
    await shutdownCodexAppServer();
  }

  const newTrace = traceMessages().slice(traceStart);
  const threadRead = newTrace.find(message => message.method === 'thread/read');
  assert.equal(summary?.cwd, '/workspace/project');
  assert.ok(newTrace.some(message => (
    message.id === threadRead?.id
    && message.method == null
    && message.result?.answers?.collision
  )));
});

test('세션 초기화 뒤 늦은 Codex thread 응답이 세션을 되살리지 않는다', async () => {
  await shutdownCodexAppServer();
  process.env.FAKE_CODEX_THREAD_START_DELAY_MS = '120';
  const sessionKey = 'session-engine-switch';
  const traceStart = traceMessages().length;
  let readyCount = 0;
  let output;

  try {
    const running = runCodex(sessionKey, 'ENGINE_SWITCH', testDir, {
      onSessionReady: () => { readyCount += 1; },
    });
    await waitForTrace(message => message.method === 'thread/start', 3_000, traceStart);
    clearSession(sessionKey);
    output = await running;
  } finally {
    delete process.env.FAKE_CODEX_THREAD_START_DELAY_MS;
    await shutdownCodexAppServer();
  }

  assert.equal(output.result, 'FAKE_OK');
  assert.equal(getSession(sessionKey), undefined);
  assert.equal(readyCount, 0);
});

test('늦은 resume 실패가 이후 선택한 세션을 삭제하지 않는다', async () => {
  await shutdownCodexAppServer();
  process.env.FAKE_CODEX_THREAD_RESUME_DELAY_MS = '80';
  process.env.FAKE_CODEX_THREAD_RESUME_FAIL = 'true';
  const sessionKey = 'session-stale-resume-clear';
  const traceStart = traceMessages().length;
  let outcome;

  try {
    saveSession(sessionKey, 'thread-old');
    const running = runCodex(sessionKey, 'STALE_RESUME', testDir);
    await waitForTrace(message => (
      message.method === 'thread/resume' && message.params.threadId === 'thread-old'
    ), 1_000, traceStart);
    saveSession(sessionKey, 'thread-new');
    outcome = await running.then(
      value => ({ status: 'fulfilled', value }),
      error => ({ status: 'rejected', error }),
    );
  } finally {
    delete process.env.FAKE_CODEX_THREAD_RESUME_DELAY_MS;
    delete process.env.FAKE_CODEX_THREAD_RESUME_FAIL;
    await shutdownCodexAppServer();
  }

  assert.equal(outcome.status, 'rejected');
  assert.equal(getSession(sessionKey), 'thread-new');
});

test('turn/start timeout 뒤 active turn을 terminal까지 정리한다', async () => {
  await shutdownCodexAppServer();
  process.env.CODEX_REQUEST_TIMEOUT_MS = '40';
  process.env.FAKE_CODEX_TURN_START_DELAY_MS = '120';
  const traceStart = traceMessages().length;
  const timedCodex = await import(`../src/codex.js?timeout-cleanup=${Date.now()}`);
  let outcome;

  try {
    outcome = await timedCodex.runCodex(
      'session-turn-start-timeout',
      'SLOW_TIMEOUT_START',
      testDir,
    ).then(
      value => ({ status: 'fulfilled', value }),
      error => ({ status: 'rejected', error }),
    );
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally {
    await timedCodex.shutdownCodexAppServer();
    delete process.env.CODEX_REQUEST_TIMEOUT_MS;
    delete process.env.FAKE_CODEX_TURN_START_DELAY_MS;
  }

  const newTrace = traceMessages().slice(traceStart);
  const timedOutTurn = newTrace.find(message => turnPrompt(message) === 'SLOW_TIMEOUT_START');
  assert.equal(outcome.status, 'rejected');
  assert.ok(timedOutTurn);
  assert.ok(newTrace.some(message => (
    message.method === 'turn/interrupt'
    && message.params.threadId === timedOutTurn.params.threadId
  )));
});

test('fatal error 뒤 terminal 알림까지 같은 thread 실행권을 유지한다', async () => {
  await shutdownCodexAppServer();
  process.env.FAKE_CODEX_FATAL_TERMINAL_DELAY_MS = '120';
  saveSession('session-fatal-a', 'thread-fatal');
  saveSession('session-fatal-b', 'thread-fatal');
  const traceStart = traceMessages().length;
  let firstObserved;
  let secondObserved;
  let secondStartedEarly;

  try {
    firstObserved = runCodex('session-fatal-a', 'FATAL_DELAY', testDir)
      .then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
    await waitForTrace(message => turnPrompt(message) === 'FATAL_DELAY', 1_000, traceStart);
    secondObserved = runCodex('session-fatal-b', 'AFTER_FATAL', testDir)
      .then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
    await new Promise(resolve => setTimeout(resolve, 40));
    secondStartedEarly = traceMessages().slice(traceStart)
      .some(message => turnPrompt(message) === 'AFTER_FATAL');
  } finally {
    delete process.env.FAKE_CODEX_FATAL_TERMINAL_DELAY_MS;
  }

  const [firstOutcome, secondOutcome] = await Promise.all([firstObserved, secondObserved]);
  assert.equal(secondStartedEarly, false);
  assert.equal(firstOutcome.status, 'rejected');
  assert.match(firstOutcome.error.message, /fatal turn error/);
  assert.equal(secondOutcome.status, 'fulfilled');
});

test('thread/read 결과를 기존 sync 요약 형식으로 변환한다', async () => {
  const summary = await readCodexSessionSummary('thread-history');
  assert.equal(summary.cwd, '/workspace/project');
  assert.equal(summary.updatedAt, 1700000000000);
  assert.deepEqual(summary.turns, [
    { role: 'user', text: '요청' },
    { role: 'assistant', text: '응답', tools: ['Bash'] },
  ]);
});

test('작업 디렉토리를 갱신해도 thread의 엔진과 모델을 보존한다', () => {
  saveThread('channel-thread', 'user-1', '/workspace/old');
  setThreadEngine('channel-thread', 'codex');
  setThreadModel('channel-thread', 'gpt-test');
  saveThread('channel-thread', 'user-1', '/workspace/new');

  assert.deepEqual(getThread('channel-thread'), {
    userId: 'user-1',
    createdAt: getThread('channel-thread').createdAt,
    workdir: '/workspace/new',
    engine: 'codex',
    model: 'gpt-test',
  });
});
