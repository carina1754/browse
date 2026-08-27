// test/vault.test.js
// 실행: node test/vault.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVault, hostOf, hostMatch, fillScript } = require('../main/vault.js');

// 1. 호스트 정규화
assert.strictEqual(hostOf('https://accounts.google.com/signin'), 'accounts.google.com');
assert.strictEqual(hostOf('Google.com'), 'google.com');
assert.strictEqual(hostOf('google.com:443'), 'google.com');
assert.strictEqual(hostOf(''), '');

// 2. 매칭 — 서브도메인은 되고, 이름만 비슷한 딴 사이트는 안 된다
assert.ok(hostMatch('google.com', 'accounts.google.com'));
assert.ok(hostMatch('google.com', 'google.com'));
assert.ok(!hostMatch('google.com', 'evilgoogle.com'));
assert.ok(!hostMatch('google.com', 'google.com.evil.io'));
assert.ok(!hostMatch('', 'x.com'));

// 3. 저장/목록/삭제 — 평문이 어디에도 안 남는다
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
const file = path.join(dir, 'vault.json');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const crypt = {
  available: () => true,
  encrypt: (s) => b64('enc:' + s),
  decrypt: (b) => {
    const t = Buffer.from(b, 'base64').toString('utf8');
    if (!t.startsWith('enc:')) throw new Error('bad blob');
    return t.slice(4);
  },
};
const v = createVault({ file, crypt });

assert.strictEqual(v.add('', 'u', 'p').ok, false, '호스트 없이 저장됐다');
assert.ok(v.add('https://accounts.google.com/x', 'me@gmail.com', 'hunter2').ok);
assert.ok(v.add('accounts.google.com', 'me@gmail.com', 'hunter3').ok, '같은 host+user 덮어쓰기 실패');
assert.deepStrictEqual(v.list(), [{ host: 'accounts.google.com', user: 'me@gmail.com' }]);
assert.ok(!JSON.stringify(v.list()).includes('hunter'), 'list() 에 비밀번호가 실렸다');
assert.ok(!fs.readFileSync(file, 'utf8').includes('hunter'), '디스크에 평문이 남았다');

// 4. credsFor — 맞는 호스트만, 깨진 URL 은 null
assert.deepStrictEqual(v.credsFor('https://accounts.google.com/signin'),
  { user: 'me@gmail.com', pass: 'hunter3' });
assert.strictEqual(v.credsFor('https://evil.com/'), null);
assert.strictEqual(v.credsFor('not a url'), null);

// 5. OS 암호화가 없으면 저장 거부 (평문 저장 금지)
const noCrypt = createVault({ file, crypt: { ...crypt, available: () => false } });
assert.strictEqual(noCrypt.add('a.com', 'u', 'p').ok, false);

// 6. 주입 스크립트 — 값이 JSON 으로 박혀서 따옴표에 안 깨진다
const script = fillScript({ user: 'a"b', pass: "x'y\z" });
assert.ok(script.includes(JSON.stringify('a"b')));
assert.ok(script.includes(JSON.stringify("x'y\z")));

v.remove('accounts.google.com', 'me@gmail.com');
assert.deepStrictEqual(v.list(), []);
fs.rmSync(dir, { recursive: true, force: true });
console.log('VAULT PASS');
