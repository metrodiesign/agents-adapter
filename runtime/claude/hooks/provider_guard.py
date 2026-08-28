#!/usr/bin/env python3
"""agents-adapter provider guard (Claude Code PreToolUse, matcher Agent|Task).

Denies spawning a security agent (auditor, skeptic, security-review, ...) when
ANTHROPIC_BASE_URL points at a provider other than Anthropic. Third-party
content filters (e.g. the OpenAI cyber filter) answer 400 on audit context and
flag that context permanently, so the subagent can never recover; the only fix
is to run security agents on Anthropic directly. Fails open on any error.
"""
from __future__ import annotations

import json
import os
import sys
from urllib.parse import urlparse

DEFAULT_CONFIG = os.path.join(os.path.expanduser("~"), ".claude", "hooks", "agents-adapter", "agents-adapter.config.json")
DEFAULT_SECURITY_AGENTS = ["auditor", "skeptic", "security-review", "security-reviewer", "security-auditor"]
DEFAULT_ANTHROPIC_HOSTS = ["api.anthropic.com"]
AGENT_TYPE_KEYS = ("subagent_type", "agent_type", "subagentType", "agentType", "type")


def host_from_url(url: str | None) -> str | None:
    if not url or not url.strip():
        return None
    try:
        host = urlparse(url.strip()).hostname
        return host.lower() if host else url.strip().lower()
    except Exception:
        return url.strip().lower()


def load_lists() -> tuple[list[str], list[str]]:
    path = os.environ.get("AGENTS_ADAPTER_CLAUDE_CONFIG", DEFAULT_CONFIG)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return (
            [str(x).lower() for x in (data.get("securityAgentTypes") or DEFAULT_SECURITY_AGENTS)],
            [str(x).lower() for x in (data.get("anthropicHosts") or DEFAULT_ANTHROPIC_HOSTS)],
        )
    except Exception:
        return ([x.lower() for x in DEFAULT_SECURITY_AGENTS], [x.lower() for x in DEFAULT_ANTHROPIC_HOSTS])


def decide(payload: dict, security_agents: list[str], anthropic_hosts: list[str], provider_host: str | None) -> str | None:
    """คืนข้อความ deny หรือ None เมื่ออนุญาต"""
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return None
    agent_type = ""
    for key in AGENT_TYPE_KEYS:
        v = tool_input.get(key)
        if isinstance(v, str) and v.strip():
            agent_type = v.strip().lower()
            break
    if not provider_host or provider_host in anthropic_hosts or agent_type not in security_agents:
        return None
    return (
        f"agents-adapter DENY [SECURITY_AGENT_PROVIDER]: security agent '{agent_type}' on third-party provider "
        f"{provider_host}: its content filter flags audit context permanently; run this agent on Anthropic directly "
        f"(a plain `claude` session), never resume the flagged agent."
    )


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        security_agents, anthropic_hosts = load_lists()
        reason = decide(payload, security_agents, anthropic_hosts, host_from_url(os.environ.get("ANTHROPIC_BASE_URL")))
        if reason is None:
            return 0
        out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}
        sys.stdout.write(json.dumps(out))
        return 0
    except Exception as exc:  # fail open
        sys.stderr.write(f"agents-adapter provider guard error (fail-open): {exc}\n")
        return 0


if __name__ == "__main__":
    sys.exit(main())
