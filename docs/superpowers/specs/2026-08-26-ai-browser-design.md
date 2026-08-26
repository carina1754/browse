# AI 브라우저 (Windows) — 설계

작성일: 2026-08-26
상태: 승인됨 (구현 계획 대기)

## 1. 목표

Windows 데스크톱 프로그램. 사용자가 자연어로 작업을 지시하면 AI가 웹 페이지를 직접 열고, 읽고, 클릭하고, 입력해서 결과를 가져온다. 사용자는 옆에서 진행 상황을 본다.

**이번 범위 = "AI 작업창"이다.** 탭 관리, 주소창, 북마크, 히스토리, 다운로드 관리 같은 범용 브라우저 기능은 만들지 않는다. 그 껍데기는 AI 코드와 무관한 별개 작업이고, 나중에 순수 추가로 붙일 수 있다.

**사용자 = 개인 1명.** 배포 대상이 아니다. `claude.exe`가 설치되어 있고 로그인되어 있다고 전제한다. 따라서 API 키 관리, 프로바이더 선택 UI, 인증 코드는 만들지 않는다.

## 2. 핵심 결정

### 2.1 에이전트 루프를 직접 만들지 않는다

`claude.exe`를 헤드리스 스트리밍 모드로 자식 프로세스로 띄우고, 브라우저 조작 툴만 MCP로 제공한다.

이렇게 해서 안 만드는 것: 에이전트 루프, LLM 프로바이더 연동, API 키 관리, 대화 히스토리 저장, 툴콜 파싱, 재시도/백오프.

만드는 것: 브라우저 툴 6개, MCP 서버, 프로세스 배관, 채팅 UI.

### 2.2 Electron (Tauri 아님)

| | Electron | Tauri |
|---|---|---|
| 추가 툴체인 | 없음 (Node 24 설치됨) | Rust + MSVC Build Tools |
| 배포 크기 | ~150MB | ~10MB |
| CDP 접근 | `webContents.debugger` 내장 | WebView2, 빈약 |

AI가 페이지를 조종하는 것이 제품의 전부다. CDP 접근이 결정적이라 Electron을 쓴다. 크기는 개인용이므로 무의미하다.

Chromium 포크(BrowserOS 방식)는 쓰지 않는다. 빌드에 디스크 100GB와 수 시간이 들지만, 포크가 주는 것(브라우저 크롬 UI 개조, MV2 확장, 자체 배포)은 이번 범위에 하나도 필요 없다.

### 2.3 Chrome 확장이 아니다

Chrome 확장 샌드박스는 프로세스를 띄울 수 없다. `claude.exe`를 붙이려면 Native Messaging(Windows는 레지스트리 등록 필요) 또는 localhost WebSocket 중간 프로세스가 반드시 하나 더 필요하다. Electron은 샌드박스 밖이라 `spawn`이 직결되고, 그 계층이 통째로 사라진다.

## 3. 아키텍처

```
┌─ Electron main (Node) ──────────────────────────┐
│                                                 │
│  BaseWindow                                     │
│   ├─ WebContentsView  [채팅 UI]    좌 380px     │
│   └─ WebContentsView  [웹 페이지]  나머지        │
│                        └─ webContents.debugger  │  CDP 인프로세스
│                                                 │
│  HTTP MCP 서버  127.0.0.1:<랜덤포트>            │
│   └─ 브라우저 툴 → 위 debugger 호출             │
│                                                 │
│  spawn(claude.exe)  ─ stdin/stdout NDJSON ─┐    │
└────────────────────────────────────────────│────┘
                                             │
                              ┌──────────────▼──┐
                              │  claude.exe     │
                              │  (에이전트 루프)│
                              └─────────┬───────┘
                                        │ HTTP MCP
                                        └──▶ 위 서버로 되돌아옴
```

프로세스는 둘뿐이다: Electron, `claude.exe`. CDP 포트를 외부에 열지 않는다 — `webContents.debugger`가 인프로세스다.

### 데이터 흐름

```
채팅 입력
  → IPC → main
  → claude.exe stdin에 NDJSON 한 줄
  → claude가 MCP 툴 호출 (HTTP)
  → webContents.debugger.sendCommand(...)
  → 결과 반환
  → claude가 stdout으로 텍스트 스트림
  → main이 NDJSON 파싱 → IPC → 채팅 UI 렌더
```

### 파일 구성

