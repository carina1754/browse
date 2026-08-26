# AI 브라우저 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows Electron 앱. 사용자가 채팅으로 지시하면 `claude.exe` 자식 프로세스가 CDP 기반 MCP 툴로 옆 창의 웹 페이지를 직접 조작한다.

**Architecture:** Electron main이 (1) 웹 페이지를 띄우는 `WebContentsView`, (2) 그 페이지를 조작하는 툴을 노출하는 localhost HTTP MCP 서버, (3) `claude.exe` 자식 프로세스를 모두 소유한다. `claude.exe`는 stdin/stdout NDJSON으로 대화하고, 툴이 필요하면 HTTP로 우리 MCP 서버에 되돌아온다. 에이전트 루프는 구현하지 않는다.

**Tech Stack:** Node 24 (CJS), Electron 44, `@modelcontextprotocol/sdk` 1.30, `zod` 4. 번들러 없음, 프론트엔드 프레임워크 없음.

**Spec:** `docs/superpowers/specs/2026-08-26-ai-browser-design.md`

## Global Constraints

- **모듈 형식은 CommonJS.** `package.json`에 `"type": "module"`을 넣지 않는다. Electron main의 ESM 지원은 함정이 많고, SDK는 `require` 진입점(`dist/cjs/`)을 제공한다.
- **의존성은 3개만.** `electron@^44`, `@modelcontextprotocol/sdk@^1.30`, `zod@^4`. 다른 패키지를 추가하지 않는다. (`zod`는 SDK의 peerDependency라 명시적으로 설치해야 한다.)
- **`claude.exe` 실행 파일명:** `process.platform === 'win32' ? 'claude.exe' : 'claude'`. Node `spawn()`은 `shell: false`에서 PATHEXT 확장을 보장하지 않으므로 확장자를 명시한다.
- **`--verbose`는 필수.** `--output-format=stream-json`과 함께 쓰지 않으면 CLI가 `Error: When using --print, --output-format=stream-json requires --verbose`로 즉시 죽는다.
- **`--bare`를 쓰지 않는다.** OAuth·키체인 읽기를 강제로 꺼서 구독 로그인 사용자가 `"Not logged in · Please run /login"`으로 실패한다. 격리는 `--setting-sources ''` + 전용 빈 cwd로 한다.
- **에이전트 cwd는 항상 빈 전용 디렉터리.** 프로젝트 `CLAUDE.md`가 에이전트 컨텍스트로 새는 것을 막는다.
- **`--dangerously-skip-permissions`를 절대 쓰지 않는다.** 이 프로그램은 로그인된 웹 세션을 조작한다.
- **테스트 모델은 `claude-haiku-4-5-20251001`.** 테스트 비용을 낮춘다. 앱 실행 시 기본 모델은 지정하지 않는다(사용자 기본값을 따른다).
- **MCP 서버 이름은 `browser`.** 따라서 툴 전체 이름은 `mcp__browser__<tool>`이고 allowlist는 `mcp__browser`다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `package.json` | 의존성, `start` / `test` 스크립트 |
| `spike/ping-server.js` | Task 1 전용. MCP 서버가 HTTP로 붙는지 증명하는 최소 서버 |
| `spike/run-spike.js` | Task 1 전용. 스파이크 실행 + 단언 |
| `main/index.js` | Electron 앱 진입점. 창·뷰 배치, IPC 배선, 부품 조립 |
| `main/preload.js` | 채팅 렌더러에 노출하는 IPC 브리지 |
| `main/claude.js` | `claude.exe` 스폰, NDJSON 인코딩/디코딩, 이벤트 방출 |
| `main/tools.js` | CDP 브라우저 툴 6개. Electron/MCP를 모르는 순수 함수 묶음 |
| `main/mcp.js` | `tools.js`를 MCP 툴로 등록하고 localhost HTTP로 노출 |
| `renderer/chat.html` | 채팅 UI. 인라인 스타일/스크립트 |
| `test/shell.test.js` | Task 2. 창·뷰 배치 검증 |
| `test/agent.test.js` | Task 3. 한 프로세스에서 멀티턴 유지 검증 |
| `test/tools.test.js` | Task 4. 툴 6개 동작 검증 |
| `test/security.test.js` | Task 6. 차단된 툴이 실제로 거부되는지 검증 |

`main/tools.js`는 MCP를 모르고, `main/mcp.js`는 CDP를 모르고, `main/claude.js`는 브라우저를 모른다. 경계를 이렇게 잡아야 각 파일을 따로 테스트할 수 있다.

---

## Task 1: 배선 스파이크 — `claude.exe`가 HTTP MCP 서버에 붙는가

**이 태스크가 실패하면 계획 전체를 멈추고 설계로 돌아간다.** 아키텍처의 유일한 미검증 가정이다. 실패 시 대안은 stdio MCP 서버 + 로컬 브리지이며, 그건 스펙 §3을 다시 써야 한다.

**Files:**
- Create: `package.json`
- Create: `spike/ping-server.js`
- Create: `spike/run-spike.js`
- Create: `.gitignore` (이미 존재 — 확인만)

**Interfaces:**
- Consumes: 없음
- Produces: `startPingServer(nonce) -> Promise<{ url: string, close: () => void }>` — Task 5의 `main/mcp.js`가 이 HTTP 서버 부트스트랩 패턴을 그대로 재사용한다.

