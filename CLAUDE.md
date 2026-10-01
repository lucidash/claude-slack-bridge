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
  session.js  — claude 엔진 실행 흐름 (턴별 표시, 백그라운드 대기 중 메시지 주입)
  claude.js   — Agent SDK query() 실행 (streaming input), 턴·도구·백그라운드 작업 이벤트, 세션 관리
  turn-view.js — Slack 표시 (턴 스트리밍 메시지 = 작업 타임라인, 백그라운드 현황 카드)
  format.js   — 공통 포맷 (경과 시간, ctx, 도구 라벨)
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
4. `query()` 는 streaming input(입력을 브릿지가 열고 닫음)으로 실행한다
   - string prompt 를 쓰면 SDK 가 첫 `result` 에서 stdin 을 닫고, 그러면 CLI 가 `run_in_background` 셸을 5초 만에 종료하고 이후 턴의 AskUserQuestion 도 `Stream closed` 로 실패한다
   - 턴이 끝나도 백그라운드 작업(셸·서브에이전트)이 남아 있으면 입력을 열어 둔다. 완료 알림마다 턴이 이어져 `result` 가 여러 번 온다
   - 남은 작업도 넣을 메시지도 없을 때 입력을 닫아 끝낸다. 대기 한도(`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`)는 브릿지가 집행한다 (`stopTask()`)
5. Slack 표시는 턴 단위 (`turn-view.js`)
   - 턴마다 스트리밍 메시지 하나(`chat.startStream`, timeline): 모델의 글 + 도구 호출 카드(`task_update`). 병렬 호출은 카드 하나로 묶는다
   - `task_update` 는 같은 id 로 다시 보내면 title·status 는 교체, details·output 은 **이어 붙는다** — 바뀌는 정보(서브에이전트 진행)는 title 에 넣는다
   - `stopStream` 시점에 진행 중인(`pending` 포함) 카드는 error 로 바뀐다 — 턴을 넘기는 백그라운드 작업은 스트림이 아니라 현황 카드(`plan` 블록, `chat.update`)에서 관리한다
   - Slack 은 스트리밍 메시지를 시작 약 5분 뒤 닫는다 (갱신과 무관, 이후 `appendStream` 은 `message_not_in_streaming_state`). 그래서 4분이 지나면 새 메시지로 넘긴다
   - 메시지를 넘길 때(4분·길이 제한·질문으로 멈춤·만료) 진행 중 카드는 새 메시지에 처음부터 다시 띄우고, 이전 메시지에서는 `chat.update` 로 뺀다 (카드만 있던 메시지는 지운다). 닫힌 스트리밍 메시지도 `chat.update` 로 고칠 수 있다 (`task_card` 의 status 는 `in_progress`·`complete`·`error` 만)
   - 서브에이전트 메시지(`parent_tool_use_id`)는 진행 표시에만 쓰고 응답 글에는 넣지 않는다
