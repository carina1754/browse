// spike/ping-server.js
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

// 이 서버가 증명하려는 것: claude.exe가 --mcp-config의 http transport로
// 우리 프로세스에 되돌아와 툴을 호출할 수 있는가.
async function startPingServer(nonce) {
  const server = new McpServer({ name: 'browser', version: '0.1.0' });

  server.registerTool(
    'ping',
    { description: 'Health check. Returns a fixed token.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: nonce }] })
  );

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

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => httpServer.close(),
  };
}

module.exports = { startPingServer };
