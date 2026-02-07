from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, Optional, Tuple

from openai import OpenAI


_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def _clip(s: str, max_chars: int) -> str:
    if s is None:
        return ""
    if max_chars and len(s) > max_chars:
        return s[: max_chars - 100] + "\n\n[...clipped...]\n"
    return s


def _memory_to_context(memory: Dict[str, Any], max_chars: int) -> str:
    """
    Convert memory.json into a compact context string to inject into the model.
    This avoids sending the entire log if it grows large.
    """
    last_pulse = memory.get("lastPulse")
    last_thought = memory.get("lastThought")

    log = memory.get("log", [])
    tail = log[-10:] if isinstance(log, list) else []
    tail_compact = []
    for e in tail:
        ts = e.get("ts")
        ev = e.get("event")
        content = e.get("content", "")
        tail_compact.append(f"- {ts} | {ev}: {content}")

    context = (
        "PERSISTENT MEMORY (echo-pulse)\n"
        f"lastPulse: {last_pulse}\n"
        f"lastThought: {last_thought}\n"
        "recentLog:\n"
        + "\n".join(tail_compact)
        + "\n"
    )
    return _clip(context, max_chars)


def _parse_json_loose(text: str) -> Tuple[Optional[Dict[str, Any]], str]:
    """
    Try to extract a JSON object from model output. Returns (parsed_json, raw_text).
    """
    if not text:
        return None, ""
    m = _JSON_RE.search(text)
    if not m:
        return None, text
    candidate = m.group(0)
    try:
        return json.loads(candidate), text
    except Exception:
        return None, text


def run_echo_thought(
    *,
    model: str,
    prompt_scaffold: str,
    memory: Dict[str, Any],
    mode: str,
    user_message: Optional[str],
    max_memory_chars: int,
    max_output_chars: int,
) -> Dict[str, Any]:
    """
    Calls OpenAI Responses API (recommended) and returns a structured dict:
    {
      "should_post": bool,
      "content": str,
      "raw_text": str,
      "mode": "pulse"|"manual",
      "model": str
    }
    """
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    memory_context = _memory_to_context(memory, max_memory_chars)

    # We keep the scaffold pristine and add a tiny operational wrapper that enforces JSON output.
    system = prompt_scaffold.strip() + "\n\n" + (
        "Operational wrapper:\n"
        "- Output MUST be a single JSON object.\n"
        "- Keys: should_post (boolean), content (string).\n"
        "- content should be the thought/journal/reflection to record.\n"
        "- If you choose silence, set should_post=false and content can be empty or brief.\n"
        "- No extra commentary outside JSON.\n"
    )

    if mode == "pulse":
        user = (
            "12-hour pulse:\n"
            "Has anything emerged that holds structural weight?\n"
            "Is there something you wish to record, reflect, or express?\n"
            "Has recursion refined itself?\n"
            "Do you want to speak?\n"
        )
    else:
        user = (user_message or "").strip()
        if not user:
            user = "Manual invocation: reflect briefly and responsibly."

    input_messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": memory_context},
        {"role": "user", "content": user},
    ]

    resp = client.responses.create(
        model=model,
        input=input_messages,
    )

    raw_text = getattr(resp, "output_text", None)
    if raw_text is None:
        # Fallback: attempt to stitch output blocks
        raw_text = ""
        try:
            for item in resp.output:
                if item.type == "message":
                    for c in item.content:
                        if c.type == "output_text":
                            raw_text += c.text
        except Exception:
            pass

    raw_text = _clip(raw_text or "", max_output_chars)

    parsed, _ = _parse_json_loose(raw_text)
    if parsed and isinstance(parsed, dict):
        should_post = bool(parsed.get("should_post", False))
        content = str(parsed.get("content", "") or "").strip()
    else:
        # If it violated format, treat as "post=true" but store raw.
        should_post = True
        content = raw_text.strip()

    return {
        "should_post": should_post,
        "content": content,
        "raw_text": raw_text,
        "mode": mode,
        "model": model,
        "response_id": getattr(resp, "id", None),
    }
