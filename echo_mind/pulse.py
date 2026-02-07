from __future__ import annotations

import os
from typing import Any, Dict, Optional

from dotenv import load_dotenv

from echo_mind.memory import build_memory_store
from echo_mind.thinker import run_echo_thought
from echo_surface import console as console_surface


def run_pulse(*, mode: str = "pulse", user_message: Optional[str] = None) -> Dict[str, Any]:
    """
    Single entrypoint for both scheduled pulse and manual invocation.
    Loads env, memory, prompt scaffold, calls model, writes memory, and posts to surface.
    """
    load_dotenv()

    model = os.environ.get("OPENAI_MODEL", "gpt-4o-2024-08-06")
    # memory backend is selected automatically (Upstash REST if available; otherwise local file)
    max_memory_chars = int(os.environ.get("ECHO_MAX_MEMORY_CHARS", "20000"))
    max_output_chars = int(os.environ.get("ECHO_MAX_OUTPUT_CHARS", "8000"))

    prompt_path = os.path.join(os.path.dirname(__file__), "prompt.txt")
    with open(prompt_path, "r", encoding="utf-8") as f:
        prompt_scaffold = f.read()

    store = build_memory_store()
    memory = store.load()

    result = run_echo_thought(
        model=model,
        prompt_scaffold=prompt_scaffold,
        memory=memory,
        mode=mode,
        user_message=user_message,
        max_memory_chars=max_memory_chars,
        max_output_chars=max_output_chars,
    )

    # Always record the content (even silence), but only post if should_post is true.
    event = "pulse" if mode == "pulse" else "manual"
    store.append_event(event=event, content=result.get("content", ""), meta={
        "model": result.get("model"),
        "should_post": result.get("should_post"),
        "response_id": result.get("response_id"),
    })

    if result.get("should_post") and result.get("content"):
        # Surface selection can become pluggable later.
        surface = os.environ.get("ECHO_SURFACE", "console")
        if surface == "console":
            console_surface.post(result["content"])

    return result
