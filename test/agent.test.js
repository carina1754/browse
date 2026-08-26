// test/agent.test.js
// 실행: node test/agent.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgent } = require('../main/claude.js');

const MODEL = 'claude-haiku-4-5-20251001';

function turn(agent, waiters, text) {
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    agent.send(text);
  });
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cwd-'));
  const waiters = [];
  let deltas = '';

  const agent = createAgent({
    cwd,
    model: MODEL,
    onEvent: (evt) => {
      if (evt.type === 'text') deltas += evt.text;
      if (evt.type === 'done') waiters.shift()?.resolve(evt.result);
      if (evt.type === 'error') waiters.shift()?.reject(new Error(evt.text));
    },
  });

  const a = await turn(agent, waiters, 'Reply with exactly: ALPHA');
  assert.ok(a.includes('ALPHA'), `turn 1 result was: ${a}`);

  // 같은 프로세스에서 두 번째 턴. 프로세스가 죽었으면 여기서 멈춘다.
  const b = await turn(agent, waiters, 'Reply with exactly: BRAVO');
  assert.ok(b.includes('BRAVO'), `turn 2 result was: ${b}`);

  // 세 번째 턴에서 대화 맥락이 유지되는지 확인한다.
  const c = await turn(agent, waiters, 'What were the two words I asked you to say? List them.');
  assert.ok(/ALPHA/i.test(c) && /BRAVO/i.test(c), `context lost, turn 3 result: ${c}`);

  assert.ok(deltas.length > 0, 'no streaming text deltas were emitted');

  agent.stop();
  console.log('AGENT PASS');
}

main().catch((e) => {
  console.error('AGENT FAIL:', e.message);
  process.exit(1);
});
