#!/usr/bin/env python3
"""
ppsheet local dev server
Serves pp-tracker (2).html and proxies osu! API calls to avoid CORS issues.
Auto-shuts down when the browser tab is closed.
Run: python server.py  (or double-click start.bat)
"""
import json
import re
import os
import time
import threading
import webbrowser
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 8080
HTML_FILE = 'pp-tracker (2).html'
OSU_TOKEN_URL = 'https://osu.ppy.sh/oauth/token'
OSU_API_BASE  = 'https://osu.ppy.sh/api/v2'
PING_TIMEOUT  = 12  # seconds without a ping before auto-shutdown

last_ping = time.time()
_server = None


def watchdog():
    """Shut down if the browser stops sending heartbeats."""
    time.sleep(PING_TIMEOUT)  # grace period for browser to open
    while True:
        time.sleep(2)
        if time.time() - last_ping > PING_TIMEOUT:
            _server.shutdown()
            break


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # silence request logs when running windowless

    def _send_bytes(self, code, content_type, data: bytes):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, code, obj):
        self._send_bytes(code, 'application/json', json.dumps(obj).encode())

    def _proxy_response(self, resp_or_err):
        if isinstance(resp_or_err, urllib.error.HTTPError):
            data = resp_or_err.read()
            ct = resp_or_err.headers.get('Content-Type', 'application/json')
            self._send_bytes(resp_or_err.code, ct, data)
        else:
            data = resp_or_err.read()
            ct = resp_or_err.headers.get('Content-Type', 'application/json')
            self._send_bytes(200, ct, data)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)

        # Beatmap attributes proxy (needs auth forwarded)
        m = re.match(r'^/proxy/beatmap-attributes/(\d+)$', self.path)
        if m:
            beatmap_id = m.group(1)
            auth = self.headers.get('Authorization', '')
            try:
                req = urllib.request.Request(
                    f'{OSU_API_BASE}/beatmaps/{beatmap_id}/attributes',
                    data=body, method='POST',
                    headers={'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': auth}
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    self._proxy_response(resp)
            except urllib.error.HTTPError as e:
                self._proxy_response(e)
            except Exception as ex:
                self._send_json(502, {'error': str(ex)})
            return

        if self.path == '/proxy/token':
            target = OSU_TOKEN_URL
        else:
            self.send_response(404); self.end_headers(); return

        try:
            req = urllib.request.Request(
                target, data=body, method='POST',
                headers={'Content-Type': 'application/json', 'Accept': 'application/json'}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                self._proxy_response(resp)
        except urllib.error.HTTPError as e:
            self._proxy_response(e)
        except Exception as ex:
            self._send_json(502, {'error': str(ex)})

    def do_GET(self):
        global last_ping

        # Heartbeat — browser pings this to keep server alive
        if self.path == '/ping':
            last_ping = time.time()
            self._send_bytes(200, 'text/plain', b'ok')
            return

        # Beatmap proxy
        m = re.match(r'^/proxy/beatmap/(\d+)$', self.path)
        if m:
            beatmap_id = m.group(1)
            auth = self.headers.get('Authorization', '')
            try:
                req = urllib.request.Request(
                    f'{OSU_API_BASE}/beatmaps/{beatmap_id}',
                    headers={'Authorization': auth, 'Accept': 'application/json'}
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    self._proxy_response(resp)
            except urllib.error.HTTPError as e:
                self._proxy_response(e)
            except Exception as ex:
                self._send_json(502, {'error': str(ex)})
            return

        # Serve the HTML app
        if self.path in ('/', '/index.html'):
            filepath = os.path.join(os.path.dirname(os.path.abspath(__file__)), HTML_FILE)
            try:
                with open(filepath, 'rb') as f:
                    data = f.read()
                self._send_bytes(200, 'text/html; charset=utf-8', data)
            except FileNotFoundError:
                self._send_json(404, {'error': f'{HTML_FILE} not found'})
            return

        self.send_response(404); self.end_headers()


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    _server = HTTPServer(('', PORT), Handler)
    threading.Thread(target=watchdog, daemon=True).start()
    def open_in_chrome(url):
        chrome_candidates = [
            r'C:\Program Files\Google\Chrome\Application\chrome.exe',
            r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
            os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe'),
        ]
        chrome_path = next((p for p in chrome_candidates if os.path.exists(p)), None)
        if chrome_path:
            webbrowser.register('chrome', None, webbrowser.BackgroundBrowser(chrome_path))
            webbrowser.get('chrome').open(url)
        else:
            webbrowser.open(url)  # fall back to default browser
    threading.Timer(0.5, open_in_chrome, args=[f'http://localhost:{PORT}']).start()
    _server.serve_forever()
