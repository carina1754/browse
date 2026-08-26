// main/index.js
const path = require('node:path');
const { BaseWindow, BrowserWindow, WebContentsView, Menu, screen } = require('electron');

const CHAT_WIDTH = 380;

// 창 크기가 바뀌는 경로는 'resize' 하나가 아니다. 최대화/복원/전체화면은
// 플랫폼에 따라 resize 를 안 흘리거나 전환이 끝난 뒤에야 흘린다. 하나라도
// 놓치면 뷰가 옛 크기로 남아서 창 안에 빈 띠가 생기거나 입력칸이 잘린다.
const RELAYOUT_EVENTS = [
  'resize', 'resized', 'move', 'maximize', 'unmaximize', 'restore',
  'enter-full-screen', 'leave-full-screen',
  'enter-html-full-screen', 'leave-html-full-screen',
];

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
    if (win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    // 창을 380px 보다 좁게 줄이면 페이지 폭이 음수가 된다. 음수 bounds 는
    // 뷰를 창 밖으로 밀어낸다 — 그때는 채팅만 보여주고 페이지를 접는다.
    const chatWidth = Math.min(CHAT_WIDTH, width);
    chatView.setBounds({ x: 0, y: 0, width: chatWidth, height });
    pageView.setBounds({ x: chatWidth, y: 0, width: Math.max(0, width - chatWidth), height });
  }
  layout();
  for (const e of RELAYOUT_EVENTS) win.on(e, layout);

  // 다른 배율의 모니터로 옮기거나 디스플레이 설정을 바꾸면 창 크기(DIP)가
  // 그대로여도 클라이언트 영역이 달라진다. 창 이벤트로는 안 잡히는 경로다.
  screen.on('display-metrics-changed', layout);
  win.on('closed', () => screen.removeListener('display-metrics-changed', layout));

  chatView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'chat.html'));

  return { win, chatView, pageView };
}

// 설정은 채팅 사이드바 안이 아니라 별도 창이다. 항목이 계속 늘어날 자리라
// 380px 패널에 접어 넣으면 금방 스크롤 지옥이 된다.
// 창은 하나만 둔다 — ⚙ 를 여러 번 눌러도 같은 창을 앞으로 가져온다.
let settingsWin = null;

function openSettingsWindow(parent) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 640,
    title: '설정',
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    show: false,
    backgroundColor: '#1e1e1e', // 흰 화면이 한 번 번쩍이는 걸 막는다
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
  return settingsWin;
}

module.exports = { createWindow, openSettingsWindow, CHAT_WIDTH, RELAYOUT_EVENTS };
