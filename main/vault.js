// main/vault.js
// 사이트 비밀번호 금고. 암호화는 OS 에 맡긴다 (safeStorage = Windows DPAPI).
// 평문 비밀번호는 main 프로세스 안에서만 산다 — 렌더러에는 host/user 목록만
// 주고, 에이전트 MCP 도구에는 아예 없다.
const fs = require('node:fs');

// "https://accounts.google.com/x" / "Google.com:443" 입력 전부 호스트로 정규화.
function hostOf(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  try { return new URL(s.includes('://') ? s : 'https://' + s).hostname; } catch { return s; }
}

// google.com 을 저장했으면 accounts.google.com 에서도 채운다.
// evilgoogle.com 은 안 된다 — 점 경계를 확인한다.
function hostMatch(saved, current) {
  if (!saved || !current) return false;
  return current === saved || current.endsWith('.' + saved);
}

// React 류는 el.value= 만으로는 상태가 안 바뀐다 — 네이티브 setter + input 이벤트.
// 값은 JSON.stringify 로 박는다. 문자열 연결로 넣으면 따옴표에 깨진다.
function fillScript({ user, pass }) {
  return '(() => {'
    + 'const U = ' + JSON.stringify(user) + ', P = ' + JSON.stringify(pass) + ';'
    + `
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const vis = (el) => el && el.offsetParent !== null;
  const p = Array.from(document.querySelectorAll('input[type="password"]')).find(vis);
  const scope = p && p.form ? p.form : document;
  const u = Array.from(scope.querySelectorAll('input[type="email"], input[autocomplete="username"], input[type="text"]')).find(vis);
  if (!p && !u) return 'no-fields';
  if (u) set(u, U);
  if (p) set(p, P);
  return (u ? 'user' : '') + (u && p ? '+' : '') + (p ? 'pass' : '');
})()`;
}

function createVault({ file, crypt }) {
  // crypt = { available(), encrypt(str)->base64, decrypt(base64)->str }.
  // 실전은 main/app.js 가 safeStorage 로 만들고, 테스트는 가짜를 꽂는다.
  function readAll() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  }
  function writeAll(rows) { fs.writeFileSync(file, JSON.stringify(rows, null, 2)); }

  // 렌더러(설정 창)에 주는 목록 — 비밀번호는 절대 안 실린다.
  function list() { return readAll().map((r) => ({ host: r.host, user: r.user })); }

  function add(rawHost, user, pass) {
    if (!crypt.available()) return { ok: false, detail: 'OS 암호화(DPAPI)를 못 쓴다. 평문으로는 저장 안 한다.' };
    const host = hostOf(rawHost);
    if (!host || !user || !pass) return { ok: false, detail: '사이트/아이디/비밀번호를 다 채워라.' };
    // 같은 사이트 같은 아이디는 덮어쓴다.
    const rows = readAll().filter((r) => !(r.host === host && r.user === user));
    rows.push({ host, user, pass: crypt.encrypt(pass) });
    writeAll(rows);
    return { ok: true, detail: host + ' 저장됨' };
  }

  function remove(host, user) {
    writeAll(readAll().filter((r) => !(r.host === host && r.user === user)));
    return { ok: true };
  }

  // 현재 페이지에 맞는 계정. 평문이 나오는 유일한 문 — main/app.js 의
  // vault:fill 만 부르고, 결과는 페이지 주입으로만 쓴다.
  function credsFor(url) {
    let current;
    try { current = new URL(url).hostname.toLowerCase(); } catch { return null; }
    const hit = readAll().find((r) => hostMatch(r.host, current));
    if (!hit) return null;
    try { return { user: hit.user, pass: crypt.decrypt(hit.pass) }; } catch { return null; }
  }

  return { list, add, remove, credsFor };
}

module.exports = { createVault, hostOf, hostMatch, fillScript };
