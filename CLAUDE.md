# Claude Slack Bridge

Slack에서 Claude Code Agent SDK를 통해 Claude를 원격 제어하는 브릿지 서버. Slack DM이나 멘션으로 메시지를 보내면 로컬 머신에서 Agent SDK의 `query()` API로 Claude를 실행하고 결과를 스레드에 반환한다.

## 대상 프로젝트

이 브릿지를 통해 주로 다음 프로젝트들에 대한 작업 요청이 들어온다. `!cd`로 작업 디렉토리를 전환하여 사용한다.

| 프로젝트 | 경로 | 스택 | 비고 |
|---|---|---|---|
| **likey-backend** | `~/projects/likey-backend` | Node.js (ESM), Express, GCP (Datastore, BigQuery, Cloud Run) | API 서버, TypeScript, TSOA(Swagger) |
| **likey-web** | `~/projects/likey-web` | Nuxt2, Vue2, Vuetify | 웹 프론트엔드 |
| **likey-admin** | `~/projects/likey-admin` | Nuxt2, Vue2, Vuetify | 관리자 대시보드 (구 버전) |
| **likey-admin-v2** | `~/projects/likey-admin-v2` | Nuxt4, Vue3, Vuetify3, Tailwind | 관리자 대시보드 (신 버전) |
| **likey-android** | `~/projects/likey-android` | Kotlin, Gradle | Android 앱 |
| **likey-ios** | `~/projects/likey-ios` | Swift, SPM, Fastlane | iOS 앱 |
| **likey-web-4** | `~/projects/likey-web-4` | Nuxt4, Vue3, Tailwind, TanStack Query | 웹 프론트엔드 (신 버전) |
| **likey-features** | `~/projects/likey-features` | Markdown | 피처 스펙 문서, git submodule로 앱 레포에서 참조 |
| **tpc-agent** | `~/projects/tpc-agent` | TypeScript, Express 5, SWC, PostgreSQL, Cloud Run | GitHub↔Notion↔Sentry↔Slack 자동화 에이전트 |

## 기술 스택

- Node.js (ESM), Express
- `@slack/web-api` — Slack 연동
- `@anthropic-ai/claude-agent-sdk` — Claude Code Agent SDK (`query()` API로 실행)
- OpenAI API / Google STT — 음성 인식 (fallback 체인)

## 프로젝트 구조

```
src/
  index.js    — Express 서버, Slack 이벤트 수신 및 Claude 실행 오케스트레이션
  claude.js   — Agent SDK query() 실행, 스트리밍 이벤트 처리, 세션 관리
  commands.js — 명령어 처리 (!new, !cd, !session, !pause, !resume, !status, !stop, !queue)
  store.js    — 세션/스레드/작업디렉토리/인박스 영속 저장 (~/.claude/slack-bridge/)
  slack.js    — Slack WebClient, 스레드 히스토리 조회
  security.js — Slack 서명 검증, 사용자 화이트리스트
  stt.js      — 음성/동영상 파일 STT (OpenAI 우선, Google fallback)
```

## 실행

```bash
npm start      # 프로덕션
npm run dev    # 개발 (--watch)
```

## 핵심 동작 흐름

1. Slack 이벤트 수신 → 서명 검증 + 화이트리스트 확인
2. 명령어(`!` prefix)면 즉시 처리, 아니면 Agent SDK `query()` 실행
3. 세션별 lock/queue로 동시 요청 직렬화
4. SDK 스트리밍 이벤트(`assistant`, `result`, `rate_limit_event`)로 진행 상태를 Slack에 실시간 업데이트
5. 새 세션이면 세션 ID를 스레드에 댓글로 기록

## 개발 컨벤션

- 커밋 메시지: `feat:`, `fix:`, `revert:` 등 conventional commits (한국어)
- **코드 변경 시 반드시 `/wt` 스킬로 worktree를 생성하여 격리된 환경에서 작업한다**
  - worktree 이름은 변경 내용을 나타내는 이름으로 지정 (예: `fix-session-clear`, `feat-inbox-notification`)
  - main/master 브랜치에서 직접 코드를 수정하지 않는다
- main 머지 시 자동 재시작 (별도 배포 불필요)
- 빌드 스크립트 없음 (순수 Node.js, 트랜스파일 없음)

## 환경변수

| 변수 | 설명 |
|---|---|
| `SLACK_BOT_TOKEN` | Slack Bot OAuth Token |
| `SLACK_SIGNING_SECRET` | Slack 서명 검증용 시크릿 |
| `ALLOWED_USERS` | 허용 사용자 ID (콤마 구분) |
| `CLAUDE_MODEL` | Claude 모델 (기본: sonnet) |
| `CLAUDE_ALLOWED_DIRS` | Claude CLI 허용 디렉토리 (콤마 구분) |
| `CLAUDE_SKIP_PERMISSIONS` | 권한 프롬프트 스킵 여부 |
| `OPENAI_API_KEY` | STT용 OpenAI API 키 (선택) |
| `PORT` | 서버 포트 (기본: 3005) |

## 주요 명령어

| 명령어 | 설명 |
|---|---|
| `!new` / `!reset` | 새 세션 시작 |
| `!wd <path>` | 스레드별 작업 디렉토리 지정 |
| `!pwd` | 현재 작업 디렉토리 확인 |
| `!session` | 현재 세션 ID 확인 |
| `!session <id>` | 세션 전환 (작업 디렉토리 자동 감지) |
| `!pause` / `!resume` | 스레드 일시정지/재개 |
| `!status` | 진행 중인 작업 상태 확인 |
| `!stop` | 실행 중 작업 중단 + 큐 비우기 |
| `!queue` | 대기열 확인 |
| `!sync-all` | 최근 24h 내 변경된 모든 세션 일괄 동기화 |
| `!sync-all <duration>` | 지정 기간 내 변경 세션 일괄 동기화 (예: `6h`, `30m`) |
