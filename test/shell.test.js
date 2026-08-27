// test/shell.test.js
// 실행: npx electron test/shell.test.js
const assert = require('node:assert');
const { app } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { createWindow, openSettingsWindow, TABS_WIDTH, STATUS_HEIGHT } = require('../main/index.js');
  const { win, chatView, statusView, tabsView, tabs } = createWindow();

  // 탭 줄 + 상태 줄 + 대화 탭.
  assert.strictEqual(win.contentView.children.length, 3, 'expected 3 child views at start');

  // 세 영역이 창을 정확히 덮는다. 창 크기가 바뀌는 경로마다 다시 확인한다 —
  // 'resize' 만 걸려 있던 시절엔 최대화/전체화면에서 옛 크기로 남았다.
  const fits = (tag) => {
    const content = win.getContentBounds();
    const status = statusView.getBounds();
    const strip = tabsView.getBounds();
    const body = chatView.getBounds(); // 탭 내용은 전부 같은 사각형을 쓴다

    const statusHeight = Math.min(STATUS_HEIGHT, content.height);
    const stripWidth = Math.min(TABS_WIDTH, content.width);

    // 상태 줄은 맨 아래 가로 전체 — 탭 줄 옆이 아니라 탭 줄까지 덮는다.
    assert.deepStrictEqual(
      { x: status.x, y: status.y, width: status.width, height: status.height },
      { x: 0, y: content.height - statusHeight, width: content.width, height: statusHeight },
      `${tag}: status bar must span the full width at the bottom`,
    );
    assert.deepStrictEqual(
      { x: strip.x, y: strip.y, width: strip.width, height: strip.height },
      { x: 0, y: 0, width: stripWidth, height: content.height - statusHeight },
      `${tag}: tab strip must fill the left column above the status bar`,
    );
    assert.deepStrictEqual(
      { x: body.x, y: body.y, width: body.width, height: body.height },
      {
        x: stripWidth,
        y: 0,
        width: Math.max(0, content.width - stripWidth),
        height: content.height - statusHeight,
      },
      `${tag}: tab content must fill what is left`,
    );
  };

  fits('start');

  win.setContentSize(1000, 700); await wait(300); fits('setContentSize');
  win.maximize(); await wait(800); fits('maximize');
  win.unmaximize(); await wait(800); fits('unmaximize');
  win.setFullScreen(true); await wait(1500); fits('fullscreen');
  win.setFullScreen(false); await wait(1500); fits('unfullscreen');

  // 창이 탭 줄보다 좁아져도 음수 bounds 가 나오면 안 된다.
  win.setContentSize(150, 500); await wait(400); fits('narrow');
  assert.strictEqual(chatView.getBounds().width, 0, 'narrow: tab content must collapse, not go negative');

  win.setContentSize(1000, 700); await wait(300);

  // --- 탭 -------------------------------------------------------------------
  const opened = tabs.open('about:blank');
  assert.strictEqual(tabs.list().length, 2, '새 탭이 목록에 없다');
  assert.ok(tabs.list()[1].active, '새로 연 탭이 활성이어야 한다');
  assert.ok(!tabs.list()[0].closable, '대화 탭은 닫을 수 없어야 한다');
  fits('after open');

  tabs.select('chat');
  assert.ok(tabs.list()[0].active, '대화 탭으로 못 돌아왔다');

  tabs.close('chat');
  assert.strictEqual(tabs.list().length, 2, '대화 탭이 닫혔다');

  tabs.close(opened.id);
  assert.strictEqual(tabs.list().length, 1, '탭이 안 닫혔다');

  // 도구용 페이지는 없으면 만든다. 단, 보고 있던 화면을 바꾸면 안 된다.
  const wc = tabs.pageContents();
  assert.ok(wc, 'pageContents() must hand back a webContents');
  assert.strictEqual(tabs.list().length, 2, 'pageContents() 가 탭을 안 만들었다');
  assert.ok(tabs.list()[0].active, '도구용 탭을 만들면서 화면을 바꿨다');
  assert.strictEqual(tabs.pageContents(), wc, 'pageContents() 가 매번 새 탭을 만든다');

  // 설정 창은 하나만 뜬다. 닫은 뒤에 다시 열면 새로 뜬다.
  const s1 = openSettingsWindow(win);
  assert.strictEqual(openSettingsWindow(win), s1, '설정 창이 두 개 떴다');
  // 계정 칸이 실제로 그려지는지. account:get 핸들러는 이 하네스에 없어서
  // (main/app.js 를 안 띄운다) 렌더러가 실패 경로로 들어간다 — 그래도 칸은 떠야 한다.
  await new Promise((r) => s1.webContents.once('did-finish-load', r));
  await wait(300);
  const text = await s1.webContents.executeJavaScript('document.body.innerText');
  for (const want of ['계정', '설정을 못 읽었다']) {
    assert.ok(text.includes(want), `설정 창에 "${want}" 칸이 없다: ${text.slice(0, 120)}`);
  }
  s1.destroy();
  const s2 = openSettingsWindow(win);
  assert.notStrictEqual(s2, s1, '닫힌 설정 창을 다시 쓰려 했다');
  s2.destroy();

  console.log('SHELL PASS');
  app.exit(0);
}).catch((e) => {
  console.error('SHELL FAIL:', e.message);
  app.exit(1);
});
