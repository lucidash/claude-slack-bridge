import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const testDir = mkdtempSync(join(tmpdir(), 'claude-slack-commands-test-'));
process.env.BRIDGE_DATA_DIR = join(testDir, 'bridge-data');
process.env.SLACK_BOT_TOKEN = 'xoxb-test';

const [{ handleCommand }, { addCronJob, initCrons, removeCronJob }, { slack }, { saveSession }] = await Promise.all([
  import('../src/commands.js'),
  import('../src/cron.js'),
  import('../src/slack.js'),
  import('../src/store.js'),
]);

after(() => rmSync(testDir, { recursive: true, force: true }));

test('Codex cron 즉시 실행은 job 설정에 맞는 resume 명령을 안내한다', async () => {
  const messages = [];
  slack.chat.postMessage = async payload => {
    messages.push(payload);
    return { ts: payload.text.startsWith('⏰ Cron:') ? 'cron-thread' : 'status-thread' };
  };
  initCrons(async ({ userId, replyThreadTs }) => {
    saveSession(`${userId}-${replyThreadTs}`, 'codex-thread-id');
  });
  const job = addCronJob({
    schedule: '0 0 1 1 *',
    message: 'cron test',
    channel: 'cron-channel',
    userId: 'user-1',
    description: 'Codex cron',
    workdir: '/workspace/codex-job',
    engine: 'codex',
  });

  try {
    const handled = await handleCommand(`!cron run ${job.id}`, {
      channel: 'control-channel',
      replyThreadTs: 'control-thread',
      sessionKey: 'user-1-control-thread',
      userId: 'user-1',
      threadKey: null,
      sessionLocks: new Map(),
    });
    assert.equal(handled, true);
    await new Promise(resolve => setTimeout(resolve, 1_100));
  } finally {
    removeCronJob(job.id);
  }

  const sessionMessage = messages.find(message => message.text.startsWith('🔗 Session: `codex-thread-id`'));
  assert.ok(sessionMessage);
  assert.match(sessionMessage.text, /cd \/workspace\/codex-job && codex resume codex-thread-id/);
});
