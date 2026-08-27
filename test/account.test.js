// test/account.test.js
// 실행: node test/account.test.js
// 네트워크도 claude 실행도 하지 않는다 — 파싱과 실패 경로만 본다.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAuth, parseLimits, timeLeft, readToken, subscriptionUsage, USAGE_URL } = require('../main/account.js');

// 1. auth status 파싱
const ok = parseAuth('{"loggedIn":true,"email":"a@b.c","subscriptionType":"max","orgName":"Org"}');
assert.deepStrictEqual(ok, { loggedIn: true, email: 'a@b.c', plan: 'max', org: 'Org' });
// 앞뒤에 다른 줄이 섞여도 첫 { ~ 마지막 } 만 본다
assert.strictEqual(parseAuth('warn: x\n{"loggedIn":false}\n').loggedIn, false);
assert.match(parseAuth('nothing here').error, /못 읽었다/);
assert.match(parseAuth('{oops}').error, /JSON/);
// subscriptionType 이 없으면 authMethod 로 떨어진다
assert.strictEqual(parseAuth('{"loggedIn":true,"authMethod":"claude.ai"}').plan, 'claude.ai');

// 2. 한도 파싱 — utilization 을 든 객체만 줍고, 남은 %로 뒤집는다
const limits = parseLimits({
  five_hour: { utilization: 23.4, resets_at: '2026-01-01T00:00:00Z' },
  seven_day: { utilization: 100 },
  weird_new_key: { utilization: 0 },
  account_uuid: 'not-an-object',
  something: { unrelated: 1 },
});
assert.deepStrictEqual(limits.map((l) => [l.label, l.remaining]), [
  ['5시간', 77], ['주간', 0], ['weird_new_key', 100],
]);
assert.strictEqual(limits[0].resetsAt, '2026-01-01T00:00:00Z');

// 하단 줄 칩 문구. 리셋까지 남은 시간을 붙이고, 모델별 한도는 모델 이름을 붙인다.
const now = Date.parse('2026-01-01T00:00:00Z');
const chips = parseLimits({
  five_hour: { utilization: 3, resets_at: '2026-01-01T04:09:00Z' },
  seven_day: { utilization: 22, resets_at: '2026-01-05T16:30:00Z' },
  seven_day_opus: { utilization: 3, resets_at: '2026-01-05T16:30:00Z' },
  no_reset: { utilization: 7 },
}, now);
assert.deepStrictEqual(chips.map((l) => l.text), [
  '3% 사용 4h 9m', '22% 사용 4d 16h', '3% 사용 Opus', '7% 사용 no_reset',
]);
// 이미 지난 리셋 시각, 없는 값, 초 단위 epoch 모두 견딘다
assert.strictEqual(timeLeft('2025-12-31T00:00:00Z', now), '');
assert.strictEqual(timeLeft(null, now), '');
assert.strictEqual(timeLeft(undefined, now), '');
assert.strictEqual(timeLeft(now / 1000 + 3600, now), '1h 0m');
assert.strictEqual(timeLeft(now + 90000, now), '1m');
assert.deepStrictEqual(parseLimits(null), []);
// 한도를 넘겨 써서 utilization 이 100 을 넘어도 음수 %를 보여주지 않는다
assert.strictEqual(parseLimits({ five_hour: { utilization: 130 } })[0].remaining, 0);

// 3. 토큰 읽기 — 키 이름이 어디에 있든 찾고, 없으면 null
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-test-'));
const credFile = path.join(dir, 'creds.json');
fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1', expiresAt: 1 } }));
assert.strictEqual(readToken(credFile), 'tok-1');
fs.writeFileSync(credFile, JSON.stringify({ access_token: 'tok-2' }));
assert.strictEqual(readToken(credFile), 'tok-2');
fs.writeFileSync(credFile, '{ not json');
assert.strictEqual(readToken(credFile), null);
assert.strictEqual(readToken(path.join(dir, 'nope.json')), null);

// 4. subscriptionUsage — 실패해도 throw 하지 않는다
(async () => {
  const boom = () => { throw new Error('should not be called'); };
  assert.match((await subscriptionUsage(boom, path.join(dir, 'nope.json'))).error, /토큰을 못 찾았다/);

  fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1' } }));

  let seen = null;
  const fakeFetch = (body, status = 200) => async (url, opts) => {
    seen = { url, opts };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };

  const good = await subscriptionUsage(fakeFetch({ five_hour: { utilization: 10 } }), credFile);
  assert.deepStrictEqual(good.limits.map((l) => l.remaining), [90]);
  assert.strictEqual(seen.url, USAGE_URL);
  // 토큰은 Authorization 헤더로만 나간다
  assert.strictEqual(seen.opts.headers.authorization, 'Bearer tok-1');

  assert.match((await subscriptionUsage(fakeFetch({}, 401), credFile)).error, /만료/);
  assert.match((await subscriptionUsage(fakeFetch({}, 500), credFile)).error, /HTTP 500/);
  // 200 인데 모양이 바뀐 경우 — 조용히 빈 줄을 보여주지 않고 이유를 남긴다
  assert.match((await subscriptionUsage(fakeFetch({ hello: 'world' }), credFile)).error, /한도 정보가/);
  assert.match((await subscriptionUsage(() => { throw new Error('offline'); }, credFile)).error, /요청 실패: offline/);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ACCOUNT PASS');
})();
