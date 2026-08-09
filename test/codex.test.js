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
let active = null;

function complete(prefix = resumed ? 'RESUMED_OK' : 'FAKE_OK') {
  if (!active) return;
  const { threadId, turnId } = active;
  send({ jsonrpc: '2.0', method: 'item/started', params: {
    threadId, turnId, startedAtMs: Date.now(),
    item: { type: 'commandExecution', id: 'tool-1', command: 'pwd', cwd: '/tmp', status: 'inProgress' },
  } });
  send({ jsonrpc: '2.0', method: 'item/completed', params: {
    threadId, turnId, completedAtMs: Date.now(),
    item: { type: 'commandExecution', id: 'tool-1', command: 'pwd', cwd: '/tmp', status: 'completed', exitCode: 0 },
  } });
  send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
    threadId, turnId, itemId: 'message-1', delta: prefix,
  } });
  send({ jsonrpc: '2.0', method: 'item/completed', params: {
    threadId, turnId, completedAtMs: Date.now(),
    item: { type: 'agentMessage', id: 'message-1', text: prefix },
  } });
  send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
    threadId, turnId,
    tokenUsage: {
      total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 },
      last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 },
      modelContextWindow: 200000,
    },
  } });
  send({ jsonrpc: '2.0', method: 'turn/completed', params: {
    threadId, turn: { id: turnId, status: 'completed', items: [], error: null },
  } });
  active = null;
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  record(message);

  if (message.id === 900 && Object.hasOwn(message, 'result')) {
    const answer = message.result?.answers?.choice?.answers?.[0];
    complete(answer === '두 번째' ? 'ASK_OK' : 'ASK_BAD');
    return;
  }
  if (message.id == null) return;

  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake' } });
      break;
    case 'thread/start':
      resumed = false;
      send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-test', cwd: message.params.cwd } } });
      break;
    case 'thread/resume':
      resumed = true;
      send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: message.params.threadId, cwd: message.params.cwd } } });
      break;
    case 'account/rateLimits/read':
      send({ jsonrpc: '2.0', id: message.id, result: { rateLimits: {
        limitId: 'codex', limitName: 'Codex',
        primary: { usedPercent: 23.4, windowDurationMins: 300, resetsAt: 2000000000 },
      } } });
      break;
    case 'turn/start': {
      const prompt = message.params.input?.[0]?.text || '';
      active = { threadId: message.params.threadId, turnId: 'turn-test' };
      send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-test', status: 'inProgress', items: [], error: null } } });
      if (prompt.includes('ASK')) {
        send({ jsonrpc: '2.0', id: 900, method: 'item/tool/requestUserInput', params: {
          threadId: active.threadId, turnId: active.turnId, itemId: 'question-1', isBlocking: true,
          questions: [{ id: 'choice', header: '선택', question: '어느 것?', isOther: false, isSecret: false,
            options: [{ label: '첫 번째', description: '1' }, { label: '두 번째', description: '2' }] }],
        } });
      } else if (!prompt.includes('SLOW')) {
        setImmediate(() => complete());
      }
      break;
    }
    case 'turn/interrupt':
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      if (active) {
        send({ jsonrpc: '2.0', method: 'turn/completed', params: {
          threadId: active.threadId,
          turn: { id: active.turnId, status: 'interrupted', items: [], error: null },
        } });
        active = null;
      }
      break;
    case 'thread/read':
      send({ jsonrpc: '2.0', id: message.id, result: { thread: {
        id: message.params.threadId, cwd: '/workspace/project', updatedAt: 1700000000,
        turns: [{ items: [
          { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: '요청' }] },
          { type: 'commandExecution', id: 'c1', command: 'pwd' },
          { type: 'agentMessage', id: 'a1', text: '응답' },
        ] }],
      } } });
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
const { getThread, saveThread, setThreadEngine, setThreadModel } = await import('../src/store.js');

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

test('실행 중인 turn을 turn/interrupt로 중단한다', async () => {
  const running = runCodex('session-stop', 'SLOW', testDir);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stopCodexQuery('session-stop'), true);
  await assert.rejects(running, /중단됨/);
  await new Promise(resolve => setTimeout(resolve, 20));

  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map(JSON.parse);
  const interrupt = trace.find(message => message.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: 'thread-test', turnId: 'turn-test' });
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
