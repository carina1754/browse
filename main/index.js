// main/index.js
const path = require('node:path');
const { BaseWindow, WebContentsView } = require('electron');

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

  return { win, chatView, pageView };
}

module.exports = { createWindow, CHAT_WIDTH };
