import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('BRIDGE_DATA_DIR의 홈 디렉토리 표기를 확장한다', () => {
  const testHome = mkdtempSync(join(tmpdir(), 'claude-slack-store-home-'));
  const childCwd = join(testHome, 'cwd');
  mkdirSync(childCwd);
  const storeUrl = pathToFileURL(resolve('src/store.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(storeUrl)})`], {
    cwd: childCwd,
    env: {
      ...process.env,
      HOME: testHome,
      BRIDGE_DATA_DIR: '~/bridge-data',
    },
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(join(testHome, 'bridge-data', 'sessions.json')), true);
  assert.equal(existsSync(join(childCwd, '~', 'bridge-data')), false);
});
