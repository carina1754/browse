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
//
// 주의: 이 Electron 버전(44)에서는 package.json의 main 필드로 이 파일이
// 로드될 때도 require.main이 이 모듈이 아니라 Electron 내부 모듈을 가리킨다
// (require.main.id === 'electron'), 즉 require.main === module은 `npm start`로
// 실행해도 항상 false다 — 이 조건만으로는 앱이 절대 부팅되지 않는다.
// module.parent는 이 파일이 다른 모듈에 의해 require()된 경우에만 설정되므로
// (테스트가 require('../main/index.js') 할 때), !module.parent로 "직접
// 엔트리로 로드됨"을 판별해 보강한다.
if (require.main === module || !module.parent) {
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
