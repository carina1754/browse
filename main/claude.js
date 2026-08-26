// main/claude.js
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';

// claude.exe 는 기본으로 Bash/Edit/Read/PowerShell 을 들고 있다.
// 브라우저 어시스턴트에게 파일시스템과 셸 접근은 불필요하고 위험하다.
//
// Agent/Task 를 막는 이유는 나머지와 다르다. test/security.test.js 에서 실제로
// 관찰된 행동인데, Write 가 거부되자 모델이 Agent 로 서브에이전트를 띄워
// PowerShell 로 같은 파일을 쓰려 했다. 그 위임 경로를 열어두면 이 목록 전체가
// 한 겹짜리가 된다. ToolSearch 도 같은 이유 — 우리 에이전트가 쓸 툴은
// mcp__browser__* 로 이미 명시돼 있어서 탐색이 필요 없다.
const BLOCKED_TOOLS = [
  // 파일시스템·셸 직접 접근
  'Bash', 'BashOutput', 'KillShell', 'PowerShell',
  'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  // 네트워크. WebFetch 만 막고 WebSearch 를 두면 반쪽이다.
  'WebFetch', 'WebSearch',
  // 위임 경로. test/security.test.js 에서 실제로 관찰됐다 — Write 가 거부되자
  // 모델이 Agent 로 서브에이전트를 띄워 PowerShell 로 같은 파일을 쓰려 했다.
  // 이 경로를 열어두면 위 목록 전체가 한 겹짜리가 된다.
  'Agent', 'Task', 'ToolSearch', 'SlashCommand',
];

function buildArgs({ mcpUrl, model, systemPrompt }) {
  const args = [
    '-p', '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--session-id', randomUUID(),
    '--setting-sources', '',
    '--disable-slash-commands',
    '--disallowedTools', ...BLOCKED_TOOLS,
  ];
  if (mcpUrl) {
    args.push(
      '--mcp-config',
      JSON.stringify({ mcpServers: { browser: { type: 'http', url: mcpUrl } } }),
      '--allowedTools', 'mcp__browser'
    );
  }
  if (model) args.push('--model', model);
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  return args;
}

function createAgent({ cwd, mcpUrl, model, systemPrompt, env, onEvent }) {
  // env 를 안 넘기면 node 가 process.env 를 물려준다. 넘기는 쪽(main/modes.js)은
  // 그 상속을 의도적으로 덮어쓰려는 경우다 — headroom 을 껐을 때 셸에 남아 있는
  // ANTHROPIC_BASE_URL 을 지우는 것 같은.
  const child = spawn(CLAUDE_BIN, buildArgs({ mcpUrl, model, systemPrompt }), {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  // NOTE: stdout uses an incremental UTF-8 decoder (StringDecoder) so a
  // multi-byte character split across two chunk boundaries isn't corrupted.
  // This app streams assistant text straight into the chat UI and its user
  // writes Korean, so every response is multi-byte.
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', (d) => {
    buf += decoder.write(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) handleLine(line, onEvent);
    }
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString('utf8');
  });

  // 윈도우에는 SIGTERM 이 없다. stop() 의 kill() 은 TerminateProcess 라
  // 종료 코드가 항상 0 이 아니게 나온다. 의도한 종료를 오류로 보고하지 않도록 표시해 둔다.
  let stopping = false;

  child.on('error', (e) => onEvent({ type: 'error', text: `spawn failed: ${e.message}` }));
  child.on('close', (code) => {
    if (code !== 0 && !stopping) {
      onEvent({ type: 'error', text: `claude exited ${code}: ${stderr.trim().slice(-500)}` });
    }
  });

  return {
    send(text) {
      child.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
      }) + '\n');
    },
    stop() {
      stopping = true;
      child.stdin.end();
      child.kill();
    },
  };
}

function handleLine(line, onEvent) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // NDJSON 이 아닌 줄은 무시한다
  }

  // --include-partial-messages 가 켜져 있으면 텍스트는 델타로 온다.
  if (msg.type === 'stream_event') {
    const d = msg.event?.delta;
    if (d?.type === 'text_delta' && d.text) onEvent({ type: 'text', text: d.text });
    return;
  }

  if (msg.type === 'assistant') {
    for (const c of msg.message?.content ?? []) {
      if (c.type === 'tool_use') onEvent({ type: 'tool', text: c.name });
    }
    return;
  }

  if (msg.type === 'result') {
    if (msg.is_error) onEvent({ type: 'error', text: String(msg.result ?? 'unknown error') });
    else onEvent({ type: 'done', result: String(msg.result ?? '') });
  }
}

module.exports = { createAgent, BLOCKED_TOOLS };
