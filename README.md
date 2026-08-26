# AI Browser

AI 어시스턴트가 내장된 윈도우 데스크톱 브라우저. 사람이 주소창을 치는 대신
**에이전트가 페이지를 직접 조작**한다. 탭도 북마크도 주소창도 없다 — 왼쪽은 채팅,
오른쪽은 에이전트가 운전하는 페이지 하나. (BrowserOS 를 참고했지만 코드는 공유하지 않는다.)

에이전트 본체는 직접 짠 agent loop 이 아니라 **`claude.exe` 를 백그라운드 프로세스로
띄운 것**이다. 우리는 브라우저 도구만 만들어서 MCP 로 넘겨준다.

개인용. 리포는 private.

---

## 요구사항

| 항목 | 버전/설치법 | 필수 | 없으면 |
|---|---|---|---|
| Node | v24 (개발 시 v24.18.0) | O | |
| `claude.exe` | 설치 + 로그인 완료 | O | 앱은 뜨지만 에이전트가 없다. ⚙ 에서 설치 가능 |
| `headroom` | `uv tool install headroom-ai` | X | headroom 모드만 못 쓴다 |
| `caveman` 플러그인 | Claude Code 플러그인 | X | caveman 모드만 못 쓴다 |
| `ponytail` 플러그인 | Claude Code 플러그인 | X | ponytail 모드만 못 쓴다 |

넷 다 앱 안에서 ⚙ 버튼으로 점검·설치된다 (`main/deps.js`). 다만 **설치 경로는 이
머신에서 end-to-end 로 검증된 적이 없다** — 네 도구가 이미 다 깔려 있어서 단축 경로만
탔다. 다른 머신에서 처음 돌릴 때 여기가 첫 번째 의심 지점이다.

## 실행

```
npm install
npm start
```

`npm start` 는 GUI 를 띄우고 살아 있는 에이전트를 spawn 한다. 서브에이전트/CI 에서
돌리면 안 된다.

---

## 구조

```
BaseWindow
├── chatView  (WebContentsView, 380px, renderer/chat.html + preload)
└── pageView  (WebContentsView, 나머지 — 에이전트가 운전하는 진짜 웹페이지)

main/app.js  ── IPC ──> chatView
     │
     ├── createTools(pageView.webContents)   CDP (webContents.debugger, in-process)
     │        │
     │        └── startMcpServer(tools)      127.0.0.1:<random>/mcp   서버 이름: browser
     │                    ▲
     │                    │ --mcp-config
     └── createAgent() ── claude.exe -p --output-format stream-json  (장수명 자식, stdin 유지)
```

핵심 결정 세 개:

1. **CDP 는 in-process 다.** `webContents.debugger.attach('1.3')` 를 쓴다. 외부
   디버깅 포트를 열지 않으므로 아무나 붙을 수 없고, puppeteer 같은 의존성도 없다.
2. **에이전트는 스크린샷·좌표를 안 쓴다.** `Accessibility.getFullAXTree` 를 떠서
   `[ref=eN] role "name"` 줄로 준다. 토큰이 압도적으로 싸고, 픽셀 좌표가 아니라
   접근성 노드라 레이아웃이 흔들려도 안 깨진다.
3. **`claude.exe` 는 한 번 띄우고 stdin 을 계속 열어둔다.** 턴마다 재시작하면
   대화가 초기화된다. `stream-json` 을 양방향으로 쓴다.

### 브라우저 도구 6개

`main/tools.js` 가 만들고 `main/mcp.js` 가 등록한다. 에이전트에게는
`mcp__browser__navigate` 처럼 보인다.

| 도구 | 하는 일 |
|---|---|
| `navigate(url)` | 페이지 로드. 리다이렉트 후 최종 URL 반환 |
| `snapshot()` | AX 트리를 `[ref=eN] role "name"` 목록으로 |
| `click(ref)` | 스냅샷의 ref 로 클릭 |
| `type(ref, text)` | 필드 비우고 입력 (`Input.insertText`) |
| `read_page()` | `document.body.innerText`, 30000자에서 자름 |
| `wait(seconds)` | 최대 30초 |

