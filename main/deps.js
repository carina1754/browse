// main/deps.js
// 앱이 기대는 외부 도구를 점검하고, 없으면 설치한다.
// electron 을 require 하지 않는다 — 순수 node 로 테스트할 수 있어야 한다.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WIN = process.platform === 'win32';
const HOME = os.homedir();

// 후보가 둘인 이유: 네이티브 설치는 claude.exe 를, npm -g 설치는 claude.cmd 를 남긴다.
//
// .cmd 는 그냥 실행할 수 없다. 전부 실측한 결과다:
//   - 절대경로를 shell 없이 spawn        -> EINVAL (CreateProcess 가 .cmd 를 못 연다)
//   - 이름만으로 spawn                    -> ENOENT (PATHEXT 미적용)
//   - shell: true                         -> 세 가지가 동시에 깨진다
//       1) 경로에 공백이 있으면 실패: "'C:\Program' 은(는) 내부 또는 외부 명령..."
//       2) 인자를 이스케이프하지 않는다 (node DEP0190). SKILL.md 의 마크다운 표에
//          들어 있는 | 가 그대로 파이프로 해석된다.
//       3) cmd.exe 명령줄 8191자 제한. 10KB 시스템 프롬프트가 "명령줄이 너무 깁니다"로 죽는다.
//
// 그래서 shell 을 쓰지 않는다. shim 이 실제로 부르는 대상을 꺼내서 직접 spawn 한다.
const CLAUDE_CANDIDATES = WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];

// 실행 대상은 {command, args} 로 표현한다. .cmd 를 풀면 인터프리터가 앞에 붙어서
// 이름 하나로는 표현이 안 된다 (node + cli.js).
const asSpec = (bin) => (typeof bin === 'string' ? { command: bin, args: [] } : bin);
const specLabel = (spec) => [spec.command, ...spec.args].join(' ');

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

async function probeVersion(bin) {
  const { command, args } = asSpec(bin);
  const { code, out } = await run(command, [...args, '--version']);
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

// npm 의 cmd-shim 이 실제로 실행하는 대상을 꺼낸다. 두 형태가 다 돌아다닌다:
//   "%dp0%\node_modules\pkg\bin\thing.exe"       (SET dp0=%~dp0 를 먼저 하는 최신 shim)
//   "%~dp0\node.exe"  "%~dp0\...\thing.js"       (구형)
// node.exe 는 인터프리터지 대상이 아니다 — 걸러낸다. 안 그러면 corepack.cmd 에서
// corepack.js 대신 node.exe 를 집는다 (이 머신의 실제 파일로 확인).
function unwrapCmdShim(cmdPath) {
  let body;
  try {
    body = fs.readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(cmdPath);
  const re = /"%~?dp0%?[\\/]+([^"\r\n]+?\.(?:js|exe))"/gi;
  for (const m of body.matchAll(re)) {
    const rel = m[1];
    if (path.basename(rel).toLowerCase() === 'node.exe') continue;
    const target = path.join(dir, rel);
    if (fs.existsSync(target)) return target;
  }
  return null;
}

// 실행 가능한 {command, args} 로 정규화한다. 풀 수 없는 .cmd 는 null.
function toSpawnable(binPath) {
  if (!binPath.toLowerCase().endsWith('.cmd')) return { command: binPath, args: [] };

  const target = unwrapCmdShim(binPath);
  if (!target) return null;
  if (!target.toLowerCase().endsWith('.js')) return { command: target, args: [] };

  // shim 과 같은 순서로 node 를 고른다: 옆에 있는 node.exe 가 있으면 그것, 없으면 PATH.
  const local = path.join(path.dirname(binPath), 'node.exe');
  return { command: fs.existsSync(local) ? local : 'node', args: [target] };
}

