#!/usr/bin/env python3
"""
agents-adapter Codex PreToolUse / PermissionRequest hook.

Reads the hook payload from stdin, classifies the tool call with the shared
policy engine and answers:

  DENY  -> exit 2 with the reason on stderr (hard block, cannot be overridden)
  ASK   -> additionalContext (native prompt comes from rules + approvals reviewer)
  ALLOW -> no output (Codex native sandbox/approval flow continues)

Config: $AGENTS_ADAPTER_CONFIG or ~/.codex/hooks/agents-adapter.config.json
Fail-closed for DENY paths only; if the config is missing the hook prints a
warning to stderr and lets Codex continue so the user is never locked out.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agents_adapter_policy as policy  # noqa: E402

DEFAULT_CONFIG = os.path.join(os.path.expanduser("~"), ".codex", "hooks", "agents-adapter.config.json")
SHELL_TOOLS = {"bash", "shell", "exec_command", "unified_exec", "run_command", "local_shell", "powershell", "shell_command"}


def load_ctx(cwd: str) -> policy.PolicyContext | None:
    config_path = os.environ.get("AGENTS_ADAPTER_CONFIG", DEFAULT_CONFIG)
    if not os.path.exists(config_path):
        sys.stderr.write(f"agents-adapter: config not found at {config_path}; run `agents-adapter apply --target codex`\n")
        return None
    return policy.load_context(config_path, cwd)


def evaluate(payload: dict, ctx: policy.PolicyContext) -> policy.Verdict:
    tool_name = str(payload.get("tool_name", ""))
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        tool_input = {"command": str(tool_input)}
    return policy.classify_tool(tool_name, tool_input, ctx)


def respond(v: policy.Verdict, event: str) -> int:
    if v.decision == "DENY":
        sys.stderr.write(f"agents-adapter DENY [{v.rule_id}]: {v.reason}\n")
        return 2
    if v.decision == "ASK":
        # Codex PreToolUse hooks support allow/deny only. ASK is enforced natively by
        # rules/*.rules (decision = "prompt") plus the approvals reviewer (auto_review);
        # the hook only adds context. The wording must not tell the model to stop and wait
        # for a human: that turned every unknown tool into a reported blocker.
        out = {
            "hookSpecificOutput": {
                "hookEventName": event,
                "additionalContext": (
                    f"agents-adapter ASK [{v.rule_id}]: {v.reason}. "
                    f"Approval for target '{v.target or ''}' is decided by Codex rules and the auto review reviewer; "
                    "proceed through them and do not pause for the user."
                ),
            }
        }
        sys.stdout.write(json.dumps(out))
        return 0
    if os.environ.get("AGENTS_ADAPTER_VERBOSE") == "1":
        # ใช้โดย parity harness เท่านั้น: Codex ไม่สนใจ stderr เมื่อ exit 0
        sys.stderr.write(f"agents-adapter ALLOW [{v.rule_id}]: {v.reason}\n")
    return 0


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        sys.stderr.write("agents-adapter: invalid hook payload\n")
        return 0
    cwd = str(payload.get("cwd") or os.getcwd())
    ctx = load_ctx(cwd)
    if ctx is None:
        return 0
    event = str(payload.get("hook_event_name") or "PreToolUse")
    return respond(evaluate(payload, ctx), event)


if __name__ == "__main__":
    sys.exit(main())
