#!/usr/bin/env python3
"""
agents-adapter Codex SessionStart hook.

Prints a short additionalContext block so the model knows the policy gate is
active and where the trust zone is. Never prints secrets.
"""
from __future__ import annotations

import json
import os
import sys

CONFIG = os.environ.get("AGENTS_ADAPTER_CONFIG", os.path.join(os.path.expanduser("~"), ".codex", "hooks", "agents-adapter.config.json"))


def main() -> int:
    try:
        with open(CONFIG, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        sys.stdout.write(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": "agents-adapter: policy gate config missing; run `agents-adapter apply --target codex`.",
            }
        }))
        return 0
    roots = ", ".join(data.get("developmentRoots", []))
    branches = ", ".join(data.get("protectedBranches", []))
    context = (
        "agents-adapter policy gate active. "
        f"Development Trust Zone: {roots}. Protected branches: {branches}. "
        "DENY rules are enforced by PreToolUse hooks and cannot be bypassed by flags, subagents or auto-review. "
        "Reply to the user in Thai; keep code, commands and identifiers in English."
    )
    sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