여섯 개 모두 **절대 reject 하지 않는다**. 실패해도 사람이 읽을 문자열을 돌려준다
(`safe()` 래퍼). reject 하면 MCP 가 모델에게 프로토콜 에러를 던지고 모델이 복구를
못 한다.

**ref 카운터(`n`)는 도구 수명 동안 절대 리셋하지 않는다.** 스냅샷마다 0 으로
되돌리면 이전 스냅샷의 `e1` 이 새 문서에서 재발급돼서, 오래된 ref 를 쥔 호출자가
전혀 다른 요소를 클릭한다. 실제로 고쳤던 버그다 (`351fe09`).

---

## 파일 지도

```
main/app.js      Electron 진입점 (package.json "main"). 부팅 순서와 모든 IPC 핸들러.
main/index.js    createWindow() 만 있는 부작용 없는 모듈. 테스트가 require 해도 앱이 안 뜬다.
main/claude.js   claude.exe spawn, argv 조립, NDJSON 스트림 파싱, BLOCKED_TOOLS.
main/tools.js    CDP 브라우저 도구 6개. MCP 도 Electron 창 구조도 모른다.
main/mcp.js      도구 6개를 MCP 툴로 등록하고 localhost HTTP 로 노출. CDP 를 모른다.
main/deps.js     외부 도구 4개 점검·설치. electron 을 require 하지 않는다.
main/modes.js    토큰 절약 모드. 시스템 프롬프트 조립 + 자식 env 조립. electron 을 require 하지 않는다.
main/preload.js  contextBridge 로 window.api 노출.
renderer/chat.html  채팅 UI 전부 (인라인 스크립트). innerHTML 을 쓰지 않는다 — 전부 textContent.
test/            아래 테스트 절 참고
spike/           동결된 게이트 산출물. import 하지도 고치지도 말 것.
docs/superpowers/  spec 과 plan
```

레이어 규칙: `tools.js` 는 MCP 를 모르고, `mcp.js` 는 CDP 를 모르고, `deps.js` 와
`modes.js` 는 electron 을 모른다. 그래서 `deps` 와 `modes` 는 순수 node 로 테스트된다.

`main/index.js` 와 `main/app.js` 가 갈라져 있는 이유: 예전에 한 파일이었을 때
`require.main` 가드로 부팅을 막으려 했는데 Electron 에서는 그 가드가 죽어 있었다
(`ea5acc9`). 창 만드는 코드를 부작용 없는 모듈로 분리하는 쪽이 맞다.

### 부팅 순서 (`main/app.js`) — 순서가 중요하다

```
createWindow()                chat.html 로딩 시작 (렌더러 스크립트가 곧 돈다)
settings 로드
IPC 핸들러 전부 등록           <-- 여기 위로 await 가 하나도 없어야 한다
createTools + startMcpServer   (try/catch, 실패하면 bootError 에 담고 UI 에 말한다)
checkAll()
startAgent()
```

**IPC 등록 앞에 `await` 를 넣으면 안 된다.** `createWindow()` 가 이미 chat.html
로딩을 시작했고 페이지 스크립트는 그 await 들보다 먼저 돈다. 실제로 겪은 증상:
`Error occurred in handler for 'settings:get': No handler registered`.

`startAgent()` 는 promise 큐로 직렬화돼 있다. 토글을 빠르게 두 번 누르면 첫 호출이
`await isHeadroomUp()` 에서 양보하는 사이 두 번째가 들어와 자식이 둘 생기고, 먼저
만든 쪽이 추적에서 빠져 종료도 안 된다.

---

## 토큰 절약 모드

⚙ 패널에 마스터 스위치(`tokenSaver`) 하나와 모드 3개. `enabled()` 는 둘 다 켜져야
true. **기본값은 전부 꺼짐**이다. 설정은 `app.getPath('userData')/settings.json`.

