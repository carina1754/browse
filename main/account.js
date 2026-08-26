// main/account.js
// 지금 붙어 있는 Claude 계정과 남은 사용량을 읽는다.
// electron 을 require 하지 않는다 — 순수 node 로 테스트할 수 있어야 한다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Claude Code 가 로그인 정보를 두는 자리. 이 앱은 여기서 액세스 토큰만 읽어
// 아래 USAGE_URL 을 칠 때 Authorization 헤더로 쓴다. 토큰은 이 모듈 밖으로
// (렌더러로도, 로그로도) 절대 나가지 않는다.
const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');

// 구독 한도(5시간/주간)는 CLI 어디에도 안 나온다 — `claude auth status --json`
// 에도, -p 의 result 메시지에도 없다. 세션 안의 /usage 가 보는 것과 같은
// OAuth 엔드포인트를 직접 친다. 공개 문서가 없는 경로라 응답 모양이 바뀔 수
// 있어서 parseLimits 는 키 이름을 고정하지 않고 훑는다.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const LABELS = {
  five_hour: '5시간',
  seven_day: '주간',
  seven_day_opus: '주간 Opus',
  seven_day_sonnet: '주간 Sonnet',
};

// claude 를 한 번 돌리고 {code, out} 을 돌려준다. 절대 reject 하지 않는다 —
// "로그인이 안 돼 있다"는 정상적인 결과지 예외가 아니다.
function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin.command, [...bin.args, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: os.homedir(),
      });
    } catch (e) {
      resolve({ code: -1, out: `실행 실패: ${e.message}` });
      return;
    }
    let out = '';
    const take = (d) => { out += d.toString('utf8'); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function authStatus(bin, timeoutMs = 10000) {
  const { out } = await run(bin, ['auth', 'status', '--json'], timeoutMs);
  return parseAuth(out);
}

// 로그아웃은 비대화형이라 그냥 돌리면 된다.
async function logout(bin, timeoutMs = 20000) {
  const { code, out } = await run(bin, ['auth', 'logout'], timeoutMs);
  return code === 0
    ? { ok: true, detail: out.trim().slice(-200) || '로그아웃했다' }
    : { ok: false, detail: out.trim().slice(-200) || `종료 코드 ${code}` };
}

// 로그인은 대화형 TUI 다 — 브라우저를 열고 콘솔에서 코드를 받는다. Electron 은
// GUI 프로세스라 자식에게 물려줄 콘솔이 없다(detached 로 띄워도 DETACHED_PROCESS
// 라 콘솔이 아예 안 붙는다). 그래서 윈도우에서는 cmd 로 콘솔 창을 새로 띄우고
// 거기서 돌린다. /k 로 창을 남겨서 실패해도 메시지를 볼 수 있게 한다.
function openLogin(bin) {
  if (process.platform !== 'win32') {
    return { ok: false, detail: '터미널에서 직접 실행해라: claude auth login' };
  }
  const q = (s) => `"${s}"`;
  const inner = `"${[q(bin.command), ...bin.args, 'auth', 'login', '--claudeai'].join(' ')}"`;
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/s', '/k', inner], {
      windowsVerbatimArguments: true, // 인용부호를 우리가 직접 잡는다
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (e) {
    return { ok: false, detail: `콘솔 창을 못 띄웠다: ${e.message}` };
  }
  return { ok: true, detail: '콘솔 창에서 로그인을 마쳐라. 끝나면 여기서 새로고침된다.' };
}

function parseAuth(out) {
  // --json 이어도 앞뒤에 다른 줄이 섞여 나올 수 있다. 첫 { 부터 마지막 } 까지만 본다.
  const i = out.indexOf('{');
  const j = out.lastIndexOf('}');
  if (i < 0 || j < i) return { error: '응답을 못 읽었다' };
  let json;
  try {
    json = JSON.parse(out.slice(i, j + 1));
  } catch {
    return { error: '응답이 JSON 이 아니다' };
  }
  if (!json.loggedIn) return { loggedIn: false };
  return {
    loggedIn: true,
    email: json.email ?? null,
    plan: json.subscriptionType ?? json.authMethod ?? null,
    org: json.orgName ?? null,
  };
}

// 키 이름이 버전마다 달라서(accessToken / access_token) 훑는다.
function readToken(file = CREDENTIALS) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 파일이 없거나 깨졌다 = 잔여량을 못 읽는다, 그뿐이다
  }
  return findToken(json);
}

function findToken(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && v && /^access_?token$/i.test(k)) return v;
  }
  for (const v of Object.values(node)) {
    const hit = findToken(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// 응답에서 "한도" 로 보이는 것만 골라낸다. utilization 은 쓴 비율(%)이라
// 남은 비율은 100 에서 뺀다.
function parseLimits(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  for (const [key, v] of Object.entries(json)) {
    if (!v || typeof v !== 'object') continue;
    const used = Number(v.utilization ?? v.used_percent);
    if (!Number.isFinite(used)) continue;
    out.push({
      key,
      label: LABELS[key] ?? key,
      remaining: Math.max(0, Math.min(100, Math.round(100 - used))),
      resetsAt: v.resets_at ?? v.resetsAt ?? null,
    });
  }
  return out;
}

// 구독 한도 잔여량. throw 하지 않는다 — 헤더 한 줄이 비는 게 앱이 죽는 것보다 낫다.
async function subscriptionUsage(fetchImpl = fetch, file = CREDENTIALS) {
  const token = readToken(file);
  if (!token) return { error: '로그인 토큰을 못 찾았다' };
  let res;
  try {
    res = await fetchImpl(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'ai-browser',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { error: `요청 실패: ${e.message}` };
  }
  if (res.status === 401 || res.status === 403) return { error: '토큰 만료 (claude auth login)' };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  let json;
  try {
    json = await res.json();
  } catch {
    return { error: '응답이 JSON 이 아니다' };
  }
  const limits = parseLimits(json);
  if (!limits.length) return { error: '한도 정보가 응답에 없다' };
  return { limits };
}

module.exports = { authStatus, logout, openLogin, subscriptionUsage, parseAuth, parseLimits, readToken, USAGE_URL };