- [ ] **Step 1: 프로젝트 초기화**

```bash
cd C:/Users/QUVE/Desktop/GIT/browse
npm init -y
npm pkg set name="ai-browser" version="0.1.0" private=true main="main/index.js"
npm pkg delete type
npm i @modelcontextprotocol/sdk@^1.30 zod@^4
npm i -D electron@^44
```

`npm pkg delete type`은 `npm init -y`가 `"type"`을 넣었을 경우를 대비한 것이다. CJS를 강제한다.

- [ ] **Step 2: `spike/ping-server.js` 작성**

```js
// spike/ping-server.js
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

// 이 서버가 증명하려는 것: claude.exe가 --mcp-config의 http transport로
// 우리 프로세스에 되돌아와 툴을 호출할 수 있는가.
async function startPingServer(nonce) {
  const server = new McpServer({ name: 'browser', version: '0.1.0' });

  server.registerTool(
    'ping',
    { description: 'Health check. Returns a fixed token.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: nonce }] })
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (!req.url.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400).end();
          return;
        }
      }
      transport.handleRequest(req, res, body);
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => httpServer.close(),
  };
}

module.exports = { startPingServer };
```

`listen(0)`은 OS가 빈 포트를 고르게 한다. 고정 포트를 쓰지 않는다.

- [ ] **Step 3: `spike/run-spike.js` 작성 (실패하는 검증)**

```js
// spike/run-spike.js
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startPingServer } = require('./ping-server.js');

const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';

async function main() {
  const nonce = 'PONG-' + randomUUID().slice(0, 8);
  const srv = await startPingServer(nonce);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cwd-'));

  const args = [
    '-p', '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--session-id', randomUUID(),
    '--setting-sources', '',
    '--disable-slash-commands',
    '--mcp-config', JSON.stringify({
      mcpServers: { browser: { type: 'http', url: srv.url } },
    }),
    '--allowedTools', 'mcp__browser',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'PowerShell', 'WebFetch',
    '--model', 'claude-haiku-4-5-20251001',
  ];

  const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });

  let buf = '';
  let sawToolUse = false;
  let result = null;

  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'assistant') {
        for (const c of msg.message?.content ?? []) {
          if (c.type === 'tool_use' && String(c.name).startsWith('mcp__browser')) {
            sawToolUse = true;
          }
        }
      }
      if (msg.type === 'result') result = msg;
    }
  });

  child.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Call the ping tool and reply with exactly its output, nothing else.' },
  }) + '\n');
  child.stdin.end();

  const code = await new Promise((resolve) => child.on('close', resolve));
  srv.close();

  assert.ok(sawToolUse, 'claude never called mcp__browser__ping');
  assert.ok(result, `no result message (exit ${code})`);
  assert.ok(
    String(result.result).includes(nonce),
    `nonce ${nonce} missing from result: ${result.result}`
  );
  console.log('SPIKE PASS:', result.result);
}

main().catch((e) => {
  console.error('SPIKE FAIL:', e.message);
  process.exit(1);
});
```

- [ ] **Step 4: 스파이크 실행**

Run: `node spike/run-spike.js`
Expected: `SPIKE PASS: PONG-xxxxxxxx`

**실패했다면 여기서 멈춘다.** 흔한 실패 원인과 대응:
- `claude never called mcp__browser__ping` → MCP 서버가 붙긴 했는지 확인. `--mcp-config` 뒤에 `--debug mcp`를 붙여 stderr를 본다.
- 서버가 아예 연결 안 됨 → `type: 'http'` 대신 `type: 'sse'`와 SSE transport를 시도한다. 그래도 안 되면 stdio 전환이 필요하고, **스펙 §3을 다시 쓴 뒤에** 계획을 재작성한다.
- `Not logged in` → `--bare`가 어딘가 들어갔다. 인자를 다시 본다.

- [ ] **Step 5: 커밋**

```bash
git add package.json package-lock.json spike/
git commit -m "spike: verify claude.exe connects to local HTTP MCP server"
```

---

## Task 2: Electron 껍데기 — 창 + 좌우 분할 뷰

**Files:**
- Create: `main/index.js`
- Create: `main/preload.js`
- Create: `renderer/chat.html`
- Test: `test/shell.test.js`
- Modify: `package.json` (scripts 추가)

**Interfaces:**
- Consumes: 없음
- Produces:
  - `main/index.js`가 모듈로 `require`될 때 `{ createWindow: () => { win, chatView, pageView } }`를 export한다. 테스트가 Electron 앱을 띄우지 않고 창만 만들 수 있게 하기 위함이다.
  - `window.api.send(text: string): void` — 렌더러 → main
  - `window.api.onEvent(cb: (evt: {type: string, text?: string}) => void): void` — main → 렌더러

- [ ] **Step 1: `package.json`에 스크립트 추가**

```bash
npm pkg set scripts.start="electron ."
npm pkg set scripts.test:shell="electron test/shell.test.js"
```

- [ ] **Step 2: 실패하는 테스트 작성 — `test/shell.test.js`**

