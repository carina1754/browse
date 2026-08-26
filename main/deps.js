// main/deps.js
// 앱이 기대는 외부 도구를 점검하고, 없으면 설치한다.
// electron 을 require 하지 않는다 — 순수 node 로 테스트할 수 있어야 한다.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WIN = process.platform === 'win32';
const HOME = os.homedir();

// main/claude.js 와 같은 규칙. 저기서 import 하지 않는 건 deps.js 가
// claude.exe 가 아직 없을 수도 있는 상황을 다루는 모듈이기 때문이다.
//
// 후보가 둘인 이유: 네이티브 설치는 claude.exe 를, npm -g 설치는 claude.cmd 를
// 남긴다. 노드의 spawn 은 윈도우에서 .exe 는 확장자 없이도 찾아내지만 .cmd 는
// PATHEXT 를 적용하지 않아 shell 없이는 ENOENT 다. 확인함:
// spawn('npm', ['--version']) -> ENOENT.
const CLAUDE_CANDIDATES = WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];
let resolvedClaude = null;

// 설치 스크립트가 바이너리를 놓는 곳. 윈도우는 환경변수 변경이 이미 실행 중인
// 프로세스에 전파되지 않아서, 설치 직후 PATH 만 믿으면 방금 깔린 걸 못 본다.
const INSTALL_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, 'AppData', 'Local', 'Programs', 'claude'),
];

// 플러그인 마크다운이 놓이는 곳. cache 가 정식 설치본, marketplaces 는 clone 원본.
const PLUGIN_ROOTS = [
  path.join(HOME, '.claude', 'plugins', 'cache'),
  path.join(HOME, '.claude', 'plugins', 'marketplaces'),
];

// 공식 설치 경로. 이 상수들은 이 사용자 머신에 실제로 설치된 흔적에서 확인한 값이다
// (claude 는 ~/.local/bin 네이티브 빌드, headroom 은 uv tool 로 설치된 headroom-ai).
const CLAUDE_INSTALL_PS = 'irm https://claude.ai/install.ps1 | iex';
const CLAUDE_INSTALL_SH = 'curl -fsSL https://claude.ai/install.sh | sh';
const HEADROOM_PACKAGE = 'headroom-ai';

const MARKETPLACES = {
  caveman: 'https://github.com/JuliusBrussee/caveman.git',
  ponytail: 'https://github.com/DietrichGebert/ponytail.git',
};

