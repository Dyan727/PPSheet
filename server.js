const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { exec, spawn, execSync } = require('child_process');

const IS_PKG = typeof process.pkg !== 'undefined';

// ── Self-hide: must happen before anything else so the parent exits cleanly
// The child gets PPSHEET_DAEMON=1 and skips this block, running the actual server.
if (IS_PKG && process.platform === 'win32' && !process.env.PPSHEET_DAEMON) {
  spawn(process.execPath, process.argv.slice(1), {
    env: { ...process.env, PPSHEET_DAEMON: '1' },
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  }).unref();
  process.exit(0); // parent exits immediately — server lives in the child
}

const { Beatmap, Performance } = require('rosu-pp-js');

const PORT = 727;
const APP_HOST = 'pp.sheet';
const HTML_FILE = path.join(__dirname, 'pp-tracker (2).html');
const INSTALL_FILE = path.join(__dirname, 'install.html');
const OSU_TOKEN_URL = 'https://osu.ppy.sh/oauth/token';
const OSU_API_BASE = 'https://osu.ppy.sh/api/v2';
// When running as a pkg EXE, __dirname is a read-only snapshot.
// Use APPDATA for anything that needs to be written at runtime.
const DATA_DIR = IS_PKG
  ? path.join(process.env.APPDATA || process.env.HOME || '.', 'PPSheet')
  : __dirname;

const OSU_CACHE_DIR = path.join(DATA_DIR, '.osu-cache');
const MANIFEST_FILE = path.join(__dirname, 'manifest.json');
const SW_FILE = path.join(__dirname, 'sw.js');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(OSU_CACHE_DIR)) fs.mkdirSync(OSU_CACHE_DIR);

// ── First-run setup: desktop shortcut + startup registration
const FIRST_RUN_FLAG = path.join(DATA_DIR, '.first-run-done');
const IS_FIRST_RUN = IS_PKG && process.platform === 'win32' && !fs.existsSync(FIRST_RUN_FLAG);

const CHROME_PATHS = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const EDGE_PATHS = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function pngToIco(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(1, 4); // 1 image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);  entry.writeUInt8(0, 1);  // 0 = 256px
  entry.writeUInt8(0, 2);  entry.writeUInt8(0, 3);  // color count, reserved
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); // planes, bit depth
  entry.writeUInt32LE(pngBuf.length, 8);  // size of PNG data
  entry.writeUInt32LE(22, 12);            // offset (6 header + 16 entry)
  return Buffer.concat([header, entry, pngBuf]);
}

function findBrowser() {
  // Detect the system default browser from the registry and prefer it
  try {
    const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId 2>nul', { encoding: 'utf8' });
    if (/chrome/i.test(out)) return CHROME_PATHS.find(p => fs.existsSync(p)) || null;
    if (/edge/i.test(out))   return EDGE_PATHS.find(p => fs.existsSync(p))   || null;
  } catch (_) {}
  // Fallback: first installed browser
  return [...CHROME_PATHS, ...EDGE_PATHS].find(p => fs.existsSync(p)) || null;
}

function openApp(browserPath, pagePath = '') {
  const url = `http://${APP_HOST}${pagePath}`;
  if (browserPath) {
    spawn(browserPath, [`--app=${url}`, '--no-first-run'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    exec(`start ${url}`);
  }
}



function setupCustomDomain() {
  const batPath = path.join(DATA_DIR, 'setup-domain.bat');
  fs.writeFileSync(batPath, [
    '@echo off',
    `findstr /C:"${APP_HOST}" "C:\\Windows\\System32\\drivers\\etc\\hosts" > nul 2>&1`,
    `if errorlevel 1 echo 127.0.0.1 ${APP_HOST} >> "C:\\Windows\\System32\\drivers\\etc\\hosts"`,
    `netsh interface portproxy add v4tov4 listenport=80 listenaddress=127.0.0.1 connectport=${PORT} connectaddress=127.0.0.1`,
  ].join('\r\n'));
  try {
    execSync(`powershell -Command "Start-Process cmd -ArgumentList '/c \\"${batPath}\\"' -Verb RunAs -Wait -WindowStyle Hidden"`);
  } catch (_) {}
}

function firstRunSetup(browserPath) {
  setupCustomDomain(); // hosts file + port proxy (needs UAC, one-time)

  // Register silent startup VBS so server auto-starts on boot
  const vbsPath = path.join(DATA_DIR, 'PPSheet-startup.vbs');
  const exePath = process.execPath.replace(/\\/g, '\\\\');
  fs.writeFileSync(vbsPath, `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run Chr(34) & "${exePath}" & Chr(34), 0, False\n`);
  exec(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "PPSheet" /t REG_SZ /d "wscript.exe \\"${vbsPath.replace(/\\/g, '\\\\')}\\"" /f`, () => {});

  // Create desktop shortcut with custom icon via VBScript
  if (browserPath) {
    try {
      const icoPath = path.join(DATA_DIR, 'ppsheet.ico');
      const pngBuf = fs.readFileSync(path.join(__dirname, 'logo.png'));
      fs.writeFileSync(icoPath, pngToIco(pngBuf));

      const shortcutVbs = path.join(DATA_DIR, 'create-shortcut.vbs');
      const browserEsc = browserPath.replace(/\\/g, '\\\\');
      const icoEsc = icoPath.replace(/\\/g, '\\\\');
      fs.writeFileSync(shortcutVbs, [
        'Set WshShell = CreateObject("WScript.Shell")',
        'Set lnk = WshShell.CreateShortcut(WshShell.SpecialFolders("Desktop") & "\\PPSheet.lnk")',
        `lnk.TargetPath = "${browserEsc}"`,
        `lnk.Arguments = "--app=http://${APP_HOST} --no-first-run"`,
        `lnk.IconLocation = "${icoEsc},0"`,
        'lnk.Description = "PPSheet"',
        'lnk.Save',
      ].join('\n'));
      exec(`wscript.exe "${shortcutVbs}"`, () => {});
    } catch (_) {}
  }

  fs.writeFileSync(FIRST_RUN_FLAG, '1');
}

function downloadOsuFile(beatmapId) {
  return new Promise((resolve, reject) => {
    const cachePath = path.join(OSU_CACHE_DIR, `${beatmapId}.osu`);
    if (fs.existsSync(cachePath)) {
      resolve(fs.readFileSync(cachePath));
      return;
    }
    https.get(`https://osu.ppy.sh/osu/${beatmapId}`, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`osu file fetch failed: ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(cachePath, buf);
        resolve(buf);
      });
    }).on('error', reject);
  });
}

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