| 파일 | 역할 |
|---|---|
| `main/index.js` | 창 생성, 뷰 배치, IPC |
| `main/tools.js` | CDP 툴 6개 구현 |
| `main/mcp.js` | HTTP MCP 서버 (`@modelcontextprotocol/sdk`) |
| `main/claude.js` | `claude.exe` 스폰, NDJSON 파서 |
| `renderer/chat.html` | 채팅 UI. 바닐라 HTML/JS |
| `test/smoke.js` | 툴 검증 스크립트 |

의존성은 `electron`, `@modelcontextprotocol/sdk` 둘뿐이다. 번들러도 프론트엔드 프레임워크도 쓰지 않는다 — 개인용 채팅 패널 하나에 필요 없다.

## 4. 브라우저 툴

| 툴 | 구현 |
|---|---|
| `navigate(url)` | `webContents.loadURL()` — CDP보다 Electron API가 간단하다 |
| `snapshot()` | `Accessibility.getFullAXTree` |
| `click(ref)` | `DOM.resolveNode` → `Runtime.callFunctionOn(el.click())` |
| `type(ref, text)` | `DOM.resolveNode` → `focus()` → `Input.insertText` |
| `read_page()` | `Runtime.evaluate("document.body.innerText")` |
| `wait(sec)` | 타이머 + 선택적 셀렉터 폴링 |

6개로 시작한다. BrowserOS는 20개가 넘지만, 6개로 "검색해서 요약해줘" 수준이 동작한다. 부족한 것은 실제로 막혔을 때 추가한다.

### 4.1 `snapshot()` — 이 설계의 핵심

페이지 상태를 스크린샷이 아니라 접근성 트리 텍스트로 준다.

```
[ref=e3]  link     "로그인"
[ref=e7]  textbox  "검색어 입력"
[ref=e8]  button   "검색"
          heading  "오늘의 뉴스"
```

**왜 스크린샷이 아닌가:** 이미지는 토큰을 수십 배 먹고, 좌표 클릭은 스크롤·리사이즈·반응형 레이아웃에 깨진다. Playwright MCP와 Claude in Chrome이 모두 ref 방식을 쓴다. 스크린샷 툴은 시각 확인이 실제로 필요해질 때 하나 추가한다.

**필터가 필수다.** AX 트리 전체는 일반 페이지 하나에 수천 노드다. 상호작용 가능 노드(`button`, `link`, `textbox`, `checkbox`, `combobox`, `radio`, `menuitem`)와 텍스트 랜드마크(`heading`, `article` 제목)만 남긴다. 필터가 없으면 컨텍스트가 한 번에 소진된다.

**ref 수명:** `ref` → `backendNodeId` Map을 스냅샷마다 새로 만든다. 페이지가 이동하면 이전 ref는 무효다. 죽은 ref로 호출이 오면 `"stale ref, call snapshot() again"`을 반환한다 — claude가 스스로 재호출한다.

```js
// ponytail: el.click()은 JS 클릭이다. 진짜 마우스 이벤트만 받는 캔버스/드래그 UI는 못 뚫는다.
// 막히면 DOM.getBoxModel + Input.dispatchMouseEvent 좌표 경로를 추가한다.
```

## 5. `claude.exe` 실행

```js
spawn(claudeExe, [
  '-p', '--verbose',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--session-id', sessionUuid,
  '--setting-sources', '',
  '--disable-slash-commands',
  '--mcp-config', JSON.stringify({ mcpServers: { browser: { type: 'http', url: mcpUrl } } }),
  '--allowedTools', 'mcp__browser',
  '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'PowerShell', 'WebFetch',
  '--system-prompt', BROWSER_AGENT_PROMPT,
], { cwd: agentCwd })
```

- `--verbose`는 `--output-format=stream-json`과 함께 쓸 때 CLI가 요구한다. 없으면 즉시 에러다.
- `cwd`는 `app.getPath('userData')/agent-cwd`의 빈 디렉터리다. 프로젝트 `CLAUDE.md`가 에이전트 컨텍스트로 새는 것을 막는다.
- `--setting-sources ''`로 사용자 설정과 훅을 격리한다.

**`--bare`를 쓰지 않는다.** `--bare`는 OAuth와 키체인 읽기를 강제로 끄고 `ANTHROPIC_API_KEY`만 허용한다. 구독 로그인 사용자에게는 `"Not logged in · Please run /login"`으로 실패한다. 실측 확인된 사항이다. 격리 효과는 `--setting-sources ''` + 전용 cwd로 대신한다.

