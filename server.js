const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8080;
const HTML_FILE = path.join(__dirname, 'pp-tracker (2).html');
const OSU_TOKEN_URL = 'https://osu.ppy.sh/oauth/token';
const OSU_API_BASE = 'https://osu.ppy.sh/api/v2';

function proxyRequest(targetUrl, method, headers, body, res) {
  const parsed = new url.URL(targetUrl);
  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method,
    headers,
  };
  const req = https.request(options, (upstream) => {
    res.writeHead(upstream.statusCode, { 'Content-Type': upstream.headers['content-type'] || 'application/json' });
    upstream.pipe(res);
  });
  req.on('error', (e) => {
    console.error('Proxy error:', e.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  if (body) req.write(body);
  req.end();
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Serve HTML
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Favicon / logo
  if (req.method === 'GET' && (req.url === '/favicon.ico' || req.url === '/logo.png')) {
    fs.readFile(path.join(__dirname, 'logo.png'), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    });
    return;
  }

  // Token proxy
  if (req.method === 'POST' && req.url === '/proxy/token') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      console.log('Token request -> osu!');
      proxyRequest(OSU_TOKEN_URL, 'POST', {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }, body, res);
    });
    return;
  }

  // Beatmap proxy
  const bmMatch = req.url.match(/^\/proxy\/beatmap\/(\d+)$/);
  if (req.method === 'GET' && bmMatch) {
    proxyRequest(`${OSU_API_BASE}/beatmaps/${bmMatch[1]}`, 'GET', {
      'Authorization': req.headers['authorization'] || '',
      'Accept': 'application/json',
    }, null, res);
    return;
  }

  // Beatmap attributes proxy
  const attrMatch = req.url.match(/^\/proxy\/beatmap-attributes\/(\d+)$/);
  if (req.method === 'POST' && attrMatch) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      proxyRequest(`${OSU_API_BASE}/beatmaps/${attrMatch[1]}/attributes`, 'POST', {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': req.headers['authorization'] || '',
        'Content-Length': Buffer.byteLength(body),
      }, body, res);
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`ppsheet running at http://localhost:${PORT}`);
  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}`);
});