| 모드 | 어디를 치나 |
|---|---|
| `headroom` | 자식의 `ANTHROPIC_BASE_URL` 을 로컬 프록시(기본 `127.0.0.1:8787`)로 돌린다 |
| `caveman` | 플러그인의 `SKILL.md` 를 읽어 `--system-prompt` 에 붙인다 (출력 토큰 감소) |
| `ponytail` | 같은 방식 (툴 왕복 감소) |

**caveman/ponytail 을 왜 프롬프트로 주입하나:** 에이전트는 `--setting-sources ''`
로 돈다. 사용자 설정과 플러그인이 에이전트 컨텍스트로 새면 안 되기 때문이다. 그런데
그 격리 때문에 플러그인도 안 실린다. 그래서 디스크에서
`<plugin>/skills/<name>/SKILL.md` 를 직접 읽어 시스템 프롬프트에 붙인다. 격리는
유지되고 비용은 둘 다 켰을 때 프롬프트 약 10KB (캐시됨).

**설정을 바꾸면 에이전트를 재시작한다 — 대화가 초기화된다.** argv 와 env 는 spawn
시점에만 정해지므로 다른 방법이 없다. UI 가 이걸 명시한다.

`headroom` 을 켰는데 프록시가 안 떠 있으면 그 실행에서만 자동으로 뺀다. 안 그러면
모든 요청이 죽는데 증상이 "AI 가 응답을 안 한다" 로만 보인다. 헤더 배지는
"켜달라고 한 것" 이 아니라 **실제로 걸린 것**(`modes` 이벤트)을 보여준다.

---

## 보안 경계

이 앱의 에이전트는 웹페이지를 운전한다. 파일시스템과 셸에 닿을 이유가 없다.

- `--disallowedTools` 로 16개 차단 (`main/claude.js` `BLOCKED_TOOLS`):
  `Bash BashOutput KillShell PowerShell Read Write Edit NotebookEdit Glob Grep
  WebFetch WebSearch Agent Task ToolSearch SlashCommand`
- **`Agent`/`Task` 가 목록에 있는 이유가 특히 중요하다.** 보안 테스트에서 실제로
  관찰됐다: `Write` 가 거부되자 모델이 서브에이전트를 띄워 PowerShell 로 같은 파일을
  쓰려 했다. 위임 경로를 열어두면 나머지 차단이 전부 한 겹짜리가 된다. 그때 테스트가
  통과했던 건 경계 때문이 아니라 **타이밍** 때문이었다 (서브에이전트가 아직 돌고
  있는데 턴이 끝났다).
- `--allowedTools mcp__browser` — 브라우저 도구만 허용
- **절대 `--bare` 를 쓰지 않는다.** OAuth 를 강제로 끈다. 증상:
  `"result":"Not logged in · Please run /login"`
- **절대 `--dangerously-skip-permissions` 를 쓰지 않는다.**
- `--disable-slash-commands`, `--setting-sources ''`
- **에이전트 cwd 는 항상 전용 빈 디렉터리**(`userData/agent-cwd`). 안 그러면 이
  프로젝트의 `CLAUDE.md` 가 에이전트 컨텍스트로 샌다.
- 자식 env 에서 `CLAUDECODE*` / `CLAUDE_CODE_*` 를 **무조건** 뗀다. 이 앱을 Claude
  Code 세션 안에서 띄우면 자식이 그 세션의 IPC 소켓과 토큰을 물려받는다.
- renderer 는 `contextIsolation: true`, `nodeIntegration: false`. chat.html 은
  `innerHTML` 을 쓰지 않는다 — 에이전트가 가져온 페이지 텍스트가 UI 로 그대로 들어오므로.

env 는 **denylist** 다 (allowlist 아님). 리뷰에서 allowlist 를 권고받았지만 기각했다 —
`claude.exe` 가 인증에 필요한 env 를 전부 열거하려다 하나 빠뜨리면 OAuth 가 조용히
깨진다. denylist 의 실패 모드가 더 얕다.

---

## 테스트

```
npm run test:free   # 무료. 이것만 마음대로 돌려도 된다
npm test            # 유료 API 호출 포함 (agent + security)
```