### 검증된 사항 (2026-08-26 실측)

- `claude.exe`는 네이티브 Windows PE32+ 실행파일이다. `.cmd` 셸 래퍼가 아니므로 Node `spawn()`이 `shell: true` 없이 직접 동작한다.
- 양방향 `stream-json` 헤드리스 모드가 동작한다. 왕복 응답 확인, ttft 1.2초.
- 로컬 환경: Node 24.18.0, npm 11.16.0. Rust 없음.

## 6. 보안

이 프로그램은 사용자의 로그인된 웹 세션을 조종한다. 여기서는 단순화하지 않는다.

`claude.exe`는 기본으로 `Bash`, `Edit`, `Read`, `PowerShell` 툴을 들고 있다(init 출력에서 확인). 브라우저 어시스턴트에게 파일시스템과 셸 접근은 불필요하고 위험하다.

- `--disallowedTools`로 파일시스템·셸·네트워크 툴을 전부 차단한다.
- `--allowedTools mcp__browser`로 우리 브라우저 툴만 허용한다.
- `--permission-mode`는 기본값을 쓴다. `--dangerously-skip-permissions`는 쓰지 않는다.
- 6단계에서 차단이 실제로 작동하는지 확인한다. 플래그를 걸었다는 것과 막힌다는 것은 다르다.

## 7. 구현 순서

| # | 단계 | 완료 기준 |
|---|---|---|
| 1 | 배선 스파이크 | 최소 MCP 서버(`ping` 툴 1개) + `claude.exe` 스폰. claude가 `ping` 호출에 성공한다 |
| 2 | Electron 껍데기 | 창이 뜨고 좌 채팅 / 우 웹페이지로 분할된다. 채팅은 에코만 |
| 3 | `claude.js` | 채팅 입력 → claude → 스트리밍 응답이 렌더된다. 툴 없음 |
| 4 | `tools.js` | 툴 6개. `test/smoke.js` 통과 |
| 5 | 전체 연결 | "위키백과에서 X 찾아서 요약해줘"가 실제로 동작한다 |
| 6 | 보안 확정 | 차단된 툴이 실제로 거부되는 것을 확인한다 |

**1단계는 이 설계의 유일한 미검증 가정이다.** `--mcp-config`로 HTTP transport MCP 서버가 실제로 연결되는지. CLI 헬프에 `--transport http`가 있으므로 가능성이 높지만, 실패하면 stdio MCP 서버 + 로컬 브리지로 우회해야 하고 §3 아키텍처가 바뀐다. 따라서 다른 어떤 코드보다 먼저, 단독으로 실행한다.

## 8. 테스트

`test/smoke.js` 파일 하나. `npx electron test/smoke.js`로 실행한다.

`data:` URL에 버튼과 입력창을 넣은 페이지를 띄우고 순서대로 확인한다:
1. `snapshot()`이 해당 요소들의 ref를 반환하는가
2. `type()`이 입력창에 값을 넣는가
3. `click()`이 버튼 핸들러를 발동시키는가
4. `read_page()`가 핸들러가 남긴 텍스트를 읽는가

`assert` 기반. 실패 시 exit 1. 테스트 프레임워크도 픽스처도 쓰지 않는다.

## 9. 이번에 안 하는 것

| 항목 | 언제 추가하나 |
|---|---|
| 탭, 주소창, 북마크, 히스토리 | 범용 브라우저로 확장하기로 결정할 때 |
| 스크린샷 툴 | 텍스트 스냅샷으로 부족한 작업에 실제로 막힐 때 |
| API 키 / 프로바이더 선택 | 본인 외에 배포할 때 |
| 세션 기록/재생 | 디버깅이 실제로 어려워질 때 |
| 스케줄 작업 | 요청이 생길 때 |
| 좌표 기반 마우스 입력 | 캔버스/드래그 UI에 막힐 때 (§4.1 `ponytail:` 주석) |

## 10. 참고

`.reference/BrowserOS/` — 얕은 클론. gitignore 대상. 이 설계에 반영된 것:
- `packages/browseros-agent/README.md` — MCP 서버 + CDP 클라이언트 분리 구조
- `packages/browseros/` — Chromium 포크 비용의 실증 (패치 8개, 디스크 100GB)
