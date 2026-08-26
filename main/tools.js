// main/tools.js
// CDP 로 페이지를 조작한다. MCP 도 Electron 창 구조도 모른다.
// webContents 하나만 받아서 순수 함수 묶음을 돌려준다.

// 에이전트가 상호작용할 수 있는 노드
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
  'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton',
]);

// 페이지 구조를 알려주는 노드 (ref 없이 텍스트만)
const LANDMARK = new Set([
  'heading', 'navigation', 'main', 'form', 'dialog', 'alert',
  'status', 'article', 'banner', 'contentinfo',
]);

const MAX_TEXT = 30000;

async function createTools(webContents) {
  // ponytail: CDP 도메인 enable 커맨드는 webContents 가 한 번도 navigate 한 적
  // 없으면(getURL() === '') 영원히 응답하지 않는다 (실측: Browser.getVersion 같은
  // 브라우저-레벨 커맨드는 즉시 응답하지만 DOM.enable 은 무한 대기, about:blank 를
  // 한 번 로드한 뒤에는 즉시 응답함 — Electron 44 / Chrome 152 CDP 세션이 프레임에
  // 붙기 전이라 그런 것으로 보임). 실제 앱에서는 main/index.js 가 pageView 를
  // about:blank 로 미리 로드해두므로 문제없지만, 방어적으로 한 번 더 확인한다.
  if (!webContents.getURL()) {
    await webContents.loadURL('about:blank');
  }

  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach('1.3');
  }
  const cdp = (method, params = {}) => webContents.debugger.sendCommand(method, params);

  await cdp('DOM.enable');
  await cdp('Runtime.enable');
  await cdp('Accessibility.enable');

  // ref -> backendDOMNodeId. snapshot() 마다 통째로 새로 만든다.
  let refs = new Map();

  async function resolve(ref) {
    const backendNodeId = refs.get(ref);
    if (backendNodeId === undefined) return null;
    try {
      const { object } = await cdp('DOM.resolveNode', { backendNodeId });
      return object.objectId;
    } catch {
      return null; // 노드가 DOM 에서 사라졌다
    }
  }

  async function callOn(objectId, fnDecl) {
    return cdp('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fnDecl,
      awaitPromise: true,
    });
  }

  async function navigate(url) {
    await webContents.loadURL(url);
    return `navigated to ${webContents.getURL()}`;
  }

  async function snapshot() {
    const { nodes } = await cdp('Accessibility.getFullAXTree');
    refs = new Map();
    const lines = [];
    let n = 0;

    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value;
      if (!role) continue;
      const name = (node.name?.value ?? '').trim();

      if (INTERACTIVE.has(role)) {
        if (node.backendDOMNodeId === undefined) continue;
        // 이름 없는 상호작용 노드는 에이전트가 지목할 수 없으므로 버린다
        if (!name) continue;
        const ref = 'e' + ++n;
        refs.set(ref, node.backendDOMNodeId);
        lines.push(`[ref=${ref}] ${role} ${JSON.stringify(name)}`);
      } else if (LANDMARK.has(role) && name) {
        lines.push(`          ${role} ${JSON.stringify(name)}`);
      }
    }

    if (!lines.length) return '(no interactive elements found; try read_page)';
    return `${webContents.getURL()}\n${lines.join('\n')}`;
  }

  // ponytail: el.click() 은 JS 클릭이다. 진짜 마우스 이벤트만 받는
  // 캔버스/드래그 UI 는 못 뚫는다. 막히면 DOM.getBoxModel +
  // Input.dispatchMouseEvent 좌표 경로를 추가한다.
  async function click(ref) {
    const objectId = await resolve(ref);
    if (!objectId) return `stale ref ${ref} — call snapshot again`;
    await callOn(objectId, 'function(){ this.scrollIntoView({block:"center"}); this.click(); }');
    return `clicked ${ref}`;
  }

  async function type(ref, text) {
    const objectId = await resolve(ref);
    if (!objectId) return `stale ref ${ref} — call snapshot again`;
    await callOn(objectId, 'function(){ this.scrollIntoView({block:"center"}); this.focus(); this.value=""; }');
    await cdp('Input.insertText', { text });
    return `typed ${JSON.stringify(text)} into ${ref}`;
  }

  async function readPage() {
    const { result } = await cdp('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    const text = String(result?.value ?? '');
    return text.length > MAX_TEXT
      ? text.slice(0, MAX_TEXT) + `\n… (truncated, ${text.length} chars total)`
      : text;
  }

  async function wait(seconds) {
    const ms = Math.min(Math.max(Number(seconds) || 0, 0), 30) * 1000;
    await new Promise((r) => setTimeout(r, ms));
    return `waited ${ms / 1000}s`;
  }

  return { navigate, snapshot, click, type, readPage, wait };
}

module.exports = { createTools };