| 스크립트 | 유료? | 뭘 보나 |
|---|---|---|
| `test:deps` | 무료 | `checkAll()` 모양, 이미 깔린 것에 `install()` 이 단축 경로로 빠지는지 |
| `test:modes` | 무료 | 프롬프트 조립, env 조립(대소문자·프록시 계열·세션 변수), 설정 병합 |
| `test:shell` | 무료 | `electron` 필요. 창/뷰 구조 |
| `test:tools` | 무료 | `electron` 필요. CDP 도구 6개를 실제 페이지에 |
| `test:agent` | **유료** | `claude.exe` 실제 호출 |
| `test:security` | **유료** | 차단된 툴이 진짜로 막히는지 |

유료 두 개는 `claude-haiku-4-5-20251001` 로 돈다.
`test:deps` 는 **안 깔린 도구에는 `install()` 을 절대 부르지 않는다** — 테스트가
240MB 를 받아버리면 안 되니까.

---

## 윈도우 함정 (다시 밟지 말 것)

전부 이 프로젝트에서 실제로 겪은 것들이다.

1. **SIGTERM 이 없다.** `kill()` 은 TerminateProcess 라 종료 코드가 0 이 아니다.
   의도한 종료를 오류로 보고하지 않으려면 `stopping` 플래그가 필요하다.
2. **환경변수 변경이 실행 중인 프로세스에 전파되지 않는다.** 설치 직후 재점검이
   항상 실패한다 - "설치 실패" 라고 뜨고 사용자가 버튼을 다시 눌러 240MB 를 또
   받는다. `refreshPath()` 가 알려진 설치 디렉터리를 PATH 앞에 붙여서 막는다.
   그래도 안 보이면 `needsRestart: true` 로 구분해서 보고한다.
3. **env 조회는 대소문자를 안 가리지만 `{...process.env}` 는 평범한 대소문자 구분
   객체다.** PowerShell 에서 `$env:anthropic_base_url` 로 넣으면 그 철자로 저장돼서
   정확한 이름만 지우면 살아남는다. 실측 확인함. `modes.js` 의 `pickVar`/`deleteVar`.
4. **`.cmd` 는 실행할 수 없다. `shell: true` 는 답이 아니다.** npm-global 설치는
   `claude.cmd` 를 남긴다. 실측한 결과:
   - 이름만으로 spawn: **ENOENT** (PATHEXT 미적용)
   - 절대경로를 shell 없이 spawn: **EINVAL** (CreateProcess 가 `.cmd` 를 못 연다)
   - `shell: true`: 세 개가 한꺼번에 터진다 — 경로에 공백이 있으면
     `'C:\Program' 은(는) 내부 또는 외부 명령...`, 인자를 이스케이프하지 않고
     (Node `DEP0190`), cmd.exe 명령줄 8191자 제한에 10KB 시스템 프롬프트가
     `명령줄이 너무 깁니다` 로 죽는다.

   해결: shim 본문에서 실제 타깃을 꺼내 shell 없이 직접 spawn 한다
   (`main/deps.js` 의 `unwrapCmdShim` / `toSpawnable`). `.js` 타깃이면 `node` 를 앞에
   붙이고, `.exe` 타깃이면 그대로 부른다. shim 형태가 `%dp0%` 와 `%~dp0` 두 가지고,
   구형은 **`node.exe` 가 타깃보다 먼저 나오므로 인터프리터를 걸러내야 한다** —
   안 그러면 `corepack.cmd` 에서 `corepack.js` 대신 `node.exe` 를 집는다.
5. **메뉴바가 `getContentBounds()` 에 안 보인다.** 메뉴바는 클라이언트 영역을 약
   21px 밀어내는데 `getContentBounds()` 는 밀리기 전 높이를 보고한다. 그 높이로 뷰를
   깔면 아래 21px 가 화면 밖으로 나가서 채팅 입력칸이 잘린다.
   `Menu.setApplicationMenu(null)` 로 해결. 육안 확인함 (2026-08-26).
