// test/ua.test.js
// 실행: node test/ua.test.js
// applyChromeIdentity 는 electron 을 쓰지만, 검사할 값은 전부 순수 함수다.
const assert = require('node:assert');
const Module = require('node:module');

// electron 을 require 하지 않고 순수 함수만 꺼낸다 (node 로 도는 테스트다).
const orig = Module._load;
Module._load = (req, ...rest) => (req === 'electron' ? { app: {}, session: {} } : orig(req, ...rest));
const { chromeUa, chromeMajor, brandList, rewriteHints } = require('../main/ua.js');
Module._load = orig;

const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/144.0.0.0 Electron/44.0.0 browse/1.0.0 Safari/537.36';

// 1. Electron/앱 토큰만 빠지고 나머지는 그대로
const ua = chromeUa(ELECTRON_UA, 'browse');
assert.ok(!ua.includes('Electron'), 'UA 에 Electron 이 남았다');
assert.ok(!ua.includes('browse/'), 'UA 에 앱 이름이 남았다');
assert.ok(ua.includes('Chrome/144.0.0.0') && ua.endsWith('Safari/537.36'), '크롬 토큰이 깨졌다');
assert.strictEqual(ua, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/144.0.0.0 Safari/537.36');
assert.strictEqual(chromeUa('', 'browse'), '');
assert.strictEqual(chromeUa(undefined, undefined), '');

// 2. 메이저 버전
assert.strictEqual(chromeMajor(ELECTRON_UA), '144');
assert.strictEqual(chromeMajor('no chrome here'), '');
assert.ok(brandList('144').includes('"Google Chrome";v="144"'));

// 3. Client Hints — 브랜드 목록에서 Electron 을 지운다.
//    대소문자가 섞여 들어와도 잡아야 한다 (Chromium 은 소문자로 보낸다).
const brands = brandList('144');
const headers = rewriteHints({
  'sec-ch-ua': '"Chromium";v="144", "Electron";v="44", "Not?A_Brand";v="24"',
  'Sec-CH-UA-Full-Version-List': '"Chromium";v="144.0.0.0", "Electron";v="44.0.0"',
  'sec-ch-ua-full-version': '"44.0.0"',
  'sec-ch-ua-platform': '"Windows"',
  'Accept-Language': 'ko-KR',
}, brands);
assert.strictEqual(headers['sec-ch-ua'], brands);
assert.ok(!('Sec-CH-UA-Full-Version-List' in headers), '전체 버전 목록이 안 지워졌다');
assert.ok(!('sec-ch-ua-full-version' in headers), '전체 버전이 안 지워졌다');
assert.strictEqual(headers['sec-ch-ua-platform'], '"Windows"', '플랫폼 힌트는 건드리면 안 된다');
assert.strictEqual(headers['Accept-Language'], 'ko-KR', '관계없는 헤더를 건드렸다');
assert.ok(!JSON.stringify(headers).includes('Electron'), '헤더 어딘가에 Electron 이 남았다');

console.log('UA PASS');
