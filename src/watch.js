import { query } from '@anthropic-ai/claude-agent-sdk';
import { getWatch } from './store.js';

/**
 * Agent SDK (Haiku)로 메시지가 trigger 조건에 해당하는지 판단
 */
export async function triageMessage(messageText, watchConfig) {
  const prompt = `다음 Slack 메시지가 아래 조건에 해당하는지 판단하세요.

조건: ${watchConfig.trigger}

메시지:
${messageText || '(빈 메시지)'}

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{"shouldRespond": true 또는 false, "reason": "판단 이유 (한국어, 1줄)"}`;

  const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...cleanEnv } = process.env;

  try {
    const q = query({
      prompt,
      options: {
        model: 'haiku',
        maxTurns: 1,
        systemPrompt: '당신은 Slack 채널 메시지 분류기입니다. 도구를 사용하지 말고 JSON으로만 응답하세요.',
        env: cleanEnv,
      },
    });

    let result = '';
    for await (const msg of q) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text') result += block.text;
        }
      }
      if (msg.type === 'result' && msg.subtype === 'success' && msg.result) {
        result = msg.result;
      }
    }

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[Watch/Triage] Invalid response: ${result}`);
      return { shouldRespond: false, reason: 'triage 응답 파싱 실패' };
    }
    const json = JSON.parse(jsonMatch[0]);
    return { shouldRespond: !!json.shouldRespond, reason: json.reason || '' };
  } catch (err) {
    console.error('[Watch/Triage] Error:', err.message);
    return { shouldRespond: false, reason: `triage 오류: ${err.message}` };
  }
}

/**
 * 이벤트의 sender가 watch 설정의 senders에 매칭되는지 확인
 */
export function matchesSender(event, senders) {
  if (!senders || senders.length === 0) return false;
  const eventSenders = [event.bot_id, event.user, event.app_id].filter(Boolean);
  return senders.some(s => eventSenders.includes(s));
}

/**
 * 채널에 대한 watch 설정 반환 (enabled + 필수 필드 체크)
 */
export function getActiveWatch(channelId) {
  const watch = getWatch(channelId);
  if (!watch || !watch.enabled) return null;
  if (!watch.trigger || !watch.action || !watch.senders?.length) return null;
  return watch;
}
