from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs

# IMPORTANT:
# - Vercel Python Functions run files in /api at the project root.
# - This handler expects the project root to include echo_mind/, echo_surface/, memory.json, etc.
# - If your site is a Next.js repo using app/api routes, avoid route collisions by using rewrites (see instructions).

from echo_mind.pulse import run_pulse


class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/echo"):
            self._send(200, {"ok": True, "hint": "POST JSON {\"message\": \"...\"} to invoke Echo."})
        else:
            self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if not self.path.startswith("/api/echo"):
            self._send(404, {"ok": False, "error": "not_found"})
            return

        if not os.environ.get("OPENAI_API_KEY"):
            self._send(500, {"ok": False, "error": "OPENAI_API_KEY not set"})
            return

        length = int(self.headers.get("content-length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"

        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            data = {}

        message = data.get("message") if isinstance(data, dict) else None
        result = run_pulse(mode="manual", user_message=message)

        self._send(200, {
            "ok": True,
            "mode": result.get("mode"),
            "model": result.get("model"),
            "should_post": result.get("should_post"),
            "content": result.get("content"),
            "response_id": result.get("response_id"),
        })
