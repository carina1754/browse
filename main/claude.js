// main/claude.js
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';

// claude.exe 는 기본으로 Bash/Edit/Read/PowerShell 을 들고 있다.
// 브라우저 어시스턴트에게 파일시스템과 셸 접근은 불필요하고 위험하다.
const BLOCKED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'PowerShell', 'WebFetch'];

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

function createAgent({ cwd, mcpUrl, model, systemPrompt, onEvent }) {
  const child = spawn(CLAUDE_BIN, buildArgs({ mcpUrl, model, systemPrompt }), {
    cwd,
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

  child.on('error', (e) => onEvent({ type: 'error', text: `spawn failed: ${e.message}` }));
  child.on('close', (code) => {
    if (code !== 0) {
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