6. 백그라운드 대기 중(턴 사이) 스레드에 온 메시지는 같은 query 에 바로 넣어 다음 턴으로 처리한다. 턴 도중 온 메시지는 대기열에 두었다가 턴이 끝나면 넣는다
7. 새 세션이면 세션 ID를 스레드에 댓글로 기록

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
| `SLACK_MODE` | `http` (기본, Events API + 공인 URL) 또는 `socket` (Socket Mode, 터널 불필요) |
| `SLACK_SIGNING_SECRET` | HTTP 모드용. Slack 서명 검증 시크릿 |
| `SLACK_APP_TOKEN` | Socket 모드용. App-Level Token (`xapp-`, scope: `connections:write`) |
| `ALLOWED_USERS` | 허용 사용자 ID (콤마 구분) |
| `CLAUDE_MODEL` | Claude 모델 (기본: sonnet) |
| `CLAUDE_ALLOWED_DIRS` | Claude CLI 허용 디렉토리 (콤마 구분) |
| `CLAUDE_SKIP_PERMISSIONS` | 권한 프롬프트 스킵 여부 |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` | 메인 턴이 끝난 뒤 백그라운드 작업(백그라운드 셸·서브에이전트)을 기다리는 최대 시간 (기본: `3600000` = 1시간, `0` = 무제한). 메인이 마지막으로 idle 이 된 시점부터 잰다. 넘으면 브릿지가 남은 작업을 중단하고 스레드에 안내를 남긴다 |
| `SLACK_BRIDGE_DATA_DIR` | 상태 파일 디렉토리 (기본: `~/.claude/slack-bridge`). 테스트 하네스가 운영 데이터를 건드리지 않도록 분리할 때 사용 |
| `CLAUDE_BIN` | `pty-claude` 엔진용 claude CLI 절대경로 (기본: `/Users/muzi/.local/bin/claude`) |
| `CLAUDE_PTY_HOME` | `pty-claude` 엔진의 자식 프로세스에 다른 `HOME` 을 주고 싶을 때 (선택). 본 머신 인증과 분리하고 별도 계정으로 운영할 때 사용 |
| `OPENAI_API_KEY` | STT용 OpenAI API 키 (선택) |
| `PORT` | 서버 포트 (기본: 3005). Socket 모드에서도 디버그 엔드포인트로 사용 |

## AI 엔진

스레드 단위로 백엔드를 선택할 수 있다.

| 엔진 | 구현 | 한도 풀 | 특징 |
|---|---|---|---|
| `claude` (기본) | Agent SDK `query()` API | **Agent SDK 풀** (6/15부터 Max 20x 월 $200 한도) | AskUserQuestion, rate-limit 헤더 지원 |
| `pty-claude` | Claude Code TUI 를 `node-pty` 로 spawn → `~/.claude/sessions/<pid>.json` + jsonl tail | **인터랙티브 구독 풀** (별도 한도) | AskUserQuestion / rate-limit 헤더 미지원 (TUI 한계). 자동화/무거운 작업을 SDK 한도와 분리해 돌릴 때 사용 |

전환: `!engine <claude\|pty-claude>` (세션 초기화됨). `!engine reset` 으로 기본값 복귀.

cron / watch 도 작업 단위로 엔진 지정 가능:
- `!cron add "<schedule>" <msg> --engine pty-claude -- <설명>` — 해당 cron 실행 시 스레드에 자동 적용
- `!watch-set <channel_id> engine pty-claude` — watch 가 만든 스레드에 자동 적용 (reset 으로 해제)

지정 안 하면 기본값 `claude` (SDK). 자동화는 SDK 한도와 분리해 운영하고 싶을 때 `pty-claude` 추천.

cron 은 모델도 작업 단위로 지정 가능:
- `!cron add "<schedule>" <msg> --model sonnet -- <설명>` — 해당 cron 이 만든 스레드에 `!model` 과 동일하게 적용
- 지정 안 하면 `CLAUDE_MODEL` 기본값 사용

## 주요 명령어

| 명령어 | 설명 |
|---|---|
| `!new` / `!reset` | 새 세션 시작 (진행 중인 작업·백그라운드 작업은 중단) |
| `!wd <path>` | 스레드별 작업 디렉토리 지정 |
| `!pwd` | 현재 작업 디렉토리 확인 |
| `!session` | 현재 세션 ID 확인 |
| `!session <id>` | 세션 전환 (작업 디렉토리 자동 감지) |
| `!pause` / `!resume` | 스레드 일시정지/재개 |
| `!status` | 진행 중인 작업 상태 확인 (백그라운드 대기 중인지 포함) |
| `!stop` | 실행 중 작업 중단 (백그라운드 작업 포함). `!stop all` 은 대기열도 비움 |
| `!queue` | 대기열 확인 |
| `!sync-all` | 최근 24h 내 변경된 모든 세션 일괄 동기화 |
| `!sync-all <duration>` | 지정 기간 내 변경 세션 일괄 동기화 (예: `6h`, `30m`) |
| `!engine` / `!engine <claude\|pty-claude>` | 스레드 AI 엔진 확인/변경 |
