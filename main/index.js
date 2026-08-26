// main/index.js
const path = require('node:path');
const { BaseWindow, WebContentsView, Menu } = require('electron');

const CHAT_WIDTH = 380;

function createWindow() {
  // 기본 메뉴(File/Edit/View/Window)를 지운다. 두 가지 이유가 있다.
  // 1. AI 작업창이라 그 메뉴들이 하는 일이 없다.
  // 2. 진짜 이유: 메뉴바는 클라이언트 영역을 약 21px 밀어내는데
  //    getContentBounds() 는 그걸 모르고 밀리기 전 높이를 그대로 보고한다.
  //    그 높이로 뷰를 깔면 아래쪽 21px 가 화면 밖으로 나가서 채팅 입력칸이 잘린다.
  Menu.setApplicationMenu(null);

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