// 이름만으로는 .cmd 를 풀 수 없다. 실제 경로가 필요하다.
async function whichAll(name) {
  const { code, out } = WIN ? await run('where.exe', [name]) : await run('which', ['-a', name]);
  return code === 0 ? out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

// 어떤 claude 를 쓸지 한 번 정해서 기억한다. 없으면 null.
// 돌려주는 건 이름이 아니라 {command, args} 다 — .cmd 를 풀면 node 가 앞에 붙는다.
async function claudeBin() {
  if (resolvedClaude) return resolvedClaude;
  for (const name of CLAUDE_CANDIDATES) {
    // .cmd 가 아니면 spawn 이 PATH 에서 알아서 찾는다. 경로 조회를 건너뛴다.
    const paths = name.endsWith('.cmd') ? await whichAll(name) : [name];
    for (const p of paths) {
      const spec = toSpawnable(p);
      if (!spec) continue;
      const { ok } = await probeVersion(spec);
      if (ok) {
        resolvedClaude = spec;
        return spec;
      }
    }
  }
  return null;
}

// 플러그인은 실행파일이 아니라 디스크의 마크다운이다. 마켓플레이스 디렉터리 이름이
// 플러그인 이름과 같다고 가정하지 않는다 (caveman 은 같지만 규칙이 아니다) — 루트들의
// 하위를 훑어 skills/<이름>/SKILL.md 를 직접 찾는다. 프롬프트에 실제로 붙는 그 파일이
// 곧 설치 판정이다. 디렉터리만 보고 판정하면 UI 는 "설치됨"인데 모드는 조용히 빠진다.
// 플러그인은 버전/해시 디렉터리를 한 겹 더 두고, 같은 파일을 plugins/<이름>/skills/ 나
// .openclaw/skills/ 에도 복제해둔다. 가장 짧은 경로가 정본이다.
function findSkill(name) {
  let hits = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'skills') {
        const skill = path.join(p, name, 'SKILL.md');
        if (fs.existsSync(skill)) hits.push(skill);
        continue; // skills 아래로는 더 내려가지 않는다
      }
      walk(p, depth + 1);
    }
  };
  // 루트 순서가 우선이다 (cache = 정식 설치본, marketplaces = clone 원본).
  // 깊이로만 고르면 얕은 clone 이 항상 정식 설치본을 이긴다.
  for (const root of PLUGIN_ROOTS) {
    hits = [];
    walk(root, 0);
    if (!hits.length) continue;
    // 문자 길이로 정렬하면 6.9.0 이 6.10.0 을 이긴다. 경로 깊이가 먼저고,
    // 같은 깊이면 사전순 역순으로 최신 버전 디렉터리를 집는다.
    const depth = (p) => p.split(path.sep).length;
    hits.sort((a, b) => depth(a) - depth(b) || b.localeCompare(a));
    return hits[0];
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
      const v = await probeVersion(bin);
      // 어떻게 실행되는지 보여준다. .cmd 를 푼 경우 node + cli.js 로 나온다.
      return v.ok ? { ok: true, detail: `${v.detail}  (${specLabel(bin)})` } : v;
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
      const skill = findSkill('caveman');
      return skill ? { ok: true, detail: skill } : { ok: false, detail: 'SKILL.md 없음' };
    },
    install: (onOutput) => installPlugin('caveman', onOutput),
  },

  ponytail: {
    label: 'Ponytail (최소 작업 모드)',
    required: false,
    why: '되는 첫 방법에서 멈춘다. 페이지 과탐색과 툴 왕복이 줄어든다.',
    check: async () => {
      const skill = findSkill('ponytail');
      return skill ? { ok: true, detail: skill } : { ok: false, detail: 'SKILL.md 없음' };
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
  const added = await run(bin.command, [...bin.args, 'plugin', 'marketplace', 'add', url], onOutput);
  // 이미 등록돼 있으면 실패로 나오지만 그건 문제가 아니다 — 다음 단계가 판정한다.
  if (added.code !== 0 && onOutput) onOutput(`marketplace add 실패(무시하고 진행): ${added.out.trim()}`);
  return run(bin.command, [...bin.args, 'plugin', 'install', `${name}@${name}`], onOutput);
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

module.exports = {
  checkAll, install, findSkill, claudeBin, refreshPath, DEPS, MARKETPLACES,
  unwrapCmdShim, toSpawnable,
};
