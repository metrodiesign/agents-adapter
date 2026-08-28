#!/usr/bin/env python3
"""
agents-adapter Codex hook for file tools (Read/Write/Edit/apply_patch).

Second layer behind policy_gate.py: even if the generic gate is disabled,
credential and production env paths stay hard-blocked. Shares the policy
engine, so the answer is identical to policy_gate.py for path operations.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agents_adapter_policy as policy  # noqa: E402
import policy_gate  # noqa: E402

FILE_TOOLS = {"read", "write", "edit", "multiedit", "apply_patch", "notebookedit", "read_file", "write_file", "create_file"}


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0
    tool = str(payload.get("tool_name", "")).lower()
    if tool not in FILE_TOOLS:
        return 0
    ctx = policy_gate.load_ctx(str(payload.get("cwd") or os.getcwd()))
    if ctx is None:
        return 0
    v = policy_gate.evaluate(payload, ctx)
    if v.rule_id in ("CREDENTIAL_READ", "CREDENTIAL_WRITE", "PROD_ENV_READ", "PROD_ENV_WRITE"):
        sys.stderr.write(f"agents-adapter DENY [{v.rule_id}]: {v.reason}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