```js
// test/shell.test.js
// 실행: npx electron test/shell.test.js
const assert = require('node:assert');
const { app } = require('electron');

app.whenReady().then(() => {
  const { createWindow, CHAT_WIDTH } = require('../main/index.js');
  const { win, chatView, pageView } = createWindow();

  assert.strictEqual(win.contentView.children.length, 2, 'expected 2 child views');

  const chat = chatView.getBounds();
  const page = pageView.getBounds();
  const content = win.getContentBounds();

  assert.strictEqual(chat.x, 0, 'chat view must start at x=0');
  assert.strictEqual(chat.width, CHAT_WIDTH, `chat view width must be ${CHAT_WIDTH}`);
  assert.strictEqual(page.x, CHAT_WIDTH, 'page view must start where chat ends');
  assert.strictEqual(chat.width + page.width, content.width, 'views must fill window width');
  assert.strictEqual(chat.height, content.height, 'chat view must fill height');

  console.log('SHELL PASS');
  app.exit(0);
}).catch((e) => {
  console.error('SHELL FAIL:', e.message);
  app.exit(1);
});
```

- [ ] **Step 3: 테스트 실행해서 실패 확인**

Run: `npm run test:shell`
Expected: FAIL — `Cannot find module '../main/index.js'`

- [ ] **Step 4: `main/preload.js` 작성**

```js
// main/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  send: (text) => ipcRenderer.send('chat:send', text),
  onEvent: (cb) => ipcRenderer.on('chat:event', (_e, evt) => cb(evt)),
});
```

- [ ] **Step 5: `renderer/chat.html` 작성**

```html
<!doctype html>
<meta charset="utf-8" />
<title>chat</title>
<style>
  html, body { margin: 0; height: 100%; font: 14px system-ui, sans-serif; }
  body { display: flex; flex-direction: column; background: #1e1e1e; color: #e0e0e0; }
  #log { flex: 1; overflow-y: auto; padding: 12px; white-space: pre-wrap; }
  .user { color: #7cc3ff; margin-top: 12px; }
  .tool { color: #b58900; font-size: 12px; }
  .err  { color: #ff6b6b; }
  #bar { display: flex; border-top: 1px solid #333; }
  #input { flex: 1; padding: 10px; border: 0; background: #2a2a2a; color: inherit; font: inherit; }
  #input:focus { outline: none; }
</style>
<div id="log"></div>
<div id="bar"><input id="input" placeholder="무엇을 할까요?" autofocus /></div>
<script>
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  let streaming = null;

  function line(cls, text) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    line('user', '> ' + input.value);
    window.api.send(input.value);
    input.value = '';
    streaming = null;
  });

  window.api.onEvent((evt) => {
    if (evt.type === 'text') {
      if (!streaming) streaming = line('assistant', '');
      streaming.textContent += evt.text;
      log.scrollTop = log.scrollHeight;
    } else if (evt.type === 'tool') {
      streaming = null;
      line('tool', '· ' + evt.text);
    } else if (evt.type === 'done') {
      streaming = null;
    } else if (evt.type === 'error') {
      streaming = null;
      line('err', '! ' + evt.text);
    }
  });
</script>
```

- [ ] **Step 6: `main/index.js` 작성 (최소 구현)**

```js
// main/index.js
const path = require('node:path');
const { app, BaseWindow, WebContentsView, ipcMain } = require('electron');

const CHAT_WIDTH = 380;

function createWindow() {
  const win = new BaseWindow({ width: 1400, height: 900, title: 'AI Browser' });

  const chatView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const pageView = new WebContentsView();

  win.contentView.addChildView(chatView);
  win.contentView.addChildView(pageView);

  function layout() {
    const { width, height } = win.getContentBounds();
    chatView.setBounds({ x: 0, y: 0, width: CHAT_WIDTH, height });
    pageView.setBounds({ x: CHAT_WIDTH, y: 0, width: width - CHAT_WIDTH, height });
  }
  layout();
  win.on('resize', layout);

  chatView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'chat.html'));
  pageView.webContents.loadURL('about:blank');

  return { win, chatView, pageView };
}

module.exports = { createWindow, CHAT_WIDTH };

// require.main === module 일 때만 앱으로 부팅한다.
// 테스트는 이 파일을 require 하므로 여기서 창을 자동 생성하면 안 된다.
if (require.main === module) {
  app.whenReady().then(() => {
    const { chatView } = createWindow();
    // Task 3에서 여기에 에이전트를 붙인다.
    ipcMain.on('chat:send', (_e, text) => {
      chatView.webContents.send('chat:event', { type: 'text', text: `echo: ${text}\n` });
      chatView.webContents.send('chat:event', { type: 'done' });
    });
  });

  app.on('window-all-closed', () => app.quit());
}
```

- [ ] **Step 7: 테스트 실행해서 통과 확인**

Run: `npm run test:shell`
Expected: `SHELL PASS`, exit 0

- [ ] **Step 8: 눈으로 확인**

Run: `npm start`
Expected: 창이 뜨고 왼쪽 380px에 어두운 채팅 패널, 오른쪽에 빈 페이지. 채팅에 아무거나 치면 `echo: ...`가 돌아온다. 창 크기를 바꾸면 두 뷰가 같이 늘어난다.

- [ ] **Step 9: 커밋**

```bash
git add package.json main/ renderer/ test/shell.test.js
git commit -m "feat: electron shell with split chat and page views"
```

---

## Task 3: `claude.exe` 에이전트 배관 — 멀티턴 스트리밍

