// main/tools.js
// CDP 로 페이지를 조작한다. MCP 도 Electron 창 구조도 모른다.
// 활성 탭의 webContents 를 돌려주는 함수 하나만 받는다 — 탭이 바뀌면 다음
// 호출부터 새 탭에 붙는다. 어떤 탭이 활성인지는 여기서 정하지 않는다.

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

async function createTools(getWebContents) {
  // ponytail: CDP 도메인 enable 커맨드는 webContents 가 한 번도 navigate 한 적
  // 없으면(getURL() === '') 영원히 응답하지 않는다 (실측: Browser.getVersion 같은
  // 브라우저-레벨 커맨드는 즉시 응답하지만 DOM.enable 은 무한 대기, about:blank 를
  // 한 번 로드한 뒤에는 즉시 응답함 — Electron 44 / Chrome 152 CDP 세션이 프레임에
  // 붙기 전이라 그런 것으로 보임). 그래서 새로 연 탭도 about:blank 를 먼저 태운다.
  async function setup(target) {
    if (!target.getURL()) await target.loadURL('about:blank');
    if (!target.debugger.isAttached()) target.debugger.attach('1.3');
    await target.debugger.sendCommand('DOM.enable');
    await target.debugger.sendCommand('Runtime.enable');
    await target.debugger.sendCommand('Accessibility.enable');
  }

  // 탭마다 한 번만 붙인다. 플래그가 아니라 약속을 담아두는 이유는 경합 때문이다 —
  // 플래그면 두 번째 호출이 enable 이 끝나기도 전에 "붙었다"고 보고 지나간다.
  const ready = new WeakMap();
  function wc() {
    const target = getWebContents();
    let p = ready.get(target);
    if (!p) {
      p = setup(target);
      ready.set(target, p);
    }
    return p.then(() => target);
  }

  const cdp = async (method, params = {}) => (await wc()).debugger.sendCommand(method, params);

  // 부팅 때 한 번 붙여둔다. 여기서 깨지면 도구가 아니라 부팅이 실패해야 한다.
  await wc();

  // ref -> {탭 id, backendDOMNodeId}. snapshot() 마다 통째로 새로 만든다.
  let refs = new Map();
  // ref 라벨 카운터. snapshot() 마다 0으로 리셋하면 이전 스냅샷의 라벨(예: e1)이
  // 새 문서에서도 그대로 재발급되어, 오래된 ref를 쥔 호출자가 완전히 다른(하지만
  // 우연히 라벨이 같은) 요소를 조작하게 된다. 도구 수명 동안 절대 리셋하지 않는다.
  let n = 0;

  async function resolve(ref) {
    const hit = refs.get(ref);
    if (!hit) return null;
    // 다른 탭에서 뜬 스냅샷의 ref 다. backendNodeId 는 문서마다 따로 매겨지므로
    // 그대로 쓰면 엉뚱한 노드를 잡는다.
    if (hit.id !== (await wc()).id) return null;
    try {
      const { object } = await cdp('DOM.resolveNode', { backendNodeId: hit.backendNodeId });
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
    const target = await wc();
    await target.loadURL(url);
    return `navigated to ${target.getURL()}`;
  }

  async function snapshot() {
    const target = await wc();
    const { nodes } = await cdp('Accessibility.getFullAXTree');
    refs = new Map();
    const lines = [];

    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value;
      if (!role) continue;
      const name = (node.name?.value ?? '').trim();

      if (INTERACTIVE.has(role)) {
        if (node.backendDOMNodeId === undefined) continue;
        const ref = 'e' + ++n;
        refs.set(ref, { id: target.id, backendNodeId: node.backendDOMNodeId });
        // 이름 없는 상호작용 노드(아이콘 전용 버튼 등)도 버리지 않는다 — description
        // 으로 대체하고, 그마저 없으면 (unlabeled)로 표시해서 최소한 존재는 드러낸다.
        const description = (node.description?.value ?? '').trim();
        const label = name
          ? JSON.stringify(name)
          : description
            ? JSON.stringify(description)
            : '(unlabeled)';
        lines.push(`[ref=${ref}] ${role} ${label}`);
      } else if (LANDMARK.has(role) && name) {
        lines.push(`          ${role} ${JSON.stringify(name)}`);
      }
    }

    if (!lines.length) return '(no interactive elements found; try read_page)';
    return `${target.getURL()}\n${lines.join('\n')}`;
  }

  // 요소의 화면 좌표 한 점을 고른다. 뷰포트 안으로 스크롤한 뒤 사각형을 다시 읽는다 —
  // 스크롤 전 좌표로 클릭하면 엉뚱한 자리를 누른다. 화면 밖이거나 크기가 0 이면 null.
  async function clickPoint(objectId) {
    await callOn(objectId, 'function(){ this.scrollIntoView({block:"center", inline:"center"}); }');
    let quad;
    try {
      ({ model: { content: quad } } = await cdp('DOM.getBoxModel', { objectId }));
    } catch {
      return null; // 렌더링되지 않는 요소는 박스가 없다
    }
    // content quad 는 [x1,y1, x2,y2, x3,y3, x4,y4] 순서다. 네 점의 평균이 중심.
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    // 뷰포트는 창이 아니라 이 webContents 에게 물어본다. 실제 앱에서 페이지는
    // 창보다 작은 뷰에 들어가 있어서 창 크기로 재면 판정이 어긋난다.
    const { result } = await cdp('Runtime.evaluate', {
      expression: '({w: innerWidth, h: innerHeight})',
      returnByValue: true,
    });
    const { w, h } = result.value ?? {};
    if (x <= 0 || y <= 0 || (w && x >= w) || (h && y >= h)) return null;
    return { x, y };
  }

  // 진짜 마우스 이벤트를 먼저 쏜다. 캔버스/드래그 UI 는 mousedown/mouseup 만 보고
  // el.click() 이 만드는 합성 click 이벤트는 무시한다. 좌표를 못 구하는 요소
  // (화면 밖, 크기 0, 렌더링 안 됨) 만 JS 클릭으로 떨어진다.
  async function click(ref) {
    const objectId = await resolve(ref);
    if (!objectId) return `stale ref ${ref} — call snapshot again`;

    const pt = await clickPoint(objectId);
    if (!pt) {
      await callOn(objectId, 'function(){ this.click(); }');
      return `clicked ${ref} (JS 클릭 — 좌표를 못 구했다)`;
    }

    const base = { ...pt, button: 'left', buttons: 1, clickCount: 1 };
    // 이동을 먼저 보낸다. hover 로만 열리는 메뉴는 이게 없으면 눌러도 안 열린다.
    await cdp('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 });
    await cdp('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await cdp('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
    return `clicked ${ref} at ${Math.round(pt.x)},${Math.round(pt.y)}`;
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

  // 여섯 도구 모두 "사람이 읽을 수 있는 문자열"을 반환하는 게 계약이다. 실패해도
  // reject 하면 MCP 핸들러가 모델에게 프로토콜 에러를 던지게 되므로, 여기 한
  // 곳에서만 잡아서 문자열로 바꾼다 (각 함수 내부에 개별 try/catch 두지 않는다).
  const safe = (name, fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return `${name} failed: ${e.message}`;
    }
  };

  return {
    navigate: safe('navigate', navigate),
    snapshot: safe('snapshot', snapshot),
    click: safe('click', click),
    type: safe('type', type),
    readPage: safe('readPage', readPage),
    wait: safe('wait', wait),
  };
}

module.exports = { createTools };
