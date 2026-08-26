// test/deps.test.js
// 실행: node test/deps.test.js
// 네트워크도 API 호출도 하지 않는다. 이미 설치된 것만 다루고,
// 없는 것에 대해서는 install() 을 절대 부르지 않는다 — 테스트가 진짜 설치를
// 트리거하면 안 된다.
const assert = require('node:assert');
const { checkAll, install, findPlugin, DEPS } = require('../main/deps.js');

async function main() {
  const results = await checkAll();

  // 1. 네 개 전부 보고돼야 한다
  const names = results.map((r) => r.name).sort();
  assert.deepStrictEqual(
    names, ['caveman', 'claude', 'headroom', 'ponytail'],
    `checkAll() 이 빠뜨린 의존성이 있다: ${names.join(', ')}`
  );

  // 2. 각 항목은 UI 가 그대로 쓸 수 있는 모양이어야 한다
  for (const r of results) {
    assert.strictEqual(typeof r.ok, 'boolean', `${r.name}.ok 가 boolean 이 아니다`);
    assert.ok(r.label, `${r.name} 에 label 이 없다`);
    assert.ok(r.why, `${r.name} 에 why 가 없다`);
    assert.strictEqual(typeof r.detail, 'string', `${r.name}.detail 이 string 이 아니다`);
    console.log(`  ${r.ok ? 'OK  ' : 'MISS'} ${r.name.padEnd(9)} ${r.detail.slice(0, 60)}`);
  }

  // 3. claude 는 required 로 표시돼야 하고 나머지는 아니어야 한다
  const claude = results.find((r) => r.name === 'claude');
  assert.strictEqual(claude.required, true, 'claude 는 required 여야 한다');
  for (const r of results) {
    if (r.name !== 'claude') {
      assert.strictEqual(r.required, false, `${r.name} 은 required 가 아니어야 한다`);
    }
  }

  // 4. 이미 설치된 것에 install() 을 부르면 설치를 시도하지 않고 바로 돌아와야 한다.
  //    없는 것에는 부르지 않는다 (진짜로 설치돼 버리므로).
  const present = results.filter((r) => r.ok);
  assert.ok(present.length > 0, '설치된 의존성이 하나도 없어서 단축 경로를 검증할 수 없다');
  for (const r of present) {
    let spawned = false;
    const res = await install(r.name, () => { spawned = true; });
    assert.ok(res.ok, `${r.name}: 이미 설치됐는데 install() 이 실패로 보고했다: ${res.detail}`);
    assert.match(
      res.detail, /이미 설치됨/,
      `${r.name}: install() 이 단축 경로로 안 빠졌다 — 설치를 시도했을 수 있다: ${res.detail}`
    );
    assert.ok(!spawned, `${r.name}: 이미 설치됐는데 install() 이 명령을 실행했다`);
  }

  // 5. 모르는 이름은 던지지 않고 실패로 보고해야 한다
  const bogus = await install('nope-not-a-dep');
  assert.strictEqual(bogus.ok, false, '없는 의존성 이름이 성공으로 보고됐다');

  // 6. findPlugin 은 없는 플러그인에 null 을 준다
  assert.strictEqual(findPlugin('definitely-not-installed-xyz'), null);

  // 7. 모든 DEPS 항목에 check 와 install 이 있어야 한다
  for (const [name, d] of Object.entries(DEPS)) {
    assert.strictEqual(typeof d.check, 'function', `${name}.check 없음`);
    assert.strictEqual(typeof d.install, 'function', `${name}.install 없음`);
  }

  console.log('DEPS PASS');
}

main().catch((e) => {
  console.error('DEPS FAIL:', e.message);
  process.exit(1);
});