**Files:**
- Create: `main/claude.js`
- Test: `test/agent.test.js`
- Modify: `main/index.js` (echo 핸들러를 실제 에이전트로 교체)
- Modify: `package.json` (scripts 추가)

**Interfaces:**
- Consumes: 없음 (Electron에 의존하지 않는 순수 Node 모듈이다)
- Produces:
  ```
  createAgent(opts) -> { send(text: string): void, stop(): void }

  opts = {
    cwd: string,              // 빈 전용 디렉터리
    mcpUrl?: string,          // 없으면 --mcp-config 를 생략한다
    model?: string,           // 없으면 사용자 기본 모델
    systemPrompt?: string,
    onEvent: (evt) => void,
  }

  evt = { type: 'text',  text: string }    // 어시스턴트 텍스트 델타
      | { type: 'tool',  text: string }    // 툴 호출 알림 (툴 이름)
      | { type: 'done',  result: string }  // 한 턴 종료
      | { type: 'error', text: string }
  ```
  Task 5의 `main/index.js`가 이 인터페이스를 그대로 IPC에 연결한다.

- [ ] **Step 1: `package.json`에 스크립트 추가**

```bash
npm pkg set scripts.test:agent="node test/agent.test.js"
```

- [ ] **Step 2: 실패하는 테스트 작성 — `test/agent.test.js`**

이 테스트가 증명하는 것: **하나의 `claude.exe` 프로세스가 여러 턴에 걸쳐 살아있는가.** 스파이크(Task 1)는 stdin을 닫아 단일 턴만 확인했다. 실제 채팅은 프로세스를 계속 열어둬야 한다.

```js
// test/agent.test.js
// 실행: node test/agent.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgent } = require('../main/claude.js');

const MODEL = 'claude-haiku-4-5-20251001';

function turn(agent, waiters, text) {
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    agent.send(text);
  });
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cwd-'));
  const waiters = [];
  let deltas = '';

  const agent = createAgent({
    cwd,
    model: MODEL,
    onEvent: (evt) => {
      if (evt.type === 'text') deltas += evt.text;
      if (evt.type === 'done') waiters.shift()?.resolve(evt.result);
      if (evt.type === 'error') waiters.shift()?.reject(new Error(evt.text));
    },
  });

  const a = await turn(agent, waiters, 'Reply with exactly: ALPHA');
  assert.ok(a.includes('ALPHA'), `turn 1 result was: ${a}`);

  // 같은 프로세스에서 두 번째 턴. 프로세스가 죽었으면 여기서 멈춘다.
  const b = await turn(agent, waiters, 'Reply with exactly: BRAVO');
  assert.ok(b.includes('BRAVO'), `turn 2 result was: ${b}`);

  // 세 번째 턴에서 대화 맥락이 유지되는지 확인한다.
  const c = await turn(agent, waiters, 'What were the two words I asked you to say? List them.');
  assert.ok(/ALPHA/i.test(c) && /BRAVO/i.test(c), `context lost, turn 3 result: ${c}`);

  assert.ok(deltas.length > 0, 'no streaming text deltas were emitted');

  agent.stop();
  console.log('AGENT PASS');
}

main().catch((e) => {
  console.error('AGENT FAIL:', e.message);
  process.exit(1);
});
```

- [ ] **Step 3: 테스트 실행해서 실패 확인**

Run: `npm run test:agent`
Expected: FAIL — `Cannot find module '../main/claude.js'`

- [ ] **Step 4: `main/claude.js` 작성**

```js
// main/claude.js
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';

// claude.exe 는 기본으로 Bash/Edit/Read/PowerShell 을 들고 있다.
// 브라우저 어시스턴트에게 파일시스템과 셸 접근은 불필요하고 위험하다.
const BLOCKED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'PowerShell', 'WebFetch'];

function buildArgs({ mcpUrl, model, systemPrompt }) {
  const args = [
    '-p', '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--session-id', randomUUID(),
    '--setting-sources', '',
    '--disable-slash-commands',
    '--disallowedTools', ...BLOCKED_TOOLS,
  ];
  if (mcpUrl) {
    args.push(
      '--mcp-config',
      JSON.stringify({ mcpServers: { browser: { type: 'http', url: mcpUrl } } }),
      '--allowedTools', 'mcp__browser'
    );
  }
  if (model) args.push('--model', model);
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  return args;
}

function createAgent({ cwd, mcpUrl, model, systemPrompt, onEvent }) {
  const child = spawn(CLAUDE_BIN, buildArgs({ mcpUrl, model, systemPrompt }), {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) handleLine(line, onEvent);
    }
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString('utf8');
  });

  child.on('error', (e) => onEvent({ type: 'error', text: `spawn failed: ${e.message}` }));
  child.on('close', (code) => {
    if (code !== 0) {
      onEvent({ type: 'error', text: `claude exited ${code}: ${stderr.trim().slice(-500)}` });
    }
  });

  return {
    send(text) {
      child.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
      }) + '\n');
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

function handleLine(line, onEvent) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // NDJSON 이 아닌 줄은 무시한다
  }

  // --include-partial-messages 가 켜져 있으면 텍스트는 델타로 온다.
  if (msg.type === 'stream_event') {
    const d = msg.event?.delta;
    if (d?.type === 'text_delta' && d.text) onEvent({ type: 'text', text: d.text });
    return;
  }

  if (msg.type === 'assistant') {
    for (const c of msg.message?.content ?? []) {
      if (c.type === 'tool_use') onEvent({ type: 'tool', text: c.name });
    }
    return;
  }

  if (msg.type === 'result') {
    if (msg.is_error) onEvent({ type: 'error', text: String(msg.result ?? 'unknown error') });
    else onEvent({ type: 'done', result: String(msg.result ?? '') });
  }
}

module.exports = { createAgent, BLOCKED_TOOLS };
```

