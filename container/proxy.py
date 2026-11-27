"""Fetch proxy that sends requests with a Chrome TLS fingerprint.

POST /fetch {"url", "method", "headers", "body"} ->
{"status", "url", "set_cookies": [{"name", "value"}], "body"}

Only read.amazon.* hosts are allowed. The proxy keeps no state and logs no
headers or bodies.
"""
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from curl_cffi import requests

ALLOWED_HOST = re.compile(r"^read\.amazon\.[a-z.]{2,6}$")
IMPERSONATE = "chrome"


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True})

    def do_POST(self):
        if self.path != "/fetch":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length))
            parts = urlsplit(req["url"])
            if parts.scheme != "https" or not ALLOWED_HOST.match(parts.hostname or ""):
                return self._send(403, {"error": "host not allowed"})
            # The impersonation profile sets its own User-Agent to match the TLS hello.
            headers = {k: v for k, v in (req.get("headers") or {}).items() if k.lower() != "user-agent"}
            resp = requests.request(
                req.get("method") or "GET",
                req["url"],
                headers=headers,
                data=req.get("body"),
                impersonate=IMPERSONATE,
                allow_redirects=True,
                timeout=30,
            )
            self._send(200, {
                "status": resp.status_code,
                "url": resp.url,
                "set_cookies": [{"name": k, "value": v} for k, v in resp.cookies.items()],
                "body": resp.text,
            })
        except Exception as error:  # noqa: BLE001
            self._send(502, {"error": f"{type(error).__name__}: {error}"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