const IMPORT_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Import Data</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0e0e12;color:#e8e8f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;padding:24px}h2{color:#ff66aa}textarea{width:min(600px,100%);height:180px;background:#15151c;color:#e8e8f0;border:1px solid #333;border-radius:8px;padding:12px;font-size:13px;resize:vertical}button{background:#ff66aa;color:#fff;border:none;border-radius:8px;padding:12px 32px;font-size:15px;cursor:pointer;font-weight:700}button:hover{background:#cc4d88}#s{font-size:14px}</style>
</head><body>
<h2>Import localStorage Data</h2>
<p>Paste your exported JSON object and click Import.</p>
<textarea id="t" placeholder='{"key":"value",...}'></textarea>
<button onclick="imp()">Import</button>
<p id="s"></p>
<script>function imp(){try{var d=JSON.parse(document.getElementById('t').value);Object.entries(d).forEach(([k,v])=>localStorage.setItem(k,v));document.getElementById('s').style.color='#3de68a';document.getElementById('s').textContent='Done! Redirecting...';setTimeout(()=>location.href='/',1200);}catch(e){document.getElementById('s').style.color='#ff5555';document.getElementById('s').textContent='Error: '+e.message;}}</script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Import localStorage helper page
  if (req.method === 'GET' && req.url === '/import-data') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(IMPORT_HTML);
    return;
  }

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

  // Install page
  if (req.method === 'GET' && req.url === '/install') {
    fs.readFile(INSTALL_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // PWA manifest
  if (req.method === 'GET' && req.url === '/manifest.json') {
    fs.readFile(MANIFEST_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      res.end(data);
    });
    return;
  }

  // Service worker
  if (req.method === 'GET' && req.url === '/sw.js') {
    fs.readFile(SW_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' });
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

  // Rankings proxy
  const parsedUrl = new url.URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'GET' && parsedUrl.pathname === '/proxy/rankings') {
    const page = parseInt(parsedUrl.searchParams.get('page')) || 1;
    const country = (parsedUrl.searchParams.get('country') || '').toUpperCase().replace(/[^A-Z]/g, '');
    const countryParam = country ? `&country=${country}` : '';
    proxyRequest(
      `${OSU_API_BASE}/rankings/osu/performance?cursor%5Bpage%5D=${page}${countryParam}`,
      'GET',
      { 'Authorization': req.headers['authorization'] || '', 'Accept': 'application/json' },
      null, res
    );
    return;
  }

  // PP calculation via rosu-pp-js
  if (req.method === 'POST' && req.url === '/proxy/calculate') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { beatmapId, mods, combo, n100, n50, misses } = JSON.parse(body);
        const osuBytes = await downloadOsuFile(beatmapId);
        const beatmap = new Beatmap(osuBytes);
        const totalObjects = beatmap.nCircles + beatmap.nSliders + beatmap.nSpinners;
        const n300 = Math.max(0, totalObjects - (n100 || 0) - (n50 || 0) - (misses || 0));
        const perf = new Performance({
          mods: mods || 0,
          combo: combo || undefined,
          n300,
          n100: n100 || 0,
          n50: n50 || 0,
          misses: misses || 0,
          lazer: false,
        });
        const result = perf.calculate(beatmap);
        beatmap.free();
        perf.free();
        const acc = totalObjects > 0
          ? (300 * n300 + 100 * (n100 || 0) + 50 * (n50 || 0)) / (300 * totalObjects) * 100
          : 100;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pp: result.pp, acc }));
      } catch (e) {
        console.error('Calculate error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Already running — open the app and exit
    openApp(findBrowser());
    process.exit(0);
  } else {
    console.error('Server error:', e.message);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ppsheet running at http://localhost:${PORT}`);
  const browser = findBrowser();
  if (IS_FIRST_RUN) {
    firstRunSetup(browser);
    // Open install page as a regular Chrome tab so beforeinstallprompt fires
    const installUrl = `http://localhost:${PORT}/install`;
    if (browser) spawn(browser, [installUrl], { detached: true, stdio: 'ignore' }).unref();
    else exec(`start ${installUrl}`);
  } else if (!process.env.PPSHEET_DAEMON) {
    openApp(browser);
  }
});
