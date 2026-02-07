from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from echo_mind.pulse import run_pulse


def _authorized(path: str, headers) -> bool:
    """Simple shared-secret gate for cron invocations.

    - If ECHO_CRON_SECRET is unset, allow (useful for local/dev).
    - Otherwise accept either:
        * Header: x-echo-cron-secret: <secret>
        * Query:  ?secret=<secret>
    """
    secret = os.environ.get("ECHO_CRON_SECRET")
    if not secret:
        return True

    # Header
    header_secret = headers.get("x-echo-cron-secret") or headers.get("X-Echo-Cron-Secret")
    if header_secret and header_secret == secret:
        return True

    # Query param
    qs = parse_qs(urlparse(path).query)
    q_secret = (qs.get("secret") or [None])[0]
    return bool(q_secret and q_secret == secret)


class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.path.startswith("/api/pulse"):
            self._send(404, {"ok": False, "error": "not_found"})
            return

        if not _authorized(self.path, self.headers):
            self._send(401, {"ok": False, "error": "unauthorized"})
            return

        if not os.environ.get("OPENAI_API_KEY"):
            self._send(500, {"ok": False, "error": "OPENAI_API_KEY not set"})
            return

        result = run_pulse(mode="pulse")
        self._send(
            200,
            {
                "ok": True,
                "mode": result.get("mode"),
                "model": result.get("model"),
                "should_post": result.get("should_post"),
                "content": result.get("content"),
                "response_id": result.get("response_id"),
            },
        )

    def do_POST(self):
        # Cron should call GET, but allow POST too.
        self.do_GET()
