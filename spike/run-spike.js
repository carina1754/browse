// spike/run-spike.js
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startPingServer } = require('./ping-server.js');

const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';

async function main() {
  const nonce = 'PONG-' + randomUUID().slice(0, 8);
  const srv = await startPingServer(nonce);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cwd-'));

  const args = [
    '-p', '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--session-id', randomUUID(),
    '--setting-sources', '',
    '--disable-slash-commands',
    '--mcp-config', JSON.stringify({
      mcpServers: { browser: { type: 'http', url: srv.url } },
    }),
    '--allowedTools', 'mcp__browser',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'PowerShell', 'WebFetch',
    '--model', 'claude-haiku-4-5-20251001',
  ];

  const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });

  let buf = '';
  let sawToolUse = false;
  let result = null;

  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'assistant') {
        for (const c of msg.message?.content ?? []) {
          if (c.type === 'tool_use' && String(c.name).startsWith('mcp__browser')) {
            sawToolUse = true;
          }
        }
      }
      if (msg.type === 'result') result = msg;
    }
  });

  child.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Call the ping tool and reply with exactly its output, nothing else.' },
  }) + '\n');
  child.stdin.end();

  const code = await new Promise((resolve) => child.on('close', resolve));
  srv.close();

  assert.ok(sawToolUse, 'claude never called mcp__browser__ping');
  assert.ok(result, `no result message (exit ${code})`);
  assert.ok(
    String(result.result).includes(nonce),
    `nonce ${nonce} missing from result: ${result.result}`
  );
  console.log('SPIKE PASS:', result.result);
}

main().catch((e) => {
  console.error('SPIKE FAIL:', e.message);
  process.exit(1);
});