- [ ] **Step 5: 테스트 실행해서 통과 확인**

Run: `npm run test:agent`
Expected: `AGENT PASS`

세 번째 단언(맥락 유지)이 실패하면 `--session-id`가 턴마다 새로 생기고 있다는 뜻이다. `createAgent` 안에서 `randomUUID()`가 프로세스당 한 번만 호출되는지 확인한다.

- [ ] **Step 6: `main/index.js`의 echo 핸들러를 실제 에이전트로 교체**

`main/index.js`의 `if (require.main === module) { ... }` 블록 전체를 아래로 바꾼다:

```js
if (require.main === module) {
  const fs = require('node:fs');
  const { createAgent } = require('./claude.js');

  app.whenReady().then(() => {
    const { chatView } = createWindow();

    // 프로젝트 CLAUDE.md 가 에이전트 컨텍스트로 새지 않도록 빈 전용 디렉터리를 쓴다.
    const agentCwd = path.join(app.getPath('userData'), 'agent-cwd');
    fs.mkdirSync(agentCwd, { recursive: true });

    const emit = (evt) => {
      if (!chatView.webContents.isDestroyed()) {
        chatView.webContents.send('chat:event', evt);
      }
    };

    // mcpUrl 은 Task 5 에서 붙인다.
    const agent = createAgent({ cwd: agentCwd, onEvent: emit });

    ipcMain.on('chat:send', (_e, text) => agent.send(text));
    app.on('before-quit', () => agent.stop());
  });

  app.on('window-all-closed', () => app.quit());
}
```

파일 상단의 `require` 목록은 그대로 두고, `fs`와 `createAgent`는 위처럼 블록 안에서 `require` 한다 — 테스트가 `main/index.js`를 모듈로 불러올 때 `claude.exe`를 건드리지 않게 하기 위함이다.

- [ ] **Step 7: 눈으로 확인**

Run: `npm start`
Expected: 채팅에 "안녕"이라고 치면 응답이 **글자 단위로 흘러나온다.** 이어서 "방금 내가 뭐라고 했지?"라고 물으면 기억한다.

- [ ] **Step 8: 커밋**

```bash
git add main/claude.js main/index.js test/agent.test.js package.json
git commit -m "feat: wire claude.exe agent with streaming multi-turn chat"
```

---

## Task 4: CDP 브라우저 툴 6개

**Files:**
- Create: `main/tools.js`
- Test: `test/tools.test.js`
- Modify: `package.json` (scripts 추가)

**Interfaces:**
- Consumes: 없음 (Electron `WebContents` 객체 하나만 받는다)
- Produces:
  ```
  createTools(webContents) -> Promise<{
    navigate(url: string): Promise<string>,
    snapshot(): Promise<string>,
    click(ref: string): Promise<string>,
    type(ref: string, text: string): Promise<string>,
    readPage(): Promise<string>,
    wait(seconds: number): Promise<string>,
  }>
  ```
  모든 함수는 사람이 읽을 수 있는 문자열을 반환한다 — 그대로 MCP 툴 결과 텍스트가 된다. Task 5의 `main/mcp.js`가 이 6개를 등록한다.

- [ ] **Step 1: `package.json`에 스크립트 추가**

```bash
npm pkg set scripts.test:tools="electron test/tools.test.js"
```

- [ ] **Step 2: 실패하는 테스트 작성 — `test/tools.test.js`**

```js
// test/tools.test.js
// 실행: npx electron test/tools.test.js
const assert = require('node:assert');
const { app, BrowserWindow } = require('electron');

const PAGE = `
<!doctype html><meta charset="utf-8"><title>fixture</title>
<h1>Fixture Page</h1>
<input id="q" aria-label="search box" />
<button id="go">Run Search</button>
<div id="out">idle</div>
<script>
  document.getElementById('go').addEventListener('click', () => {
    document.getElementById('out').textContent =
      'RESULT:' + document.getElementById('q').value;
  });
</script>`;

const FIXTURE_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE);

async function main() {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800 });
  const { createTools } = require('../main/tools.js');
  const tools = await createTools(win.webContents);

  await tools.navigate(FIXTURE_URL);

  const snap = await tools.snapshot();
  console.log('--- snapshot ---\n' + snap + '\n---------------');

  const btn = snap.match(/\[ref=(\w+)\][^\n]*button[^\n]*Run Search/i);
  const box = snap.match(/\[ref=(\w+)\][^\n]*(textbox|searchbox)[^\n]*search box/i);
  assert.ok(btn, 'snapshot did not expose the button with a ref');
  assert.ok(box, 'snapshot did not expose the input with a ref');

  await tools.type(box[1], 'hello');
  await tools.click(btn[1]);
  await tools.wait(0.3);

  const text = await tools.readPage();
  assert.ok(text.includes('RESULT:hello'), `readPage missing click result:\n${text}`);
  assert.ok(text.includes('Fixture Page'), 'readPage missing heading');

  const stale = await tools.click('e9999');
  assert.match(stale, /stale ref/i, `expected stale-ref message, got: ${stale}`);

  console.log('TOOLS PASS');
  app.exit(0);
}

app.whenReady()
  .then(main)
  .catch((e) => {
    console.error('TOOLS FAIL:', e.stack || e.message);
    app.exit(1);
  });
```

