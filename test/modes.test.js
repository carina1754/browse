// test/modes.test.js
// 실행: node test/modes.test.js
// 네트워크도 API 호출도 하지 않는다. 디스크 읽기와 임시 파일 쓰기만 한다.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('../main/modes.js');

const BASE = 'BASE PROMPT';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modes-test-'));
const file = path.join(tmp, 'nested', 'settings.json');

function on(...names) {
  const s = { tokenSaver: true, modes: { headroom: false, caveman: false, ponytail: false } };
  for (const n of names) s.modes[n] = true;
  return s;
}

// --- buildEnv: 이 테스트가 이 파일에서 제일 중요하다 ---------------------------
// 이 앱을 띄운 셸에 이미 ANTHROPIC_BASE_URL 이 있을 수 있다. headroom 을 껐을 때
// "안 넣는다"로 처리하면 자식이 그대로 물려받아서, 껐는데도 계속 프록시를 탄다.
{
  const shell = { PATH: '/x', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' };

  const off = m.buildEnv(on(), shell);
  assert.ok(
    !('ANTHROPIC_BASE_URL' in off),
    'headroom 껐는데 ANTHROPIC_BASE_URL 이 자식 env 에 남았다 — 상속돼서 계속 프록시를 탄다'
  );
  assert.strictEqual(off.PATH, '/x', 'buildEnv 가 다른 환경변수를 날렸다');

  const yes = m.buildEnv(on('headroom'), shell);
  assert.strictEqual(yes.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787');

  // 셸에 없으면 기본 포트로 만들어 준다
  const made = m.buildEnv(on('headroom'), { PATH: '/x' });
  assert.strictEqual(made.ANTHROPIC_BASE_URL, `http://127.0.0.1:${m.HEADROOM_DEFAULT_PORT}`);

  // 마스터 스위치가 꺼져 있으면 개별 모드가 켜져 있어도 꺼진 것으로 본다
  const master = m.buildEnv({ tokenSaver: false, modes: { headroom: true } }, shell);
  assert.ok(!('ANTHROPIC_BASE_URL' in master), 'tokenSaver=false 인데 headroom 이 먹었다');

  // 원본 env 를 변형하면 안 된다
  assert.strictEqual(shell.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787', 'buildEnv 가 원본 env 를 건드렸다');
}

// --- 마스터 스위치가 프롬프트 모드에도 걸리는가 -------------------------------
assert.strictEqual(
  m.buildSystemPrompt(BASE, { tokenSaver: false, modes: { caveman: true, ponytail: true } }),
  BASE,
  'tokenSaver=false 인데 프롬프트 모드가 붙었다'
);
assert.strictEqual(m.buildSystemPrompt(BASE, m.DEFAULTS), BASE, '기본 설정인데 프롬프트가 변했다');
assert.strictEqual(m.buildSystemPrompt(BASE, undefined), BASE, 'settings 없을 때 터지면 안 된다');

// --- 설치된 플러그인만 실제 텍스트를 검사한다 ---------------------------------
for (const name of m.PROMPT_MODES) {
  const text = m.loadModeText(name);
  if (!text) {
    console.log(`  SKIP ${name} — 설치 안 됨`);
    continue;
  }
  assert.ok(!text.startsWith('---'), `${name}: YAML 프론트매터가 안 벗겨졌다`);
  assert.ok(text.length > 100, `${name}: SKILL.md 가 너무 짧다 (${text.length}B)`);
  assert.ok(fs.existsSync(m.findSkill(name)), `${name}: findSkill 이 없는 경로를 줬다`);

  const prompt = m.buildSystemPrompt(BASE, on(name));
  assert.ok(prompt.startsWith(BASE), `${name}: 원래 시스템 프롬프트가 앞에 안 남았다`);
  assert.ok(prompt.includes(text), `${name}: 모드 텍스트가 프롬프트에 안 붙었다`);
  console.log(`  OK   ${name} ${text.length}B ${m.findSkill(name)}`);
}
assert.strictEqual(m.loadModeText('definitely-not-installed-xyz'), null);
assert.strictEqual(m.findSkill('definitely-not-installed-xyz'), null);

// --- 설정 저장/로드 -----------------------------------------------------------
assert.deepStrictEqual(m.loadSettings(path.join(tmp, 'nope.json')), m.DEFAULTS, '없는 파일이 기본값을 안 준다');
assert.deepStrictEqual(m.loadSettings(file), m.DEFAULTS, '없는 디렉터리가 기본값을 안 준다');

m.saveSettings(file, on('caveman'));
assert.deepStrictEqual(m.loadSettings(file), on('caveman'), '저장/로드 왕복이 깨졌다');

// 나중에 모드가 추가되면 기존 사용자 파일에는 그 키가 없다. 병합 안 하면 undefined 가 된다.
fs.writeFileSync(file, JSON.stringify({ tokenSaver: true, modes: { caveman: true } }));
const merged = m.loadSettings(file);
assert.strictEqual(merged.modes.caveman, true, '저장된 값이 기본값에 덮였다');
assert.strictEqual(merged.modes.ponytail, false, '빠진 모드 키가 undefined 로 남았다');
assert.strictEqual(merged.modes.headroom, false, '빠진 모드 키가 undefined 로 남았다');

// 손상된 파일에 앱이 부팅 실패하면 안 된다
fs.writeFileSync(file, '{ not json');
assert.deepStrictEqual(m.loadSettings(file), m.DEFAULTS, '깨진 설정 파일에서 기본값으로 복구 못 했다');

// DEFAULTS 를 아무도 변형하지 않았는지
assert.deepStrictEqual(
  m.DEFAULTS,
  { tokenSaver: false, modes: { headroom: false, caveman: false, ponytail: false } },
  'DEFAULTS 가 도중에 변형됐다'
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('MODES PASS');
