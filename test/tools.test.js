// test/tools.test.js
// 실행: npx electron test/tools.test.js
const assert = require('node:assert');
const { app, BrowserWindow } = require('electron');

const PAGE = `
<!doctype html><meta charset="utf-8"><title>fixture</title>
<h1>Fixture Page</h1>
<input id="q" aria-label="search box" />
<button id="go">Run Search</button>
<div id="out">idle</div>
<script>
  document.getElementById('go').addEventListener('click', () => {
    document.getElementById('out').textContent =
      'RESULT:' + document.getElementById('q').value;
  });
</script>`;

const FIXTURE_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE);

// Second fixture, same shape (input then button) as PAGE so that under the
// buggy (counter-resets-per-snapshot) code, its button gets assigned the
// exact same ref label as PAGE's "Run Search" button. Also carries an
// icon-only button with no aria-label, for the unlabeled-node fix.
const PAGE_B = `
<!doctype html><meta charset="utf-8"><title>fixture b</title>
<h1>Fixture B Page</h1>
<input id="qb" aria-label="other search box" />
<button id="goB">Other Button</button>
<button id="iconB"><svg width="10" height="10"></svg></button>
<button id="rawB" aria-label="raw mouse button">Raw Mouse</button>
<div id="out">idle-b</div>
<div id="raw">no-raw</div>
<script>
  document.getElementById('goB').addEventListener('click', () => {
    document.getElementById('out').textContent = 'B_CLICKED';
  });
  // el.click() 은 mousedown 을 만들지 않는다. 진짜 마우스 이벤트 경로만 여기 걸린다.
  document.getElementById('rawB').addEventListener('mousedown', () => {
    document.getElementById('raw').textContent = 'RAW_MOUSEDOWN';
  });
</script>`;

const FIXTURE_URL_B = 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE_B);

async function main() {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800 });
  const { createTools } = require('../main/tools.js');
  // 도구는 "지금 활성인 탭"을 매번 물어본다. 탭 전환은 이 변수를 바꾸는 것이다.
  let target = win.webContents;
  const tools = await createTools(() => target);

  await tools.navigate(FIXTURE_URL);

  const snap = await tools.snapshot();
  console.log('--- snapshot ---\n' + snap + '\n---------------');

  const btn = snap.match(/\[ref=(\w+)\][^\n]*button[^\n]*Run Search/i);
  const box = snap.match(/\[ref=(\w+)\][^\n]*(textbox|searchbox)[^\n]*search box/i);
  assert.ok(btn, 'snapshot did not expose the button with a ref');
  assert.ok(box, 'snapshot did not expose the input with a ref');

  await tools.type(box[1], 'hello');
  await tools.click(btn[1]);
  await tools.wait(0.3);

  const text = await tools.readPage();
  assert.ok(text.includes('RESULT:hello'), `readPage missing click result:\n${text}`);
  assert.ok(text.includes('Fixture Page'), 'readPage missing heading');

  const stale = await tools.click('e9999');
  assert.match(stale, /stale ref/i, `expected stale-ref message, got: ${stale}`);

  // --- Fix 1 (Critical): ref labels must not be reused across snapshots ---
  // btn[1] is fixture A's "Run Search" ref, captured above, still valid
  // (page A is still loaded, nothing has navigated away yet).
  const oldRef = btn[1];

  await tools.navigate(FIXTURE_URL_B);
  const snapB = await tools.snapshot();
  console.log('--- snapshot B ---\n' + snapB + '\n---------------');

  const btnB = snapB.match(/\[ref=(\w+)\][^\n]*button[^\n]*Other Button/i);
  assert.ok(btnB, `snapshot B did not expose "Other Button" with a ref:\n${snapB}`);
  assert.notStrictEqual(
    btnB[1], oldRef,
    `ref label reused across snapshots: fixture B assigned ${btnB[1]} to its own ` +
    `button, the same label fixture A's stale ref (${oldRef}) still points to`
  );

  // Fix 3: the icon-only button (no aria-label) must still show up, as
  // "(unlabeled)", with its own ref — not silently dropped.
  const iconRef = snapB.match(/\[ref=(\w+)\]\s*button\s*\(unlabeled\)/);
  assert.ok(iconRef, `icon-only button missing from snapshot:\n${snapB}`);

  // Using fixture A's old ref on fixture B must be treated as stale, not
  // silently resolved to whatever live element on B now happens to share
  // that label.
  const reusedClick = await tools.click(oldRef);
  assert.match(
    reusedClick, /stale ref/i,
    `stale ref from a previous snapshot resolved to a live element on the new page: ${reusedClick}`
  );

  const textB = await tools.readPage();
  assert.ok(!textB.includes('B_CLICKED'), `stale ref click mutated fixture B:\n${textB}`);
  assert.ok(textB.includes('idle-b'), `fixture B output div missing expected idle state:\n${textB}`);

  // --- click() 은 합성 click 이 아니라 진짜 마우스 이벤트를 쏴야 한다 ---
  // 캔버스/드래그 UI 는 mousedown 만 본다. el.click() 으로는 절대 안 걸린다.
  {
    const rawSnap = await tools.snapshot();
    const raw = rawSnap.match(/\[ref=(\w+)\][^\n]*button[^\n]*raw mouse button/i);
    assert.ok(raw, `snapshot did not expose the raw-mouse button:\n${rawSnap}`);

    const msg = await tools.click(raw[1]);
    assert.match(msg, /at \d+,\d+/, `click() fell back to the JS path: ${msg}`);

    await tools.wait(0.2);
    const after = await tools.readPage();
    assert.ok(after.includes('RAW_MOUSEDOWN'), `click() did not fire a real mousedown:\n${after}`);
  }

  // --- 탭이 바뀌면 CDP 도 따라가고, 옛 탭의 ref 는 안 먹어야 한다 ---
  {
    const other = new BrowserWindow({ show: false, width: 1000, height: 800 });
    const snapBefore = await tools.snapshot();
    const refBefore = snapBefore.match(/[ref=(w+)]/)[1];

    target = other.webContents; // 탭 전환
    await tools.navigate(FIXTURE_URL);
    const snapOther = await tools.snapshot();
    assert.ok(snapOther.includes('Run Search'), `새 탭에 CDP 가 안 붙었다:
${snapOther}`);

    // 다른 탭에서 뜬 ref 다. backendNodeId 는 문서마다 따로라 그대로 쓰면 엉뚱한
    // 노드를 잡는다 — 라벨이 우연히 겹치면 조용히 잘못된 요소를 누른다.
    const crossTab = await tools.click(refBefore);
    assert.match(crossTab, /stale ref/i, `다른 탭의 ref 가 살아 있다: ${crossTab}`);

    target = win.webContents; // 원래 탭으로
    other.destroy();
  }

  // --- Fix 2: every tool returns a string, never rejects, even on bad input ---
  const badNav = await tools.navigate('not-a-valid-url-at-all');
  assert.strictEqual(typeof badNav, 'string', 'navigate() must resolve to a string even on a bad URL');
  assert.match(badNav, /fail/i, `expected a failure message from navigate(), got: ${badNav}`);

  console.log('TOOLS PASS');
  app.exit(0);
}

app.whenReady()
  .then(main)
  .catch((e) => {
    console.error('TOOLS FAIL:', e.stack || e.message);
    app.exit(1);
  });
