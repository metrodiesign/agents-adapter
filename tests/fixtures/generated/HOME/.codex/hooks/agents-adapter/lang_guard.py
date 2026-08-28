#!/usr/bin/env python3
"""
agents-adapter Codex Stop hook: language backstop.

If the policy requires Thai replies and the last assistant message contains no
Thai characters (and is not just code), emit a system message reminding the
model. Never blocks, never prints secrets.
"""
from __future__ import annotations

import json
import re
import sys

THAI = re.compile(r"[฀-๿]")
CODE_FENCE = re.compile(r"```.*?```", re.S)


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0
    if payload.get("stop_hook_active"):
        return 0
    message = str(payload.get("last_assistant_message") or "")
    prose = CODE_FENCE.sub("", message).strip()
    if len(prose) < 40 or THAI.search(prose):
        return 0
    sys.stdout.write(json.dumps({"systemMessage": "agents-adapter: reply language must be Thai (technical terms may stay in English)."}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
