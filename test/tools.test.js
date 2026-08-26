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

async function main() {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800 });
  const { createTools } = require('../main/tools.js');
  const tools = await createTools(win.webContents);

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

  console.log('TOOLS PASS');
  app.exit(0);
}

app.whenReady()
  .then(main)
  .catch((e) => {
    console.error('TOOLS FAIL:', e.stack || e.message);
    app.exit(1);
  });
