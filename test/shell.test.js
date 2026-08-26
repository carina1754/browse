// test/shell.test.js
// 실행: npx electron test/shell.test.js
const assert = require('node:assert');
const { app } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { createWindow, openSettingsWindow, CHAT_WIDTH } = require('../main/index.js');
  const { win, chatView, pageView } = createWindow();

  assert.strictEqual(win.contentView.children.length, 2, 'expected 2 child views');

  // 두 뷰가 창을 정확히 덮는다. 창 크기가 바뀌는 경로마다 다시 확인한다 —
  // 'resize' 만 걸려 있던 시절엔 최대화/전체화면에서 옛 크기로 남았다.
  const fits = (tag) => {
    const chat = chatView.getBounds();
    const page = pageView.getBounds();
    const content = win.getContentBounds();
    assert.strictEqual(chat.x, 0, `${tag}: chat view must start at x=0`);
    assert.strictEqual(page.x, chat.width, `${tag}: page view must start where chat ends`);
    assert.strictEqual(chat.width + page.width, content.width, `${tag}: views must fill window width`);
    assert.strictEqual(chat.height, content.height, `${tag}: chat view must fill height`);
    assert.strictEqual(page.height, content.height, `${tag}: page view must fill height`);
  };

  fits('start');
  assert.strictEqual(chatView.getBounds().width, CHAT_WIDTH, `chat view width must be ${CHAT_WIDTH}`);

  win.setContentSize(1000, 700); await wait(300); fits('setContentSize');
  win.maximize(); await wait(800); fits('maximize');
  win.unmaximize(); await wait(800); fits('unmaximize');
  win.setFullScreen(true); await wait(1500); fits('fullscreen');
  win.setFullScreen(false); await wait(1500); fits('unfullscreen');

  // 창이 채팅 폭보다 좁아져도 음수 bounds 가 나오면 안 된다.
  win.setContentSize(300, 500); await wait(400); fits('narrow');
  assert.strictEqual(pageView.getBounds().width, 0, 'narrow: page view must collapse, not go negative');

  // 설정 창은 하나만 뜬다. 닫은 뒤에 다시 열면 새로 뜬다.
  const s1 = openSettingsWindow(win);
  assert.strictEqual(openSettingsWindow(win), s1, '설정 창이 두 개 떴다');
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
