// Synthetic deployment fixture; no business acceptance claims.
const http = require('node:http');
const net = require('node:net');
http.createServer((request, response) => {
  if (request.url !== '/health') { response.writeHead(404).end(); return; }
  if (process.env.AIQA_RUNNER_TOKEN || process.env.AIQA_INTELLIGENCE_TOKEN || process.env.SESSION_SECRET) {
    response.writeHead(500).end('unexpected platform credential'); return;
  }
  if (!process.env.DATABASE_URL) { response.end('ready'); return; }
  const connection = net.connect(5432, 'task-db', () => { connection.end(); response.end('ready with task database'); });
  connection.on('error', () => response.writeHead(503).end('database not ready'));
}).listen(Number(process.env.PORT), '0.0.0.0');
