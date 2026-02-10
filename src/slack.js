import { WebClient } from '@slack/web-api';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
if (!SLACK_BOT_TOKEN) {
  console.error('[Error] SLACK_BOT_TOKEN 환경변수가 필요합니다!');
  process.exit(1);
}

export const slack = new WebClient(SLACK_BOT_TOKEN);

/**
 * 스레드 히스토리 가져오기 (봇 호출 이전 대화 내용)
 */
export async function fetchThreadHistory(channel, threadTs) {
  try {
    const result = await slack.conversations.replies({
      channel,
      ts: threadTs,
      limit: 100,
    });
    if (!result.messages || result.messages.length <= 1) return '';

    const history = result.messages.slice(0, -1);
    const lines = history.map(msg => {
      const role = msg.bot_id ? '봇' : '사용자';
      const text = (msg.text || '').replace(/<@[A-Z0-9]+>\s*/g, '').trim();
      return `[${role}] ${text}`;
    });
    return lines.join('\n');
  } catch (err) {
    console.error('[Slack] Failed to fetch thread history:', err.message);
    return '';
  }
}

/**
 * 특정 시점 이후의 스레드 메시지 가져오기 (pause 이후 놓친 메시지용)
 */
export async function fetchThreadHistorySince(channel, threadTs, oldestTs) {
  try {
    const result = await slack.conversations.replies({
      channel,
      ts: threadTs,
      oldest: oldestTs,
      limit: 100,
    });
    if (!result.messages) return '';

    const lines = result.messages
      .filter(msg => msg.ts !== threadTs && !msg.bot_id && msg.subtype !== 'bot_message')
      .map(msg => {
        const text = (msg.text || '').replace(/<@[A-Z0-9]+>\s*/g, '').trim();
        return `[사용자] ${text}`;
      });
    return lines.join('\n');
  } catch (err) {
    console.error('[Slack] Failed to fetch thread history since:', err.message);
    return '';
  }
}
