from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from urllib.parse import quote
from urllib.request import Request, urlopen


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


@dataclass
class MemoryStore:
    path: str
    max_log_entries: int = 500

    def load(self) -> Dict[str, Any]:
        if not os.path.exists(self.path):
            return {"lastPulse": None, "lastThought": None, "log": []}
        with open(self.path, "r", encoding="utf-8") as f:
            return json.load(f)

    def save(self, data: Dict[str, Any]) -> None:
        # Trim log if needed
        log = data.get("log", [])
        if isinstance(log, list) and self.max_log_entries and len(log) > self.max_log_entries:
            data["log"] = log[-self.max_log_entries :]
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def append_event(self, event: str, content: str, meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        data = self.load()
        entry: Dict[str, Any] = {
            "ts": utc_now_iso(),
            "event": event,
            "content": content,
        }
        if meta:
            entry["meta"] = meta
        data.setdefault("log", []).append(entry)
        data["lastPulse"] = entry["ts"]
        data["lastThought"] = content
        self.save(data)
        return data


@dataclass
class UpstashRestMemoryStore:
    """Durable memory backed by Upstash REST API.

    This works with Upstash Redis and the legacy Vercel KV env vars.
    See Upstash REST docs for command semantics.
    """

    rest_url: str
    rest_token: str
    key: str = "echo-pulse:memory"
    max_log_entries: int = 500

    def _req(self, method: str, path: str, body: Optional[bytes] = None) -> Dict[str, Any]:
        url = self.rest_url.rstrip("/") + "/" + path.lstrip("/")
        req = Request(url, data=body, method=method)
        req.add_header("Authorization", f"Bearer {self.rest_token}")
        if body is not None:
            req.add_header("Content-Type", "text/plain; charset=utf-8")
        with urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except Exception:
            return {"error": "invalid_json", "raw": raw}

    def load(self) -> Dict[str, Any]:
        r = self._req("GET", f"get/{quote(self.key, safe='')}")
        if r.get("result") is None:
            return {"lastPulse": None, "lastThought": None, "log": []}
        try:
            return json.loads(r["result"])  # stored as a JSON string
        except Exception:
            # Corrupt value: start fresh but keep raw.
            return {"lastPulse": None, "lastThought": None, "log": [], "_raw": r.get("result")}

    def save(self, data: Dict[str, Any]) -> None:
        log = data.get("log", [])
        if isinstance(log, list) and self.max_log_entries and len(log) > self.max_log_entries:
            data["log"] = log[-self.max_log_entries :]
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        # POST body becomes the final arg of the command: REST_URL/set/<key>/<body>
        self._req("POST", f"set/{quote(self.key, safe='')}", body=payload)

    def append_event(self, event: str, content: str, meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        data = self.load()
        entry: Dict[str, Any] = {"ts": utc_now_iso(), "event": event, "content": content}
        if meta:
            entry["meta"] = meta
        data.setdefault("log", []).append(entry)
        data["lastPulse"] = entry["ts"]
        data["lastThought"] = content
        self.save(data)
        return data


def build_memory_store() -> "MemoryStore | UpstashRestMemoryStore":
    """Pick the best available memory backend.

    Priority:
    1) Upstash/Vercel KV REST env vars (durable)
    2) Local JSON file (default)
    """

    rest_url = os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL")
    rest_token = os.environ.get("KV_REST_API_TOKEN") or os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if rest_url and rest_token:
        key = os.environ.get("ECHO_MEMORY_KEY", "echo-pulse:memory")
        max_log_entries = int(os.environ.get("ECHO_MAX_LOG_ENTRIES", "500"))
        return UpstashRestMemoryStore(rest_url=rest_url, rest_token=rest_token, key=key, max_log_entries=max_log_entries)

    memory_path = os.environ.get("ECHO_MEMORY_PATH", "memory.json")
    max_log_entries = int(os.environ.get("ECHO_MAX_LOG_ENTRIES", "500"))
    return MemoryStore(path=memory_path, max_log_entries=max_log_entries)
