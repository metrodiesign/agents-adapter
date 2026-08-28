"""
Python-side tests for the Codex hook policy engine.

Runs the shared fixtures (tests/fixtures/actions.json) through the Python
classifier so the Python implementation is verified even without Node.
"""
from __future__ import annotations

import io
import dataclasses
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agents_adapter_policy as policy  # noqa: E402
import policy_gate  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
FIXTURES = os.path.join(ROOT, "tests", "fixtures", "actions.json")
PROTECTED = os.path.join(ROOT, "policy", "protected-paths.yaml")


def _yaml_list(section: str) -> list[str]:
    """tiny reader for the flat list sections of protected-paths.yaml (no PyYAML dependency)."""
    out: list[str] = []
    active = False
    with open(PROTECTED, "r", encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            if not line.startswith(" ") and line.rstrip().endswith(":"):
                active = line.strip()[:-1] == section
                continue
            if active and line.strip().startswith("- "):
                out.append(line.strip()[2:].strip().strip('"'))
    return out


class World:
    def __init__(self) -> None:
        self.home = tempfile.mkdtemp(prefix="agents-adapter-py-")
        self.zone = os.path.join(self.home, "Desktop", "Project")
        self.cwd = os.path.join(self.zone, "app")
        os.makedirs(os.path.join(self.cwd, "src"))
        os.makedirs(os.path.join(self.home, ".ssh"))
        os.makedirs(os.path.join(self.home, "Documents"))
        os.symlink(os.path.join(self.home, ".ssh"), os.path.join(self.cwd, "link-to-ssh"))

    def ctx(self) -> policy.PolicyContext:
        h = self.home
        tmp = os.path.join(h, "tmp")
        expand = lambda p: p.replace("${HOME}", h).replace("${TMPDIR}", tmp)  # noqa: E731
        return policy.PolicyContext(
            home=h,
            tmpdir=tmp,
            cwd=self.cwd,
            development_roots=[self.zone],
            protected_branches=["main", "develop"],
            dev_env_patterns=[".env", ".env.local", ".env.development", ".env.test", ".env.testing", ".env.integration"],
            prod_env_patterns=[".env.production", ".env.production.*", ".env.prod", ".env.prod.*"],
            credential_paths=[expand(p) for p in _yaml_list("credential_paths")],
            credential_basenames=_yaml_list("credential_basenames"),
            credential_extensions=_yaml_list("credential_extensions"),
            system_config_paths=[expand(p) for p in _yaml_list("system_config_paths")],
            always_writable=[tmp, os.path.join(h, ".cache")],
            agent_config_dirs=[os.path.join(h, ".claude"), os.path.join(h, ".codex"), os.path.join(h, ".pi"), os.path.join(h, ".agents")],
        )

    def sub(self, value: str) -> str:
        return value.replace("{HOME}", self.home).replace("{ZONE}", self.zone).replace("{CWD}", self.cwd)

    def cleanup(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)


class FixtureParity(unittest.TestCase):
    def setUp(self) -> None:
        self.world = World()
        self.ctx = self.world.ctx()

    def tearDown(self) -> None:
        self.world.cleanup()

    def test_fixtures(self) -> None:
        with open(FIXTURES, "r", encoding="utf-8") as fh:
            cases = json.load(fh)["cases"]
        failures = []
        for c in cases:
            kind = c["kind"]
            if kind == "command" or kind == "pi_bash":
                v = policy.classify_command(self.world.sub(c["command"]), self.ctx)
            elif kind == "tool":
                inp = {k: (self.world.sub(x) if isinstance(x, str) else x) for k, x in c["tool"].get("input", {}).items()}
                ctx = dataclasses.replace(self.ctx, provider_host=c["providerHost"]) if c.get("providerHost") else self.ctx
                v = policy.classify_tool(c["tool"]["name"], inp, ctx)
            elif kind == "user_input":
                v = policy.classify_user_input(c["text"]) or policy.verdict("ALLOW", "SHELL_READ_ONLY", "input")
            else:
                self.fail(f"unknown kind {kind}")
            expected_rule = c.get("rule", c["id"])
            rule_ok = v.rule_id in c["ruleAny"] if "ruleAny" in c else v.rule_id == expected_rule
            if v.decision != c["expected"] or not rule_ok:
                failures.append(f"{c['id']} ({c['name']}): got {v.decision}/{v.rule_id}, expected {c['expected']}/{expected_rule}")
        self.assertEqual(failures, [], "\n".join(failures))


class HookProtocol(unittest.TestCase):
    def setUp(self) -> None:
        self.world = World()
        self.ctx = self.world.ctx()

    def tearDown(self) -> None:
        self.world.cleanup()

    def _run(self, tool: str, tool_input: dict) -> tuple[int, str, str]:
        payload = {"cwd": self.world.cwd, "hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input}
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            v = policy_gate.evaluate(payload, self.ctx)
            code = policy_gate.respond(v, "PreToolUse")
        return code, out.getvalue(), err.getvalue()

    def test_deny_exit_2_with_reason(self) -> None:
        code, out, err = self._run("Bash", {"command": "git push origin main"})
        self.assertEqual(code, 2)
        self.assertIn("DENY [GIT_PUSH_PROTECTED]", err)
        self.assertEqual(out, "")

    def test_ask_additional_context(self) -> None:
        code, out, _ = self._run("Bash", {"command": "rm -rf dist"})
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertIn("ASK [DESTRUCTIVE_DELETE]", data["hookSpecificOutput"]["additionalContext"])
        self.assertNotIn("permissionDecision", data["hookSpecificOutput"])

    def test_allow_silent(self) -> None:
        code, out, err = self._run("Bash", {"command": "npm test"})
        self.assertEqual((code, out, err), (0, "", ""))

    def test_connector_merge_denied(self) -> None:
        code, _, err = self._run("github.merge_pull_request", {"pull_number": 1})
        self.assertEqual(code, 2)
        self.assertIn("GH_PR_MERGE", err)

    def test_apply_patch_credential_denied(self) -> None:
        code, _, err = self._run("apply_patch", {"patch": "*** Begin Patch\n*** Add File: ../../../.ssh/authorized_keys\n+x\n*** End Patch"})
        self.assertEqual(code, 2)
        self.assertIn("CREDENTIAL_WRITE", err)

    def test_missing_config_fails_open_but_warns(self) -> None:
        os.environ["AGENTS_ADAPTER_CONFIG"] = "/nonexistent/agents-adapter.config.json"
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertIsNone(policy_gate.load_ctx(self.world.cwd))
        self.assertIn("config not found", err.getvalue())
        del os.environ["AGENTS_ADAPTER_CONFIG"]


if __name__ == "__main__":
    unittest.main()


class ProviderGuard(unittest.TestCase):
    """provider_guard.py ของ Claude ใช้ logic เดียวกับ classify_agent_spawn"""

    def setUp(self) -> None:
        guard_dir = os.path.join(ROOT, "runtime", "claude", "hooks")
        sys.path.insert(0, guard_dir)
        import provider_guard  # noqa: E402

        self.guard = provider_guard

    def test_deny_only_security_agent_on_third_party(self) -> None:
        sec, hosts = ["auditor", "skeptic"], ["api.anthropic.com"]
        deny = self.guard.decide({"tool_input": {"subagent_type": "Auditor"}}, sec, hosts, "127.0.0.1")
        self.assertIsNotNone(deny)
        self.assertIn("SECURITY_AGENT_PROVIDER", deny or "")
        self.assertIsNone(self.guard.decide({"tool_input": {"subagent_type": "auditor"}}, sec, hosts, None))
        self.assertIsNone(self.guard.decide({"tool_input": {"subagent_type": "auditor"}}, sec, hosts, "api.anthropic.com"))
        self.assertIsNone(self.guard.decide({"tool_input": {"subagent_type": "coder"}}, sec, hosts, "127.0.0.1"))

    def test_host_from_url(self) -> None:
        self.assertEqual(self.guard.host_from_url("http://127.0.0.1:8317"), "127.0.0.1")
        self.assertEqual(self.guard.host_from_url("https://api.anthropic.com"), "api.anthropic.com")
        self.assertIsNone(self.guard.host_from_url(""))
        self.assertIsNone(self.guard.host_from_url(None))
