// main/app.js
// Electron app entry point (package.json "main"). Boots the window and
// registers the chat IPC handler. main/index.js stays side-effect-free so
// test/shell.test.js can require it without booting the app.
const path = require('node:path');
const fs = require('node:fs');
const { app, ipcMain } = require('electron');
const { createWindow } = require('./index.js');
const { createTools } = require('./tools.js');
const { startMcpServer } = require('./mcp.js');
const { createAgent } = require('./claude.js');
const { checkAll, install } = require('./deps.js');
const {
  loadSettings, saveSettings, buildSystemPrompt, buildEnv, enabled, isHeadroomUp,
  HEADROOM_DEFAULT_PORT,
} = require('./modes.js');

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

  // 프로젝트 CLAUDE.md 가 에이전트 컨텍스트로 새지 않도록 빈 전용 디렉터리를 쓴다.
  const agentCwd = path.join(app.getPath('userData'), 'agent-cwd');
  fs.mkdirSync(agentCwd, { recursive: true });

  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  let settings = loadSettings(settingsFile);

  const emit = (evt) => {
    if (!chatView.webContents.isDestroyed()) {
      chatView.webContents.send('chat:event', evt);
    }
  };
  const note = (text) => emit({ type: 'tool', text });

  // createWindow() 가 이미 chat.html 로딩을 시작했다. 페이지 스크립트는 아래 await
  // 들보다 먼저 돈다 — 그래서 IPC 핸들러를 await 뒤에 등록하면 렌더러의 첫
  // settings:get 이 "No handler registered" 로 죽는다. 등록을 먼저 한다.
  let agent = null;
  let mcp = null;

  // 모드가 바뀌면 에이전트를 다시 띄운다. 시스템 프롬프트와 env 는 spawn 시점에
  // 굳는 값이라 살아 있는 프로세스에 밀어 넣을 방법이 없다. 대화는 초기화된다.
  async function startAgent() {
    if (!mcp) return; // MCP 가 아직이면 bootAgent 가 곧 부른다
    if (agent) {
      agent.stop();
      agent = null;
    }

    let active = settings;
    if (enabled(settings, 'headroom') && !(await isHeadroomUp())) {
      // 프록시가 없는데 그리로 보내면 모든 요청이 죽는다. 증상은 "AI 가 응답을
      // 안 한다"로만 보여서 원인을 찾기 어렵다. 이번 실행만 라우팅을 뺀다.
      emit({
        type: 'error',
        text: `headroom 이 127.0.0.1:${HEADROOM_DEFAULT_PORT} 에 없다. headroom 없이 띄운다. 켜려면 터미널에서: headroom serve`,
      });
      active = { ...settings, modes: { ...settings.modes, headroom: false } };
    }

    agent = createAgent({
      cwd: agentCwd,
      mcpUrl: mcp.url,
      systemPrompt: buildSystemPrompt(SYSTEM_PROMPT, active),
      env: buildEnv(active),
      onEvent: emit,
    });

    const on = Object.keys(active.modes).filter((m) => enabled(active, m));
    note(`에이전트 시작${on.length ? ` — 토큰 절약: ${on.join(', ')}` : ''}`);
  }

  ipcMain.on('chat:send', (_e, text) => {
    if (!agent) {
      emit({ type: 'error', text: '에이전트가 안 떠 있다. ⚙ 에서 Claude Code 를 설치해라.' });
      return;
    }
    agent.send(text);
  });

  ipcMain.handle('deps:check', () => checkAll());

  ipcMain.handle('deps:install', async (_e, name) => {
    note(`설치 시작: ${name}`);
    const res = await install(name, (line) => note(`  ${line}`));
    note(`설치 ${res.ok ? '완료' : '실패'}: ${name} — ${res.detail}`);
    // claude 가 방금 들어왔으면 이제 에이전트를 띄울 수 있다.
    if (res.ok && name === 'claude' && !agent) await startAgent();
    return res;
  });

  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:set', async (_e, next) => {
    settings = saveSettings(settingsFile, next);
    if (agent) {
      note('설정 변경 — 에이전트 재시작. 지금까지 대화는 초기화된다.');
      await startAgent();
    }
    return settings;
  });

  app.on('before-quit', () => {
    if (agent) agent.stop();
    if (mcp) mcp.close();
  });

  const tools = await createTools(pageView.webContents);
  mcp = await startMcpServer(tools);

  // claude.exe 가 없으면 에이전트를 띄울 수 없다. 앱은 그대로 살려두고
  // 설정 패널에서 설치할 수 있게 안내만 한다.
  async function bootAgent() {
    const deps = await checkAll();
    const missing = deps.filter((d) => !d.ok);
    const claude = deps.find((d) => d.name === 'claude');

    if (!claude.ok) {
      emit({ type: 'error', text: 'Claude Code 가 없다. 오른쪽 위 ⚙ 에서 설치해라.' });
      return;
    }
    if (missing.length) {
      note(`설치 안 된 선택 도구: ${missing.map((d) => d.name).join(', ')} — ⚙ 에서 설치 가능`);
    }
    await startAgent();
  }

  await bootAgent();
}).catch((e) => console.error('boot failed:', e));

app.on('window-all-closed', () => app.quit());
