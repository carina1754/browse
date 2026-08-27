// main/tabs.js
// 탭 목록과 각 탭의 뷰. 어떤 탭이 보이는지도 여기서 정한다.
// 배치(bounds)는 여기서 안 한다 — main/index.js 의 layout() 이 창 크기를 안다.
// 첫 번째 탭은 AI 대화 탭이고 닫을 수 없다. 나머지는 진짜 웹 페이지다.
const { WebContentsView } = require('electron');

const CHAT_ID = 'chat';
const BLANK = 'about:blank';

// 주소창(nav 'go')과 window.open 둘 다 이 검사를 거친다. main 프로세스의
// loadURL 은 file:// 도 그대로 열어주는 특권 경로다 — 페이지가 준 URL 로
// 로컬 디스크를 숨은 탭에 열고 에이전트 도구가 그걸 읽는 체인을 여기서 끊는다.
const httpish = (u) => typeof u === 'string'
  && (u.toLowerCase().startsWith('http://') || u.toLowerCase().startsWith('https://'));

function createTabs({ win, chatView, onChange, onLayout }) {
  const tabs = [{ id: CHAT_ID, title: 'AI 대화', url: '', favicon: '', view: chatView }];
  let activeId = CHAT_ID;
  let seq = 0;
  // 에이전트가 조작할 탭. 사용자가 대화 탭을 보고 있어도 브라우저 도구는
  // 어딘가에서 돌아야 한다 — 마지막으로 쓴 페이지 탭을 그대로 쓴다.
  let pageId = null;

  const find = (id) => tabs.find((t) => t.id === id);

  function list() {
    return tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      favicon: t.favicon,
      active: t.id === activeId,
      closable: t.id !== CHAT_ID,
      canBack: t.id !== CHAT_ID && t.view.webContents.navigationHistory.canGoBack(),
      canForward: t.id !== CHAT_ID && t.view.webContents.navigationHistory.canGoForward(),
    }));
  }

  const changed = () => onChange(list());

  function select(id) {
    if (!find(id)) return;
    activeId = id;
    if (id !== CHAT_ID) pageId = id;
    for (const t of tabs) t.view.setVisible(t.id === activeId);
    onLayout(); // 숨어 있는 동안 창 크기가 바뀌었을 수 있다
    changed();
  }

  function open(url = BLANK, { show = true } = {}) {
    const view = new WebContentsView();
    const tab = { id: 'tab' + ++seq, title: '새 탭', url, favicon: '', view };
    tabs.push(tab);
    win.contentView.addChildView(view);
    view.setVisible(false);

    const wc = view.webContents;
    wc.on('page-title-updated', (_e, title) => { tab.title = title; changed(); });
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || ''; changed(); });
    const moved = () => { tab.url = wc.getURL(); changed(); };
    // 다른 사이트로 갔는데 앞 사이트 파비콘이 남아 있으면 안 된다.
    // 같은 문서 안 이동(did-navigate-in-page)은 아이콘이 그대로다.
    wc.on('did-navigate', () => { tab.favicon = ''; moved(); });
    wc.on('did-navigate-in-page', moved);
    // target=_blank / window.open 은 별도 창이 아니라 새 탭이어야 한다.
    // deny 안 하면 Electron 이 우리가 모르는 BrowserWindow 를 하나 띄운다.
    wc.setWindowOpenHandler(({ url: next }) => {
      if (httpish(next)) open(next, { show: false });
      return { action: 'deny' };
    });
    wc.loadURL(url);

    pageId = tab.id;
    if (show) select(tab.id);
    else { onLayout(); changed(); }
    return tab;
  }

  function close(id) {
    if (id === CHAT_ID) return; // 대화 탭은 닫을 수 없다
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = tabs.splice(i, 1);
    win.contentView.removeChildView(t.view);
    t.view.webContents.close();
    if (pageId === id) pageId = tabs.find((x) => x.id !== CHAT_ID)?.id ?? null;
    if (activeId === id) select(tabs[Math.min(i, tabs.length - 1)].id);
    else changed();
  }

  // 도구 줄(toolbar.html)의 뒤/앞/새로고침/주소창. 활성 페이지 탭에만 듣는다.
  // 'go' 는 http/https 만 받는다 (httpish) — 렌더러가 주는 문자열이다.
  function nav(action, url) {
    const t = find(activeId);
    if (!t || t.id === CHAT_ID) return;
    const wc = t.view.webContents;
    if (action === 'back') wc.navigationHistory.goBack();
    else if (action === 'forward') wc.navigationHistory.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'go' && httpish(url)) wc.loadURL(url).catch(() => {});
  }

  // 에이전트용 페이지. 부팅 직후엔 대화 탭밖에 없으므로 여기서 하나 만든다.
  // 화면은 안 바꾼다 — 사용자가 대화창을 보고 있는데 탭이 튀면 안 된다.
  function pageContents() {
    const t = find(pageId) ?? tabs.find((x) => x.id !== CHAT_ID) ?? open(BLANK, { show: false });
    return t.view.webContents;
  }

  return {
    list,
    open,
    close,
    select,
    nav,
    pageContents,
    views: () => tabs.map((t) => t.view),
    CHAT_ID,
  };
}

module.exports = { createTabs, CHAT_ID };
