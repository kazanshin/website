from __future__ import annotations

from datetime import datetime


def post(text: str) -> None:
    ts = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    print("\n" + "=" * 72)
    print(f"[echo-pulse] {ts}")
    print("-" * 72)
    print(text.rstrip())
    print("=" * 72 + "\n")
