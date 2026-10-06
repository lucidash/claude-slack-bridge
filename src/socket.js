import { SocketModeClient } from '@slack/socket-mode';

// @slack/socket-mode 는 끊긴 연결을 스스로 재연결하지만, 아래 두 경우에는 재연결 시도가 멈춘 채 남는다.
// - WebSocket handshake 에 timeout 이 없다. 네트워크 인터페이스가 바뀌는 순간 연결을 시작하면 응답을 기다리며 멈춘다
//   (ping 감시는 연결이 열린 뒤에야 시작한다)
// - 재연결 중 apps.connections.open 이 네트워크 오류로 실패하면 재시도 간격이 1.3배씩 상한 없이 늘어난다.
//   오래 끊겼다가 네트워크가 돌아와도 다음 시도까지 수십 분을 기다릴 수 있다 (100회를 모두 실패하면 재연결을 멈춘다)
// 두 경우 모두 프로세스는 살아 있어 pm2 가 재시작하지 않는다. 그래서 일정 시간 연결되지 않으면 클라이언트를 새로 만든다.
// 프로세스는 그대로라 실행 중인 작업은 중단되지 않는다
const STALL_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;

/**
 * Socket Mode 연결을 시작하고, 연결이 멈추면 새 클라이언트로 교체한다
 * @param {object} opts
 * @param {(body: object) => void} opts.onEvent - 수신한 event_callback 의 body (ack 는 여기서 처리한다)
 * @param {(payload: object) => void} [opts.onInteraction] - 버튼·선택창(block_actions)과 모달 제출(view_submission) payload
 * @param {() => SocketModeClient} [opts.createClient] - 기본은 SLACK_APP_TOKEN 으로 만든 SocketModeClient
 * @returns {Promise<void>} 첫 연결이 끝나면 resolve. 첫 연결 실패는 그대로 reject 한다
 */
export async function startSocketMode({
  onEvent,
  onInteraction = () => {},
  createClient = () => new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN }),
  stallMs = STALL_MS,
  checkIntervalMs = CHECK_INTERVAL_MS,
}) {
  let current = null;
  let downSince = Date.now(); // 연결되지 않은 상태가 된 시각. 연결돼 있으면 null
  let replacedAt = 0;

  const connect = () => {
    const client = createClient();
    client.on('slack_event', async ({ ack, body }) => {
      try {
        await ack();
      } catch (err) {
        console.warn('[Socket] ack failed:', err.message);
      }
      if (body?.type === 'event_callback') onEvent(body);
      // 빈 ack 가 view_submission 의 모달을 닫는다
      else if (body?.type === 'block_actions' || body?.type === 'view_submission') onInteraction(body);
    });
    client.on('connected', () => {
      if (client !== current) return;
      downSince = null;
      console.log('[Socket] Connected to Slack');
    });
    client.on('reconnecting', () => {
      if (client === current) downSince ??= Date.now();
    });
    client.on('disconnected', () => {
      if (client !== current) return;
      downSince ??= Date.now();
      console.warn('[Socket] Disconnected from Slack');
    });
    client.on('error', (err) => {
      if (client === current) console.error('[Socket] Error:', err.message);
    });
    current = client;
    return client;
  };

  await connect().start();

  setInterval(() => {
    if (downSince === null) return;
    const now = Date.now();
    if (now - downSince < stallMs || now - replacedAt < stallMs) return;
    console.warn(`[Socket] Not connected for ${Math.round((now - downSince) / 1000)}s — replacing client`);
    const stalled = current;
    const client = connect(); // 먼저 교체해 두어야 이전 클라이언트가 닫히며 내는 이벤트가 연결 상태에 반영되지 않는다
    retire(stalled);
    replacedAt = now;
    client.start().catch((err) => console.error('[Socket] Failed to start:', err.message));
  }, checkIntervalMs);
}

// 교체된 클라이언트를 닫는다. apps.connections.open 응답을 기다리던 중이면 응답을 받은 뒤 연결까지 진행하므로,
// 나중에 연결되더라도 바로 닫는다 (연결이 둘이면 Slack 이 이벤트를 두 연결에 분산해 전달한다)
function retire(client) {
  client.on('connected', () => {
    client.disconnect().catch(() => {});
  });
  try {
    client.disconnect().catch(() => {});
  } catch (err) {
    console.warn('[Socket] Failed to close replaced client:', err.message);
  }
}