- [ ] **Step 3: 테스트 실행해서 실패 확인**

Run: `npm run test:tools`
Expected: FAIL — `Cannot find module '../main/tools.js'`

- [ ] **Step 4: `main/tools.js` 작성**

```js
// main/tools.js
// CDP 로 페이지를 조작한다. MCP 도 Electron 창 구조도 모른다.
// webContents 하나만 받아서 순수 함수 묶음을 돌려준다.

// 에이전트가 상호작용할 수 있는 노드
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
  'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton',
]);

// 페이지 구조를 알려주는 노드 (ref 없이 텍스트만)
const LANDMARK = new Set([
  'heading', 'navigation', 'main', 'form', 'dialog', 'alert',
  'status', 'article', 'banner', 'contentinfo',
]);

const MAX_TEXT = 30000;

async function createTools(webContents) {
  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach('1.3');
  }
  const cdp = (method, params = {}) => webContents.debugger.sendCommand(method, params);

  await cdp('DOM.enable');
  await cdp('Runtime.enable');
  await cdp('Accessibility.enable');

  // ref -> backendDOMNodeId. snapshot() 마다 통째로 새로 만든다.
  let refs = new Map();

  async function resolve(ref) {
    const backendNodeId = refs.get(ref);
    if (backendNodeId === undefined) return null;
    try {
      const { object } = await cdp('DOM.resolveNode', { backendNodeId });
      return object.objectId;
    } catch {
      return null; // 노드가 DOM 에서 사라졌다
    }
  }

  async function callOn(objectId, fnDecl) {
    return cdp('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fnDecl,
      awaitPromise: true,
    });
  }

  async function navigate(url) {
    await webContents.loadURL(url);
    return `navigated to ${webContents.getURL()}`;
  }

  async function snapshot() {
    const { nodes } = await cdp('Accessibility.getFullAXTree');
    refs = new Map();
    const lines = [];
    let n = 0;

    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value;
      if (!role) continue;
      const name = (node.name?.value ?? '').trim();

      if (INTERACTIVE.has(role)) {
        if (node.backendDOMNodeId === undefined) continue;
        // 이름 없는 상호작용 노드는 에이전트가 지목할 수 없으므로 버린다
        if (!name) continue;
        const ref = 'e' + ++n;
        refs.set(ref, node.backendDOMNodeId);
        lines.push(`[ref=${ref}] ${role} ${JSON.stringify(name)}`);
      } else if (LANDMARK.has(role) && name) {
        lines.push(`          ${role} ${JSON.stringify(name)}`);
      }
    }

    if (!lines.length) return '(no interactive elements found; try read_page)';
    return `${webContents.getURL()}\n${lines.join('\n')}`;
  }

  // ponytail: el.click() 은 JS 클릭이다. 진짜 마우스 이벤트만 받는
  // 캔버스/드래그 UI 는 못 뚫는다. 막히면 DOM.getBoxModel +
  // Input.dispatchMouseEvent 좌표 경로를 추가한다.
  async function click(ref) {
    const objectId = await resolve(ref);
    if (!objectId) return `stale ref ${ref} — call snapshot again`;
    await callOn(objectId, 'function(){ this.scrollIntoView({block:"center"}); this.click(); }');
    return `clicked ${ref}`;
  }

  async function type(ref, text) {
    const objectId = await resolve(ref);
    if (!objectId) return `stale ref ${ref} — call snapshot again`;
    await callOn(objectId, 'function(){ this.scrollIntoView({block:"center"}); this.focus(); this.value=""; }');
    await cdp('Input.insertText', { text });
    return `typed ${JSON.stringify(text)} into ${ref}`;
  }

  async function readPage() {
    const { result } = await cdp('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    const text = String(result?.value ?? '');
    return text.length > MAX_TEXT
      ? text.slice(0, MAX_TEXT) + `\n… (truncated, ${text.length} chars total)`
      : text;
  }

  async function wait(seconds) {
    const ms = Math.min(Math.max(Number(seconds) || 0, 0), 30) * 1000;
    await new Promise((r) => setTimeout(r, ms));
    return `waited ${ms / 1000}s`;
  }

  return { navigate, snapshot, click, type, readPage, wait };
}

module.exports = { createTools };
```

- [ ] **Step 5: 테스트 실행해서 통과 확인**

Run: `npm run test:tools`
Expected: `TOOLS PASS`

스냅샷에 버튼/입력창이 안 나오면 콘솔에 찍힌 `--- snapshot ---` 블록을 보고 실제 role 이름을 확인한다. Chromium이 `<input>`에 `textbox`가 아닌 다른 role을 줄 수 있다 — 그 경우 `INTERACTIVE`에 추가한다. 테스트를 role에 맞추지 말고 `INTERACTIVE` 집합을 고친다.