// 명령 하나를 돌리고 {code, out} 을 돌려준다. 절대 reject 하지 않는다 —
// "도구가 없다"는 정상적인 결과지 예외가 아니다.
function run(cmd, args, onOutput, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // cwd 를 HOME 으로 고정한다. 안 그러면 설치 명령이 Electron 을 띄운
      // 디렉터리(=이 리포)에서 돈다.
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: HOME, ...opts });
    } catch (e) {
      resolve({ code: -1, out: `spawn failed: ${e.message}` });
      return;
    }

    let out = '';
    const take = (d) => {
      const s = d.toString('utf8');
      out += s;
      if (onOutput) for (const l of s.split('\n')) if (l.trim()) onOutput(l.trimEnd());
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    child.on('error', (e) => resolve({ code: -1, out: `${out}spawn failed: ${e.message}` }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

// 셸을 거쳐야 하는 설치 스크립트용. 파이프(|)가 들어가서 spawn 직접 호출로는 안 된다.
function runShell(script, onOutput) {
  return WIN
    ? run('powershell.exe', ['-NoProfile', '-Command', script], onOutput)
    : run('sh', ['-c', script], onOutput);
}

async function probeVersion(bin, opts) {
  const { code, out } = await run(bin, ['--version'], null, opts);
  return code === 0 ? { ok: true, detail: out.trim().split('\n')[0] } : { ok: false, detail: out.trim() };
}

// PATH 에 알려진 설치 디렉터리를 붙인다. 설치 직후 재점검과 이후의 모든 spawn 이
// 앱을 재시작하지 않고도 방금 깔린 바이너리를 보게 만든다.
function refreshPath() {
  const sep = WIN ? ';' : ':';
  const cur = (process.env.PATH || '').split(sep);
  const add = INSTALL_DIRS.filter((d) => fs.existsSync(d) && !cur.some((c) => c.toLowerCase() === d.toLowerCase()));
  if (add.length) process.env.PATH = [...add, ...cur].join(sep);
  return add;
}

// 어떤 claude 를 쓸지 한 번 정해서 기억한다. 없으면 null.
async function claudeBin() {
  if (resolvedClaude) return resolvedClaude;
  for (const bin of CLAUDE_CANDIDATES) {
    const { ok } = await probeVersion(bin, { shell: bin.endsWith('.cmd') });
    if (ok) {
      resolvedClaude = bin;
      return bin;
    }
  }
  return null;
}

// 플러그인은 실행파일이 아니라 디스크의 마크다운이다. 있으면 그 경로를 돌려준다.
function findPlugin(name) {
  for (const root of PLUGIN_ROOTS) {
    const dir = path.join(root, name);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

const DEPS = {
  claude: {
    label: 'Claude Code',
    required: true,
    why: '에이전트 본체. 없으면 앱이 아무것도 못 한다.',
    check: async () => {
      const bin = await claudeBin();
      if (!bin) return { ok: false, detail: '실행 파일을 찾을 수 없다' };
      return probeVersion(bin, { shell: bin.endsWith('.cmd') });
    },
    install: (onOutput) => runShell(WIN ? CLAUDE_INSTALL_PS : CLAUDE_INSTALL_SH, onOutput),
  },

  headroom: {
    label: 'Headroom (컨텍스트 최적화 프록시)',
    required: false,
    why: 'API 트래픽을 프록시로 통과시켜 토큰을 줄인다.',
    check: () => probeVersion('headroom'),
    install: async (onOutput) => {
      const uv = await probeVersion('uv');
      if (!uv.ok) {
        return { code: -1, out: 'uv 가 없어서 headroom 을 설치할 수 없다. 먼저 uv 를 설치해라: https://docs.astral.sh/uv/' };
      }
      return run('uv', ['tool', 'install', HEADROOM_PACKAGE], onOutput);
    },
  },

  caveman: {
    label: 'Caveman (간결 출력 모드)',
    required: false,
    why: '에이전트 답변에서 군더더기를 뺀다. 출력 토큰이 줄어든다.',
    check: async () => {
      const dir = findPlugin('caveman');
      return dir ? { ok: true, detail: dir } : { ok: false, detail: '플러그인 없음' };
    },
    install: (onOutput) => installPlugin('caveman', onOutput),
  },

  ponytail: {
    label: 'Ponytail (최소 작업 모드)',
    required: false,
    why: '되는 첫 방법에서 멈춘다. 페이지 과탐색과 툴 왕복이 줄어든다.',
    check: async () => {
      const dir = findPlugin('ponytail');
      return dir ? { ok: true, detail: dir } : { ok: false, detail: '플러그인 없음' };
    },
    install: (onOutput) => installPlugin('ponytail', onOutput),
  },
};

// 플러그인 설치는 claude CLI 를 거친다 — 우리가 직접 clone 하면 claude 가
// 모르는 위치에 놓여서 나중에 claude plugin 명령들과 어긋난다.
async function installPlugin(name, onOutput) {
  const url = MARKETPLACES[name];
  const bin = await claudeBin();
  if (!bin) return { code: -1, out: 'claude 가 없어서 플러그인을 설치할 수 없다. 먼저 Claude Code 를 설치해라.' };
  const opts = { shell: bin.endsWith('.cmd') };
  const added = await run(bin, ['plugin', 'marketplace', 'add', url], onOutput, opts);
  // 이미 등록돼 있으면 실패로 나오지만 그건 문제가 아니다 — 다음 단계가 판정한다.
  if (added.code !== 0 && onOutput) onOutput(`marketplace add 실패(무시하고 진행): ${added.out.trim()}`);
  return run(bin, ['plugin', 'install', `${name}@${name}`], onOutput, opts);
}

async function checkAll() {
  const names = Object.keys(DEPS);
  const results = await Promise.all(names.map(async (name) => {
    const d = DEPS[name];
    const { ok, detail } = await d.check();
    return { name, label: d.label, required: d.required, why: d.why, ok, detail };
  }));
  return results;
}

async function install(name, onOutput) {
  const d = DEPS[name];
  if (!d) return { ok: false, detail: `알 수 없는 의존성: ${name}` };

  const before = await d.check();
  if (before.ok) return { ok: true, detail: `이미 설치됨: ${before.detail}` };

  const { code, out } = await d.install(onOutput);

  // 설치 성공 여부는 설치 명령의 종료 코드가 아니라 재점검으로 판정한다.
  // 다만 재점검 전에 PATH 를 갱신해야 한다. 윈도우는 설치 스크립트가 고친
  // 사용자 PATH 가 이미 실행 중인 프로세스에 전파되지 않아서, 이걸 빼면
  // 첫 설치는 항상 재점검에 실패한다 — 실제로 설치됐는데 "설치 실패"가 뜨고,
  // 사용자가 버튼을 다시 눌러 240MB 를 또 받게 된다.
  resolvedClaude = null; // 방금 깔린 게 다른 후보일 수 있다
  const added = refreshPath();
  if (added.length && onOutput) onOutput(`PATH 에 추가: ${added.join(', ')}`);

  const after = await d.check();
  if (after.ok) return { ok: true, detail: after.detail };

  // 설치 명령 자체는 성공했는데 아직 안 보이는 경우와, 진짜 실패를 구분한다.
  if (code === 0) {
    return { ok: false, detail: '설치는 끝났지만 아직 이 프로세스에서 안 보인다. 앱을 재시작해라.', needsRestart: true };
  }
  return { ok: false, detail: out.trim().slice(-500) || `설치 명령이 ${code} 로 끝났고 재점검도 실패` };
}

module.exports = { checkAll, install, findPlugin, claudeBin, refreshPath, DEPS, MARKETPLACES };
