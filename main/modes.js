// main/modes.js
// 토큰 절약 모드를 에이전트에 붙인다. 세 모드가 서로 다른 지점을 친다.
//   caveman/ponytail — 설치된 플러그인의 SKILL.md 를 읽어 시스템 프롬프트에 붙인다.
//   headroom         — 자식 프로세스의 ANTHROPIC_BASE_URL 을 프록시로 돌린다.
// electron 을 require 하지 않는다.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { findPlugin } = require('./deps.js');

const HEADROOM_DEFAULT_PORT = 8787;

// headroom 프록시 계열. 반드시 같이 켜지고 같이 꺼진다. BASE_URL 만 지우면
// CUSTOM_HEADERS 가 남아서, 프록시를 끈 뒤 진짜 api.anthropic.com 으로
// headroom 의 프로젝트 식별자가 그대로 나간다 (이 머신에서 실제로 확인:
// ANTHROPIC_CUSTOM_HEADERS = "X-Headroom-Project: browse").
const PROXY_VARS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_AUTH_TOKEN'];

// 이 앱을 Claude Code 세션 안에서 띄우면 자식이 그 세션의 IPC 소켓과 토큰을
// 물려받는다. 우리 에이전트는 그 채널을 쓸 일이 없다. 항상 뗀다.
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_)/i;

// 프롬프트로 동작하는 모드. headroom 은 프롬프트가 아니라 라우팅이라 여기 없다.
const PROMPT_MODES = ['caveman', 'ponytail'];

// 기본값은 전부 꺼짐이다. 켜는 건 사용자가 한다.
// 특히 headroom 을 기본으로 켜면 프록시가 안 떠 있을 때 에이전트가 통째로 죽는다.
const DEFAULTS = {
  tokenSaver: false,
  modes: { headroom: false, caveman: false, ponytail: false },
};

// 플러그인 안에서 skills/<이름>/SKILL.md 를 찾는다. 플러그인은 버전/해시 디렉터리를
// 한 겹 더 두고, 같은 파일을 plugins/<이름>/skills/ 나 .openclaw/skills/ 에도
// 복제해둔다. 가장 짧은 경로가 정본이다.
function findSkill(name) {
  const root = findPlugin(name);
  if (!root) return null;

  const hits = [];
  (function walk(dir, depth) {
    if (depth > 5) return;
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
  })(root, 0);

  // 문자 길이로 정렬하면 6.9.0 이 6.10.0 을 이긴다. 경로 깊이가 먼저고,
  // 같은 깊이면 사전순 역순으로 최신 버전 디렉터리를 집는다.
  const depth = (p) => p.split(path.sep).length;
  hits.sort((a, b) => depth(a) - depth(b) || b.localeCompare(a));
  return hits[0] ?? null;
}

function loadModeText(name) {
  const file = findSkill(name);
  if (!file) return null;
  try {
    // YAML 프론트매터는 Claude Code 가 스킬을 고르는 데 쓰는 메타데이터다.
    // 시스템 프롬프트에 그대로 넣으면 지시가 아니라 잡음이 된다.
    const raw = fs.readFileSync(file, 'utf8');
    // 문서 첫머리에 있을 때만 벗긴다. 앵커 없이 지우면 본문 중간의 --- 수평선을
    // 만나 그 앞을 통째로 날려버린다.
    return (raw.startsWith('---') ? raw.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '') : raw).trim();
  } catch {
    return null;
  }
}

// 설정 파일은 얕게 병합한다. 새 모드가 추가되면 기존 사용자의 파일에는 그 키가
// 없는데, 통째로 교체하면 undefined 가 되어 켤 방법이 사라진다.
// 파일이 없는 건 첫 실행이라 정상이다. 하지만 깨진 JSON 은 다르다 — 조용히
// 기본값으로 돌아가면 사용자가 켜둔 모드가 말없이 꺼진 채로 돈다. onCorrupt 로
// 알리고, 원본은 .bad 로 옮겨서 다음 저장 때 덮어써 사라지는 걸 막는다.
function loadSettings(file, onCorrupt) {
  const fallback = () => ({ ...DEFAULTS, modes: { ...DEFAULTS.modes } });
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') onCorrupt?.(`설정 파일을 읽지 못했다: ${err.message}`);
    return fallback();
  }
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('객체가 아니다');
    return {
      ...DEFAULTS,
      ...saved,
      modes: { ...DEFAULTS.modes, ...(saved.modes ?? {}) },
    };
  } catch (err) {
    let kept = '';
    try {
      fs.renameSync(file, `${file}.bad`);
      kept = ` 원본은 ${path.basename(file)}.bad 로 옮겼다.`;
    } catch { /* 못 옮겨도 알림은 나간다 */ }
    onCorrupt?.(`설정 파일이 깨졌다 (${err.message}). 기본값으로 뜬다.${kept}`);
    return fallback();
  }
}

