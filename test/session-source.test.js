import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSessionSource } from '../src/session-source.js';

test('Codex 우선 탐색이 실패하면 Claude 세션을 감지한다', async () => {
  const calls = [];
  const detected = await resolveSessionSource('codex', {
    readCodex: async () => { calls.push('codex'); return null; },
    readClaude: async () => { calls.push('claude'); return { cwd: '/claude' }; },
  });

  assert.deepEqual(calls, ['codex', 'claude']);
  assert.deepEqual(detected, { engine: 'claude', summary: { cwd: '/claude' } });
});

test('Claude 우선 탐색이 실패하면 Codex 세션을 감지한다', async () => {
  const calls = [];
  const detected = await resolveSessionSource('claude', {
    readClaude: async () => { calls.push('claude'); return null; },
    readCodex: async () => { calls.push('codex'); return { cwd: '/codex' }; },
  });

  assert.deepEqual(calls, ['claude', 'codex']);
  assert.deepEqual(detected, { engine: 'codex', summary: { cwd: '/codex' } });
});

test('현재 엔진에서 세션을 찾으면 반대 저장소는 조회하지 않는다', async () => {
  let claudeCalls = 0;
  const detected = await resolveSessionSource('codex', {
    readCodex: async () => ({ cwd: '/codex' }),
    readClaude: async () => { claudeCalls += 1; return { cwd: '/claude' }; },
  });

  assert.equal(claudeCalls, 0);
  assert.equal(detected.engine, 'codex');
});
