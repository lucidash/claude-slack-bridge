import { createHmac, timingSafeEqual } from 'crypto';

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const ALLOWED_USERS = process.env.ALLOWED_USERS?.split(',').map(u => u.trim()) || [];

if (!SLACK_SIGNING_SECRET) {
  console.warn('[Warning] SLACK_SIGNING_SECRET이 없습니다. 요청 검증이 비활성화됩니다.');
}
if (ALLOWED_USERS.length === 0) {
  console.error('[Error] ALLOWED_USERS가 필요합니다!');
  console.error('        예: ALLOWED_USERS=U0XXXXXXXX,U0YYYYYYYY');
  process.exit(1);
}
console.log(`[Security] 허용된 사용자: ${ALLOWED_USERS.join(', ')}`);

export function verifySlackRequest(req) {
  if (!SLACK_SIGNING_SECRET) return true;

  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];
  if (!signature || !timestamp) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${req.rawBody}`;
  const hmac = createHmac('sha256', SLACK_SIGNING_SECRET);
  const computed = 'v0=' + hmac.update(baseString).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(computed));
  } catch {
    return false;
  }
}

export function isUserAllowed(userId) {
  return ALLOWED_USERS.includes(userId);
}
