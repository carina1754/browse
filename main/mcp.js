// main/mcp.js
// tools.js 의 함수 6개를 MCP 툴로 등록하고 localhost HTTP 로 노출한다.
// CDP 를 모른다 — tools 객체만 받는다.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });

async function startMcpServer(tools) {
  const server = new McpServer({ name: 'browser', version: '0.1.0' });

  server.registerTool('navigate', {
    description: 'Open a URL in the browser pane. Returns the final URL after redirects.',
    inputSchema: { url: z.string().describe('Absolute URL including scheme') },
  }, async ({ url }) => text(await tools.navigate(url)));

  server.registerTool('snapshot', {
    description:
      'List the interactive elements on the current page as [ref=eN] role "name" lines. ' +
      'Call this before click or type. Refs are invalidated by navigation.',
    inputSchema: {},
  }, async () => text(await tools.snapshot()));

  server.registerTool('click', {
    description: 'Click an element by its ref from the most recent snapshot.',
    inputSchema: { ref: z.string().describe('A ref like "e3" from snapshot') },
  }, async ({ ref }) => text(await tools.click(ref)));

  server.registerTool('type', {
    description: 'Clear a text field and type into it, by its ref from the most recent snapshot.',
    inputSchema: {
      ref: z.string().describe('A ref like "e7" from snapshot'),
      text: z.string().describe('Text to type'),
    },
  }, async ({ ref, text: value }) => text(await tools.type(ref, value)));

  server.registerTool('read_page', {
    description: 'Return the visible text of the current page. Use for reading and summarizing.',
    inputSchema: {},
  }, async () => text(await tools.readPage()));

  server.registerTool('wait', {
    description: 'Pause for N seconds to let the page settle after a click or navigation.',
    inputSchema: { seconds: z.number().describe('Seconds to wait, max 30') },
  }, async ({ seconds }) => text(await tools.wait(seconds)));

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (!req.url.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400).end();
          return;
        }
      }
      transport.handleRequest(req, res, body);
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  return { url: `http://127.0.0.1:${port}/mcp`, close: () => httpServer.close() };
}

module.exports = { startMcpServer };