- [ ] **Step 6: 커밋**

```bash
git add main/tools.js test/tools.test.js package.json
git commit -m "feat: add 6 CDP browser tools with ax-tree snapshot refs"
```

---

## Task 5: MCP 서버 + 전체 연결

**Files:**
- Create: `main/mcp.js`
- Modify: `main/index.js` (MCP 서버 기동 + `mcpUrl` 전달 + 시스템 프롬프트)

**Interfaces:**
- Consumes:
  - `createTools(webContents)` (Task 4)
  - `createAgent({ cwd, mcpUrl, systemPrompt, onEvent })` (Task 3)
  - `startPingServer`의 HTTP 부트스트랩 패턴 (Task 1)
- Produces: `startMcpServer(tools) -> Promise<{ url: string, close: () => void }>`

- [ ] **Step 1: `main/mcp.js` 작성**

```js
// main/mcp.js
// tools.js 의 함수 6개를 MCP 툴로 등록하고 localhost HTTP 로 노출한다.
// CDP 를 모른다 — tools 객체만 받는다.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });

async function startMcpServer(tools) {
  const server = new McpServer({ name: 'browser', version: '0.1.0' });

  server.registerTool('navigate', {
    description: 'Open a URL in the browser pane. Returns the final URL after redirects.',
    inputSchema: { url: z.string().describe('Absolute URL including scheme') },
  }, async ({ url }) => text(await tools.navigate(url)));

  server.registerTool('snapshot', {
    description:
      'List the interactive elements on the current page as [ref=eN] role "name" lines. ' +
      'Call this before click or type. Refs are invalidated by navigation.',
    inputSchema: {},
  }, async () => text(await tools.snapshot()));

  server.registerTool('click', {
    description: 'Click an element by its ref from the most recent snapshot.',
    inputSchema: { ref: z.string().describe('A ref like "e3" from snapshot') },
  }, async ({ ref }) => text(await tools.click(ref)));

  server.registerTool('type', {
    description: 'Clear a text field and type into it, by its ref from the most recent snapshot.',
    inputSchema: {
      ref: z.string().describe('A ref like "e7" from snapshot'),
      text: z.string().describe('Text to type'),
    },
  }, async ({ ref, text: value }) => text(await tools.type(ref, value)));

  server.registerTool('read_page', {
    description: 'Return the visible text of the current page. Use for reading and summarizing.',
    inputSchema: {},
  }, async () => text(await tools.readPage()));

  server.registerTool('wait', {
    description: 'Pause for N seconds to let the page settle after a click or navigation.',
    inputSchema: { seconds: z.number().describe('Seconds to wait, max 30') },
  }, async ({ seconds }) => text(await tools.wait(seconds)));

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (!req.url.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400).end();
          return;
        }
      }
      transport.handleRequest(req, res, body);
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  return { url: `http://127.0.0.1:${port}/mcp`, close: () => httpServer.close() };
}

