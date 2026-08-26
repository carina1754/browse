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
const { checkAll, install, claudeBin } = require('./deps.js');
const {
  loadSettings, saveSettings, buildSystemPrompt, buildEnv, enabled,
  isHeadroomUp, headroomUrl,
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

  const emit = (evt) => {
    if (!chatView.webContents.isDestroyed()) {
      chatView.webContents.send('chat:event', evt);
    }
  };
  const note = (text) => emit({ type: 'tool', text });

  // 프로젝트 CLAUDE.md 가 에이전트 컨텍스트로 새지 않도록 빈 전용 디렉터리를 쓴다.
  const agentCwd = path.join(app.getPath('userData'), 'agent-cwd');
  fs.mkdirSync(agentCwd, { recursive: true });

  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  let settings = loadSettings(settingsFile);

  // createWindow() 가 이미 chat.html 로딩을 시작했다. 페이지 스크립트는 아래 await
  // 들보다 먼저 돈다 — 그래서 IPC 핸들러를 await 뒤에 등록하면 렌더러의 첫
  // settings:get 이 "No handler registered" 로 죽는다. 등록을 먼저 한다.
  let agent = null;
  let mcp = null;
  let bootError = null;

  async function doStart() {
    if (!mcp) {
      // 부팅이 깨졌으면 여기서 조용히 돌아가면 안 된다. 원인을 말해준다.
      if (bootError) emit({ type: 'error', text: `브라우저 도구를 못 띄웠다: ${bootError}. 앱을 재시작해라.` });
      return;
    }

    if (agent) {
      agent.stop();
      agent = null;
    }

    // 이름이 아니라 {command, args} 다. npm -g 설치라 claude.cmd 밖에 없으면
    // 여기서 node + cli.js 로 풀려서 나온다 (main/deps.js 의 toSpawnable).
    const bin = await claudeBin();
    if (!bin) {
      emit({ type: 'error', text: 'Claude Code 실행 파일을 찾을 수 없다. ⚙ 에서 설치해라.' });
      return;
    }

    let active = settings;
    if (enabled(settings, 'headroom') && !(await isHeadroomUp())) {
      // 프록시가 없는데 그리로 보내면 모든 요청이 죽는다. 증상은 "AI 가 응답을
      // 안 한다"로만 보여서 원인을 찾기 어렵다. 이번 실행만 라우팅을 뺀다.
      emit({
        type: 'error',
        text: `headroom 이 ${headroomUrl()} 에 없다. headroom 없이 띄운다. 켜려면 터미널에서: headroom serve`,
      });
      active = { ...settings, modes: { ...settings.modes, headroom: false } };
    }

    const { prompt, attached, failed } = buildSystemPrompt(SYSTEM_PROMPT, active);

    // 설치돼 있다고 나왔는데 SKILL.md 를 못 찾은 경우. 조용히 빼면 UI 는 켜졌다고
    // 표시하고 사용자는 아무 동작 변화도 못 본다.
    for (const name of failed) {
      emit({ type: 'error', text: `${name} 모드를 못 불러왔다 (SKILL.md 없음). 이번 실행에서 빠진다.` });
    }

    agent = createAgent({
      cwd: agentCwd,
      mcpUrl: mcp.url,
      systemPrompt: prompt,
      env: buildEnv(active),
      bin,
      onEvent: emit,
    });

    // 배지는 "켜달라고 한 것"이 아니라 "실제로 걸린 것"을 보여줘야 한다.
    // headroom 이 자동으로 빠지거나 SKILL.md 를 못 찾으면 둘이 어긋난다.
    const live = [...attached];
    if (enabled(active, 'headroom')) live.unshift('headroom');
    emit({ type: 'modes', modes: live });
    note(`에이전트 시작${live.length ? ` — 토큰 절약: ${live.join(', ')}` : ''}`);
  }

  // 토글을 빠르게 두 번 누르면 doStart 가 겹친다. 첫 호출이 await isHeadroomUp()
  // 에서 양보하는 사이 두 번째가 들어와 둘 다 agent 를 새로 만들고, 먼저 만든
  // 자식은 추적에서 빠져 종료도 안 된다. 직렬화한다.
  let queue = Promise.resolve();
  function startAgent() {
    queue = queue.then(doStart, doStart);
    return queue;
  }

  ipcMain.on('chat:send', (_e, text) => {
    if (!agent) {
      emit({
        type: 'error',
        text: bootError
          ? `에이전트가 안 떠 있다: ${bootError}`
          : '에이전트가 안 떠 있다. ⚙ 에서 Claude Code 를 설치해라.',
      });
      return;
    }
    agent.send(text);
  });

  ipcMain.handle('deps:check', () => checkAll());

  ipcMain.handle('deps:install', async (_e, name) => {
    note(`설치 시작: ${name}`);
    const res = await install(name, (line) => note(`  ${line}`));
    if (res.ok) note(`설치 완료: ${name} — ${res.detail}`);
    else emit({ type: 'error', text: `설치 ${res.needsRestart ? '주의' : '실패'}: ${name} — ${res.detail}` });
    // claude 가 방금 들어왔으면 이제 에이전트를 띄울 수 있다.
    if (res.ok && name === 'claude' && !agent) await startAgent();
    return res;
  });

  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:set', async (_e, next) => {
    // saveSettings 가 모양을 정리한다 — 렌더러가 보낸 걸 그대로 믿지 않는다.
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

  try {
    const tools = await createTools(pageView.webContents);
    mcp = await startMcpServer(tools);
  } catch (e) {
    bootError = e.message;
    console.error('boot failed:', e);
    emit({ type: 'error', text: `부팅 실패: ${e.message}. 앱을 재시작해라.` });
    return;
  }

  // claude.exe 가 없으면 에이전트를 띄울 수 없다. 앱은 그대로 살려두고
  // 설정 패널에서 설치할 수 있게 안내만 한다.
  const deps = await checkAll();
  const missing = deps.filter((d) => !d.ok);
  const claude = deps.find((d) => d.name === 'claude');

  if (!claude || !claude.ok) {
    emit({ type: 'error', text: 'Claude Code 가 없다. 오른쪽 위 ⚙ 에서 설치해라.' });
    return;
  }
  if (missing.length) {
    note(`설치 안 된 선택 도구: ${missing.map((d) => d.name).join(', ')} — ⚙ 에서 설치 가능`);
  }
  await startAgent();
}).catch((e) => console.error('boot failed:', e));

app.on('window-all-closed', () => app.quit());
