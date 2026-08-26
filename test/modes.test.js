// test/modes.test.js
// 실행: node test/modes.test.js
// 네트워크도 API 호출도 하지 않는다. 디스크 읽기와 임시 파일 쓰기만 한다.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('../main/modes.js');

const BASE = 'BASE PROMPT';

async function main() {
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

// --- headroom 프록시 계열 전체가 같이 꺼지는가 -------------------------------
// BASE_URL 만 지우면 CUSTOM_HEADERS 가 남아서, 프록시를 끈 뒤 진짜
// api.anthropic.com 으로 headroom 의 프로젝트 식별자가 그대로 나간다.
{
  const shell = {
    PATH: '/x',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
    ANTHROPIC_CUSTOM_HEADERS: 'X-Headroom-Project: browse',
    ANTHROPIC_AUTH_TOKEN: 'proxy-issued',
    ANTHROPIC_API_KEY: 'user-own-key',
  };
  const off = m.buildEnv(on(), shell);
  for (const leak of ['ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.ok(!(leak in off), `headroom 껐는데 ${leak} 이 남아 진짜 API 로 나간다`);
  }
  assert.strictEqual(off.ANTHROPIC_API_KEY, 'user-own-key', '사용자 본인 API 키까지 지웠다');

  const yes = m.buildEnv(on('headroom'), shell);
  assert.strictEqual(yes.ANTHROPIC_CUSTOM_HEADERS, 'X-Headroom-Project: browse', 'headroom 켰는데 헤더가 빠졌다');
  assert.strictEqual(yes.ANTHROPIC_AUTH_TOKEN, 'proxy-issued', 'headroom 켰는데 토큰이 빠졌다');
}

// --- 윈도우 대소문자 -----------------------------------------------------------
// {...process.env} 는 대소문자 구분 객체인데 윈도우 조회는 안 가린다.
// PowerShell 에서 $env:anthropic_base_url 로 넣으면 그 철자 그대로 저장된다.
{
  const off = m.buildEnv(on(), { PATH: '/x', anthropic_base_url: 'http://127.0.0.1:8787' });
  assert.deepStrictEqual(Object.keys(off), ['PATH'], `소문자 ANTHROPIC_BASE_URL 이 살아남았다: ${Object.keys(off)}`);
}

// --- Claude Code 세션 변수는 항상 뗀다 ------------------------------------------
// 이 앱을 Claude Code 안에서 띄우면 자식이 그 세션의 IPC 소켓과 토큰을 물려받는다.
{
  const env = m.buildEnv(on('headroom'), {
    PATH: '/x',
    CLAUDECODE: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: 'pipe',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_CODE_SESSION_ID: 'sid',
  });
  const leaked = Object.keys(env).filter((k) => /^(CLAUDECODE|CLAUDE_CODE_)/i.test(k));
  assert.deepStrictEqual(leaked, [], `자식이 상위 Claude 세션 변수를 물려받았다: ${leaked}`);
}

// --- headroom 프로브가 실제로 쓸 URL 을 찌르는가 --------------------------------
// 하드코딩한 8787 을 찌르면 HEADROOM_PORT 를 바꿔둔 경우 오판한다.
assert.strictEqual(
  m.headroomUrl({ HEADROOM_PORT: '9931' }), 'http://127.0.0.1:9931',
  'HEADROOM_PORT 가 무시됐다'
);
assert.strictEqual(await m.isHeadroomUp('http://127.0.0.1:9931'), false, '죽은 포트를 살아있다고 했다');
assert.strictEqual(await m.isHeadroomUp('not a url'), false, '깨진 URL 에서 터졌다');

// --- 마스터 스위치가 프롬프트 모드에도 걸리는가 -------------------------------
assert.strictEqual(
  m.buildSystemPrompt(BASE, { tokenSaver: false, modes: { caveman: true, ponytail: true } }).prompt,
  BASE,
  'tokenSaver=false 인데 프롬프트 모드가 붙었다'
);
assert.strictEqual(m.buildSystemPrompt(BASE, m.DEFAULTS).prompt, BASE, '기본 설정인데 프롬프트가 변했다');
assert.strictEqual(m.buildSystemPrompt(BASE, undefined).prompt, BASE, 'settings 없을 때 터지면 안 된다');

// 없는 모드를 켜면 "붙었다"고 하면 안 된다
{
  const r = m.buildSystemPrompt(BASE, { tokenSaver: true, modes: { caveman: true, ponytail: true } });
  for (const name of m.PROMPT_MODES) {
    const installed = m.loadModeText(name) !== null;
    assert.strictEqual(
      r.attached.includes(name), installed,
      `${name}: attached 보고가 실제 설치 상태와 다르다`
    );
    assert.strictEqual(r.failed.includes(name), !installed, `${name}: failed 보고가 틀렸다`);
  }
}

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

  const { prompt, attached } = m.buildSystemPrompt(BASE, on(name));
  assert.ok(prompt.startsWith(BASE), `${name}: 원래 시스템 프롬프트가 앞에 안 남았다`);
  assert.ok(prompt.includes(text), `${name}: 모드 텍스트가 프롬프트에 안 붙었다`);
  assert.deepStrictEqual(attached, [name], `${name}: attached 목록이 틀렸다`);
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

// 렌더러가 모양이 깨진 걸 보내도 저장은 정상 모양이어야 한다
{
  const fixed = m.saveSettings(file, { tokenSaver: true });
  assert.deepStrictEqual(fixed.modes, m.DEFAULTS.modes, 'modes 빠진 payload 가 정리되지 않았다');
  assert.ok(!fs.existsSync(`${file}.tmp`), '임시 파일이 안 지워졌다');
}

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
}

main().catch((e) => {
  console.error('MODES FAIL:', e.message);
  process.exit(1);
});
