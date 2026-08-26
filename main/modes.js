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

  hits.sort((a, b) => a.length - b.length);
  return hits[0] ?? null;
}

function loadModeText(name) {
  const file = findSkill(name);
  if (!file) return null;
  try {
    // YAML 프론트매터는 Claude Code 가 스킬을 고르는 데 쓰는 메타데이터다.
    // 시스템 프롬프트에 그대로 넣으면 지시가 아니라 잡음이 된다.
    return fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?^---\s*/m, '').trim();
  } catch {
    return null;
  }
}

// 설정 파일은 얕게 병합한다. 새 모드가 추가되면 기존 사용자의 파일에는 그 키가
// 없는데, 통째로 교체하면 undefined 가 되어 켤 방법이 사라진다.
function loadSettings(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...DEFAULTS,
      ...saved,
      modes: { ...DEFAULTS.modes, ...(saved.modes ?? {}) },
    };
  } catch {
    return { ...DEFAULTS, modes: { ...DEFAULTS.modes } };
  }
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return settings;
}

function enabled(settings, name) {
  return Boolean(settings?.tokenSaver && settings?.modes?.[name]);
}

function buildSystemPrompt(base, settings) {
  const parts = [base];
  for (const name of PROMPT_MODES) {
    if (!enabled(settings, name)) continue;
    const text = loadModeText(name);
    if (text) parts.push(`# ${name.toUpperCase()} MODE\n\n${text}`);
  }
  return parts.join('\n\n');
}

function headroomUrl(base = process.env) {
  return base.ANTHROPIC_BASE_URL
    || `http://127.0.0.1:${base.HEADROOM_PORT || HEADROOM_DEFAULT_PORT}`;
}

function buildEnv(settings, base = process.env) {
  const env = { ...base };
  if (enabled(settings, 'headroom')) {
    env.ANTHROPIC_BASE_URL = headroomUrl(base);
  } else {
    // 끄는 걸 "안 넣는다"로 처리하면 안 된다. 이 앱을 띄운 셸에 이미
    // ANTHROPIC_BASE_URL 이 잡혀 있으면 자식이 그대로 물려받아서, 껐는데도
    // 계속 프록시를 타게 된다. 명시적으로 지운다.
    delete env.ANTHROPIC_BASE_URL;
  }
  return env;
}

// headroom 을 켜기 전에 프록시가 실제로 떠 있는지 본다. 안 떠 있는데 켜면
// 에이전트의 모든 요청이 죽는데, 증상이 "AI 가 응답을 안 한다"로만 보인다.
function isHeadroomUp(port = HEADROOM_DEFAULT_PORT, timeout = 700) {
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
    sock.connect(port, '127.0.0.1');
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