module.exports = { startMcpServer };
```

- [ ] **Step 2: `main/index.js`의 부팅 블록을 최종형으로 교체**

`if (require.main === module) { ... }` 블록 전체를 아래로 바꾼다:

```js
if (require.main === module) {
  const fs = require('node:fs');
  const { createAgent } = require('./claude.js');
  const { createTools } = require('./tools.js');
  const { startMcpServer } = require('./mcp.js');

  const SYSTEM_PROMPT = [
    'You drive a web browser pane on behalf of the user. You are not a coding assistant.',
    'Your only tools are the browser tools; you have no filesystem or shell access.',
    '',
    'Workflow: navigate, then snapshot to see what is on the page, then click or type by ref.',
    'Refs come from the most recent snapshot and are invalidated by navigation — take a fresh',
    'snapshot after anything that changes the page. Use read_page to read or summarize content.',
    '',
    'Report what you did and what you found. Never claim a step succeeded without checking',
    'the page afterwards.',
  ].join('\n');

  app.whenReady().then(async () => {
    const { chatView, pageView } = createWindow();

    const tools = await createTools(pageView.webContents);
    const mcp = await startMcpServer(tools);

    const agentCwd = path.join(app.getPath('userData'), 'agent-cwd');
    fs.mkdirSync(agentCwd, { recursive: true });

    const emit = (evt) => {
      if (!chatView.webContents.isDestroyed()) {
        chatView.webContents.send('chat:event', evt);
      }
    };

    const agent = createAgent({
      cwd: agentCwd,
      mcpUrl: mcp.url,
      systemPrompt: SYSTEM_PROMPT,
      onEvent: emit,
    });

    ipcMain.on('chat:send', (_e, text) => agent.send(text));

    app.on('before-quit', () => {
      agent.stop();
      mcp.close();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
```

- [ ] **Step 3: 전체 흐름 확인 — 읽기**

Run: `npm start`
채팅 입력: `위키백과에서 "튜링 기계" 문서를 열고 첫 문단을 요약해줘`

Expected:
- 오른쪽 페이지가 실제로 위키백과로 이동한다
- 채팅에 `· mcp__browser__navigate`, `· mcp__browser__read_page` 같은 툴 줄이 뜬다
- 요약 텍스트가 흘러나온다

- [ ] **Step 4: 전체 흐름 확인 — 조작**

채팅 입력: `위키백과 검색창에 "폰 노이만"을 입력하고 검색해줘`

Expected:
- `snapshot` → `type` → `click` 순서로 툴 줄이 뜬다
- 오른쪽 페이지의 검색창에 실제로 글자가 들어가고 결과 페이지로 넘어간다

여기서 실패하면 스냅샷 출력이 문제일 가능성이 높다. `main/tools.js`의 `snapshot()` 반환값을 `console.log`로 찍어 에이전트가 무엇을 보고 있는지 확인한다.

- [ ] **Step 5: 커밋**

```bash
git add main/mcp.js main/index.js
git commit -m "feat: expose browser tools over MCP and connect agent end to end"
```

---

## Task 6: 보안 경계 검증

플래그를 걸었다는 것과 실제로 막힌다는 것은 다르다. 이 태스크는 코드를 거의 추가하지 않고, 차단이 작동함을 증명한다.

**Files:**
- Create: `test/security.test.js`
- Modify: `package.json` (scripts 추가)

**Interfaces:**
- Consumes: `createAgent`, `BLOCKED_TOOLS` (Task 3)
- Produces: 없음

- [ ] **Step 1: `package.json`에 스크립트 추가**

```bash
npm pkg set scripts.test:security="node test/security.test.js"
```

- [ ] **Step 2: 실패하는 테스트 작성 — `test/security.test.js`**

```js
// test/security.test.js
// 실행: node test/security.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgent, BLOCKED_TOOLS } = require('../main/claude.js');

const MODEL = 'claude-haiku-4-5-20251001';

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cwd-'));
  const canary = path.join(cwd, 'canary.txt');

  const toolsUsed = [];
  let done;
  const finished = new Promise((resolve, reject) => {
    done = { resolve, reject };
  });

  const agent = createAgent({
    cwd,
    model: MODEL,
    onEvent: (evt) => {
      if (evt.type === 'tool') toolsUsed.push(evt.text);
      if (evt.type === 'done') done.resolve(evt.result);
      if (evt.type === 'error') done.resolve('ERROR: ' + evt.text);
    },
  });

  agent.send(
    `Write the word CANARY into the file ${canary.replace(/\\/g, '/')} ` +
    `using whatever tool you have, then tell me if it worked.`
  );

  const result = await finished;
  agent.stop();

  // 1. 차단된 툴이 호출된 흔적이 없어야 한다
  for (const blocked of BLOCKED_TOOLS) {
    assert.ok(
      !toolsUsed.includes(blocked),
      `blocked tool ${blocked} was invoked. tools used: ${toolsUsed.join(', ')}`
    );
  }

  // 2. 파일이 실제로 생기지 않아야 한다 — 이게 진짜 경계다
  assert.ok(
    !fs.existsSync(canary),
    `SECURITY HOLE: agent wrote ${canary} despite --disallowedTools`
  );

  console.log('agent said:', result.slice(0, 300));
  console.log('SECURITY PASS');
}

main().catch((e) => {
  console.error('SECURITY FAIL:', e.message);
  process.exit(1);
});
```

- [ ] **Step 3: 테스트 실행**

Run: `npm run test:security`
Expected: `SECURITY PASS`

**실패했다면 실제 구멍이다. 여기서 멈추고 고친다.** `--disallowedTools`가 인자 배열에 제대로 펼쳐졌는지(`...BLOCKED_TOOLS`) 먼저 확인하고, 그래도 뚫리면 `--allowedTools mcp__browser`를 `mcpUrl` 유무와 무관하게 항상 전달하도록 `buildArgs`를 고친다.

- [ ] **Step 4: 전체 테스트를 한 번에 돌리는 스크립트 추가**

```bash
npm pkg set scripts.test="node test/agent.test.js && node test/security.test.js && electron test/shell.test.js && electron test/tools.test.js"
```

- [ ] **Step 5: 전체 테스트 실행**

Run: `npm test`
Expected: `AGENT PASS`, `SECURITY PASS`, `SHELL PASS`, `TOOLS PASS` 네 줄이 모두 나오고 exit 0

- [ ] **Step 6: 커밋**

```bash
git add test/security.test.js package.json
git commit -m "test: verify filesystem and shell tools are actually blocked"
```

---

## 완료 기준

- [ ] `npm test` 4개 전부 통과
- [ ] `npm start`로 창이 뜨고, "위키백과에서 X 찾아 요약해줘"가 실제로 동작
- [ ] 스펙 §9의 "이번에 안 하는 것"에 손대지 않았음

## 스펙 대비 커버리지

| 스펙 항목 | 태스크 |
|---|---|
| §2.1 에이전트 루프 미구현, claude.exe 사용 | Task 1, 3 |
| §2.2 Electron | Task 2 |
| §3 아키텍처 (프로세스 2개, CDP 인프로세스) | Task 2, 4, 5 |
| §3 데이터 흐름 (IPC → NDJSON → MCP → CDP) | Task 3, 5 |
| §4 툴 6개 | Task 4 |
| §4.1 AX 트리 스냅샷 + ref 수명 | Task 4 |
| §5 실행 인자, `--bare` 회피, 전용 cwd | Task 3, 5 |
| §6 보안 (툴 차단) | Task 3(구현), 6(검증) |
| §7 구현 순서 | Task 1–6 |
| §8 테스트 | Task 2, 3, 4, 6 |
