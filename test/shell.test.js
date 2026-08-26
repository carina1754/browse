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
