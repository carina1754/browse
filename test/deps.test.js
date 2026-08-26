// test/deps.test.js
// 실행: node test/deps.test.js
// 네트워크도 API 호출도 하지 않는다. 이미 설치된 것만 다루고,
// 없는 것에 대해서는 install() 을 절대 부르지 않는다 — 테스트가 진짜 설치를
// 트리거하면 안 된다.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkAll, install, findSkill, findMarketplace, DEPS, unwrapCmdShim, toSpawnable } = require('../main/deps.js');

// npm -g 로 깔린 claude.cmd 를 실행 가능한 형태로 푸는 부분.
// .cmd 는 shell 없이는 EINVAL 이고, shell 을 켜면 경로 공백·인자 이스케이프·8191자
// 제한이 한꺼번에 터진다. 그래서 shim 이 부르는 대상을 직접 꺼내야 한다.
function testCmdShim() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
  const write = (p, body) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  try {
    const binDir = path.join(dir, 'node_modules', 'pkg', 'bin');
    write(path.join(binDir, 'tool.exe'), '');
    write(path.join(binDir, 'tool.js'), '');
    // 진짜로 존재하게 만든다. 이게 있어야 "node.exe 를 걸러낸다"가 검증된다 —
    // 없으면 existsSync 때문에 엉뚱한 이유로 통과한다.
    write(path.join(dir, 'node.exe'), '');

    // 최신 cmd-shim: SET dp0=%~dp0 를 먼저 하고 %dp0% 를 쓴다. 타깃이 .exe.
    const newStyle = path.join(dir, 'newstyle.cmd');
    write(newStyle, [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
      '"%dp0%\\node_modules\\pkg\\bin\\tool.exe"   %*',
    ].join('\r\n'));

    // 구형: %~dp0 를 그대로 쓰고, node.exe 가 타깃보다 먼저 나온다. 타깃이 .js.
    const oldStyle = path.join(dir, 'oldstyle.cmd');
    write(oldStyle, [
      '@SETLOCAL',
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\pkg\\bin\\tool.js" %*',
      ') ELSE (',
      '  node  "%~dp0\\node_modules\\pkg\\bin\\tool.js" %*',
      ')',
    ].join('\r\n'));

    assert.strictEqual(
      unwrapCmdShim(newStyle), path.join(binDir, 'tool.exe'),
      '%dp0% 형태 shim 에서 .exe 타깃을 못 꺼냈다'
    );
    assert.strictEqual(
      unwrapCmdShim(oldStyle), path.join(binDir, 'tool.js'),
      '%~dp0 형태 shim 에서 .js 타깃을 못 꺼냈다 (node.exe 를 집었을 수 있다)'
    );

    // .exe 타깃은 인터프리터 없이 그대로 실행한다
    assert.deepStrictEqual(
      toSpawnable(newStyle), { command: path.join(binDir, 'tool.exe'), args: [] }
    );

    // .js 타깃은 node 가 앞에 붙는다. 옆에 node.exe 가 있으면 그걸 쓴다 (shim 과 같은 순서)
    assert.deepStrictEqual(
      toSpawnable(oldStyle), { command: path.join(dir, 'node.exe'), args: [path.join(binDir, 'tool.js')] }
    );

    // 타깃이 실제로 없으면 null. 있다고 우기면 spawn 에서 ENOENT 로 뒤늦게 죽는다.
    const dangling = path.join(dir, 'dangling.cmd');
    write(dangling, '"%dp0%\\node_modules\\pkg\\bin\\gone.exe" %*');
    assert.strictEqual(unwrapCmdShim(dangling), null, '없는 타깃을 가리키는 shim 이 통과했다');
    assert.strictEqual(toSpawnable(dangling), null);

    // .cmd 가 아니면 건드리지 않는다
    const plain = path.join(dir, 'claude.exe');
    assert.deepStrictEqual(toSpawnable(plain), { command: plain, args: [] });

    console.log('  OK   cmd-shim 해제 (합성 shim 4종)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 이 머신에 실제로 있는 shim 으로도 확인한다. 없으면 조용히 넘어간다.
  const real = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'opencode.cmd'),
    path.join('C:', 'Program Files', 'nodejs', 'corepack.cmd'),
  ].filter((p) => fs.existsSync(p));

  for (const p of real) {
    const target = unwrapCmdShim(p);
    assert.ok(target, `실제 shim 을 못 풀었다: ${p}`);
    assert.ok(fs.existsSync(target), `푼 타깃이 존재하지 않는다: ${target}`);
    assert.notStrictEqual(
      path.basename(target).toLowerCase(), 'node.exe',
      `인터프리터를 타깃으로 집었다: ${p}`
    );
    console.log(`  OK   실제 shim ${path.basename(p)} -> ${path.basename(target)}`);
  }
}

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

  // 6. findSkill 은 없는 플러그인에 null 을 주고, 있는 건 실제 SKILL.md 를 준다
  assert.strictEqual(findSkill('definitely-not-installed-xyz'), null);
  for (const name of ['caveman', 'ponytail']) {
    const hit = findSkill(name);
    // 이 머신에 안 깔려 있을 수 있다. 깔려 있다면 디렉터리가 아니라 파일이어야 한다.
    if (hit) assert.ok(hit.endsWith(`${path.sep}SKILL.md`) && fs.existsSync(hit), `${name}: findSkill 이 SKILL.md 가 아닌 걸 줬다`);
  }

  // 6-1. plugin install 은 <플러그인>@<마켓플레이스> 다. 이름이 같다고 가정하면 안 된다.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const put = (dir, json) => {
      fs.mkdirSync(path.join(root, dir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(root, dir, '.claude-plugin', 'marketplace.json'), JSON.stringify(json));
    };
    put('official-dir', { name: 'claude-plugins-official', plugins: [{ name: 'caveman' }, { name: 'solo' }] });
    put('someones-fork', { name: 'caveman', plugins: [{ name: 'caveman' }] });
    put('broken', { name: 'broken' }); // plugins 없음
    fs.mkdirSync(path.join(root, 'not-a-marketplace'), { recursive: true });

    // 플러그인만 담은 마켓플레이스의 이름이 디렉터리 이름과 달라도 찾아야 한다
    assert.strictEqual(findMarketplace('solo', root), 'claude-plugins-official');
    // 여러 곳에 있으면 이름이 같은 전용 저장소를 고른다
    assert.strictEqual(findMarketplace('caveman', root), 'caveman');
    // 없는 플러그인, 깨진 clone, 마켓플레이스 아닌 디렉터리는 조용히 null
    assert.strictEqual(findMarketplace('definitely-not-a-plugin', root), null);
    assert.strictEqual(findMarketplace('caveman', path.join(root, 'nope')), null);

    fs.rmSync(root, { recursive: true, force: true });
  }

  // 7. 모든 DEPS 항목에 check 와 install 이 있어야 한다
  for (const [name, d] of Object.entries(DEPS)) {
    assert.strictEqual(typeof d.check, 'function', `${name}.check 없음`);
    assert.strictEqual(typeof d.install, 'function', `${name}.install 없음`);
  }

  // 8. .cmd shim 해제
  testCmdShim();

  console.log('DEPS PASS');
}

main().catch((e) => {
  console.error('DEPS FAIL:', e.message);
  process.exit(1);
});
