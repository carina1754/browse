// test/workspace.test.js
// 실행: node test/workspace.test.js
// 파일을 지우는 코드다. 안전장치가 살아 있는지가 이 테스트의 핵심이다.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clearDir } = require('../main/workspace.js');

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
const dir = path.join(parent, 'agent-cwd');

// 1. 안이 비워지고 디렉터리 자체는 남는다
fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'leak');
fs.writeFileSync(path.join(dir, 'sub', 'deep', 'note.txt'), 'leak');
assert.deepStrictEqual(clearDir(dir, parent, 'agent-cwd'), [], '비우기가 실패를 보고했다');
assert.ok(fs.existsSync(dir), '디렉터리 자체를 지웠다');
assert.deepStrictEqual(fs.readdirSync(dir), [], '내용이 안 비워졌다');

// 2. 없는 디렉터리는 이미 비어 있는 것과 같다 (에러 아님)
assert.deepStrictEqual(clearDir(path.join(parent, 'agent-cwd-gone'), parent, 'agent-cwd-gone'), []);

// 3. 안전장치: 경로 모양이 다르면 아무것도 안 지운다
const decoy = path.join(parent, 'important');
fs.mkdirSync(decoy, { recursive: true });
fs.writeFileSync(path.join(decoy, 'keep.txt'), 'keep');
for (const [d, p, n] of [
  [decoy, parent, 'agent-cwd'],            // 이름이 다르다
  [dir, path.join(parent, 'elsewhere'), 'agent-cwd'], // 부모가 다르다
  [parent, parent, path.basename(parent)], // 부모 자신을 비우려는 시도
]) {
  const failed = clearDir(d, p, n);
  assert.strictEqual(failed.length, 1, `안전장치가 안 걸렸다: ${d}`);
  assert.match(failed[0], /경로가 예상과 달라서/, failed[0]);
}
assert.ok(fs.existsSync(path.join(decoy, 'keep.txt')), '안전장치가 남의 파일을 지웠다');

// 4. 심볼릭 링크는 링크만 지운다. 대상까지 따라가지 않는다.
//    윈도우는 권한이 없으면 링크 생성 자체가 안 된다 — 그러면 이 항목은 건너뛴다.
const target = path.join(parent, 'outside');
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'precious.txt'), 'precious');
let linked = true;
try {
  fs.symlinkSync(target, path.join(dir, 'link'), 'junction');
} catch {
  linked = false;
}
if (linked) {
  assert.deepStrictEqual(clearDir(dir, parent, 'agent-cwd'), [], '링크가 있는 디렉터리 비우기가 실패했다');
  assert.ok(fs.existsSync(path.join(target, 'precious.txt')), '심볼릭 링크를 따라가 대상까지 지웠다');
  assert.deepStrictEqual(fs.readdirSync(dir), [], '링크가 안 지워졌다');
}

fs.rmSync(parent, { recursive: true, force: true });
console.log(`WORKSPACE PASS${linked ? '' : ' (심볼릭 링크 항목은 권한이 없어 건너뜀)'}`);