6. **`Bash` 툴의 heredoc 이 역슬래시를 먹는다.** 따옴표 친 delimiter 인데도 역슬래시
   두 개가 하나로 접혔다 (3번 발생). 정규식이나 윈도우 경로를 heredoc 으로 쓰지 말 것.
   python 에서 `chr(92)` 로 조립하는 게 확실하다. 이 README 자체도 heredoc 으로 쓰다가
   따옴표 때문에 실패해서 Write 툴로 썼다.
7. **CDP 도메인 enable 은 한 번도 navigate 안 한 webContents 에서 영원히 멈춘다.**
   `getURL()` 이 빈 문자열이면 `DOM.enable` 이 무한 대기한다 (`Browser.getVersion`
   같은 브라우저-레벨 커맨드는 즉시 응답). `about:blank` 를 한 번 로드하면 풀린다.
8. **Electron 자식 트리는 부모를 죽여도 안 죽는다.** `shell: true` 로 띄운
   `npx electron .` 의 부모만 `kill()` 하면 창이 남는다. 실제로 창 4개가 떠 있었다.

## 코드 제약

- **CommonJS 만.** `"type": "module"` 없음.
- **의존성 정확히 3개.** `@modelcontextprotocol/sdk@^1.30`, `zod@^4`, dev `electron@^44`.
  늘리지 말 것.
- `--verbose` 는 `--output-format=stream-json` 과 함께 필수다.
- stdout 은 `StringDecoder` 로 증분 디코드한다. 한글이 청크 경계에 걸려 깨진다.
- MCP 서버 이름은 `browser` 여야 한다 (툴이 `mcp__browser__*` 로 노출됨).
- `BLOCKED_TOOLS` 는 `--disallowedTools` 뒤에 **별개 argv 로** 펼쳐 넘긴다.

---

## 알려진 구멍

- 설치 경로가 end-to-end 로 검증된 적 없다 (이 머신에는 넷 다 이미 있었다).
- **`.cmd` 해제가 진짜 `claude.cmd` 로는 검증된 적 없다.** 이 머신은 네이티브
  설치라 `claude.exe` 뿐이다. 해제 로직 자체는 합성 shim 4종과 이 머신의 실제
  shim 2개(`opencode.cmd` → `.exe` 타깃, `corepack.cmd` → `.js` 타깃)로 검증했지만,
  풀어낸 `node cli.js` 가 실제로 claude 로 뜨는 건 npm-global 머신에서 확인해야 한다.
  `⚙` 점검에 `2.1.246 (Claude Code)  (node ...cli.js)` 처럼 실행 형태가 같이 나온다.
- `findPlugin` 은 마켓플레이스 이름과 플러그인 이름이 같다고 가정한다.
- `claude plugin install` 이 실패해도 성공으로 보고될 수 있다 (마켓플레이스 clone
  자체에 `SKILL.md` 가 있어서 실질적으로는 무해).
- `agent-cwd` 를 부팅 시 비우지 않는다 (확인 없는 파일 삭제라 일부러 안 했다).
- chat.html 에 CSP meta 가 없다 (인라인 스크립트라 `unsafe-inline` 이 필요해짐).
- `click()` 은 JS 클릭이다. 진짜 마우스 이벤트만 받는 캔버스/드래그 UI 는 못 뚫는다.
  막히면 `DOM.getBoxModel` + `Input.dispatchMouseEvent` 좌표 경로를 추가한다.

## 작업 방식

- **워크트리 만들지 않는다. `main` 에 직접 커밋하고 자주 푸시한다.**
- 서브에이전트에게 `npm start` / `npm test` / `npm run test:agent` /
  `npm run test:security` 를 시키지 않는다 (GUI + 유료 호출).
- **OS 레벨 화면 자동화를 쓰지 않는다.** 예전에 서브에이전트의 클릭이 사용자의 실제
  업무용 앱에 떨어졌다.
- `spike/` 는 동결이다. import 도 수정도 하지 않는다.