function saveSettings(file, settings) {
  // 렌더러가 보낸 걸 그대로 믿지 않는다. modes 가 빠진 객체가 들어오면
  // 나중에 Object.keys(settings.modes) 가 핸들러 안에서 터진다.
  const clean = {
    ...DEFAULTS,
    ...settings,
    modes: { ...DEFAULTS.modes, ...(settings?.modes ?? {}) },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 쓰다가 죽으면 다음 부팅에 깨진 JSON 을 만난다. 임시 파일에 쓰고 이름을 바꾼다.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, file);
  return clean;
}

function enabled(settings, name) {
  return Boolean(settings?.tokenSaver && settings?.modes?.[name]);
}

// 켜달라고 한 모드와 실제로 붙은 모드를 같이 돌려준다. SKILL.md 를 못 찾으면
// 조용히 빠지는데, UI 는 켜졌다고 표시하고 사용자는 아무 동작 변화도 못 본다.
function buildSystemPrompt(base, settings) {
  const parts = [base];
  const attached = [];
  const failed = [];
  for (const name of PROMPT_MODES) {
    if (!enabled(settings, name)) continue;
    const text = loadModeText(name);
    if (text) {
      parts.push(`# ${name.toUpperCase()} MODE\n\n${text}`);
      attached.push(name);
    } else {
      failed.push(name);
    }
  }
  return { prompt: parts.join('\n\n'), attached, failed };
}

// 윈도우의 환경변수 조회는 대소문자를 안 가리지만 {...process.env} 는 평범한
// 대소문자 구분 객체다. PowerShell 에서 $env:anthropic_base_url 로 넣으면 그
// 철자 그대로 저장돼서, 정확한 이름만 지우면 살아남는다.
function pickVar(env, name) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function deleteVar(env, name) {
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === name.toLowerCase()) delete env[k];
  }
}

function headroomUrl(base = process.env) {
  return pickVar(base, 'ANTHROPIC_BASE_URL')
    || `http://127.0.0.1:${pickVar(base, 'HEADROOM_PORT') || HEADROOM_DEFAULT_PORT}`;
}

function buildEnv(settings, base = process.env) {
  const env = { ...base };

  for (const k of Object.keys(env)) {
    if (SESSION_VARS.test(k)) delete env[k];
  }

  // 켜든 끄든 일단 계열 전체를 뗀다. 켤 때는 우리가 정한 값 하나만 다시 넣는다 —
  // 그래야 대소문자가 다른 잔재가 남지 않는다.
  const url = enabled(settings, 'headroom') ? headroomUrl(base) : null;
  const keep = url ? { CUSTOM: pickVar(base, 'ANTHROPIC_CUSTOM_HEADERS'), AUTH: pickVar(base, 'ANTHROPIC_AUTH_TOKEN') } : null;
  for (const v of PROXY_VARS) deleteVar(env, v);

  if (url) {
    env.ANTHROPIC_BASE_URL = url;
    if (keep.CUSTOM !== undefined) env.ANTHROPIC_CUSTOM_HEADERS = keep.CUSTOM;
    if (keep.AUTH !== undefined) env.ANTHROPIC_AUTH_TOKEN = keep.AUTH;
  }
  return env;
}

// headroom 을 켜기 전에 프록시가 실제로 떠 있는지 본다. 안 떠 있는데 켜면
// 에이전트의 모든 요청이 죽는데, 증상이 "AI 가 응답을 안 한다"로만 보인다.
// 프로브 대상은 실제로 쓸 URL 에서 뽑는다 — 하드코딩한 8787 을 찌르면
// HEADROOM_PORT 를 바꿔둔 경우 살아 있는 프록시를 죽었다고 판정한다.
function isHeadroomUp(url = headroomUrl(), timeout = 700) {
  let host, port;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

module.exports = {
  DEFAULTS,
  PROMPT_MODES,
  HEADROOM_DEFAULT_PORT,
  findSkill,
  loadModeText,
  loadSettings,
  saveSettings,
  enabled,
  buildSystemPrompt,
  buildEnv,
  headroomUrl,
  isHeadroomUp,
};
