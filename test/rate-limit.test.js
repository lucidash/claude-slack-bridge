import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRateLimitWindow } from '../src/rate-limit.js';

test('rate-limit 창 길이를 읽기 쉬운 라벨로 표시한다', () => {
  assert.equal(formatRateLimitWindow(300), '5h');
  assert.equal(formatRateLimitWindow(10080), '1w');
  assert.equal(formatRateLimitWindow(1440), '1d');
  assert.equal(formatRateLimitWindow(90), '90m');
  assert.equal(formatRateLimitWindow(null), '5h');
});
