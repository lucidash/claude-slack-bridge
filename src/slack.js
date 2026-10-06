import { WebClient } from '@slack/web-api';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
if (!SLACK_BOT_TOKEN) {
  console.error('[Error] SLACK_BOT_TOKEN 환경변수가 필요합니다!');
  process.exit(1);
}

export const slack = new WebClient(SLACK_BOT_TOKEN);

// 레포·스킬 선택창 메시지의 block_id 접두사. 스레드 히스토리에서 뺄 때 쓴다
export const PICKER_BLOCK_PREFIX = 'picker:';

// 브릿지 명령(`!` 로 시작, `!silent` 제외)과 선택창 메시지는 대화 맥락이 아니라 히스토리에서 뺀다.
// 선택창으로 시작한 스레드는 히스토리가 비므로 `/스킬 인자` 요청이 맨 앞에 그대로 전달되어 스킬로 바로 실행된다
function isBridgeControlMessage(msg) {
  if (msg.bot_id) return !!msg.blocks?.some(b => b.block_id?.startsWith(PICKER_BLOCK_PREFIX));
  return /^!(?!silent\s)/i.test((msg.text || '').replace(/<@[A-Z0-9]+>\s*/g, '').trim());
}

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

    const history = result.messages.slice(0, -1).filter(msg => !isBridgeControlMessage(msg));
    if (history.length === 0) return '';
    const lines = history.map(msg => {
      const role = msg.bot_id ? '봇' : '사용자';
      // text + attachments 내용 추출 (봇 메시지는 attachments에 주요 내용이 있을 수 있음)
      const parts = [];
      const mainText = (msg.text || '').replace(/<@[A-Z0-9]+>\s*/g, '').trim();
      if (mainText) parts.push(mainText);
      if (msg.attachments) {
        for (const att of msg.attachments) {
          if (att.title) parts.push(att.title);
          if (att.text && att.text !== att.title) parts.push(att.text);
        }
      }
      const text = parts.join('\n').trim();
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
