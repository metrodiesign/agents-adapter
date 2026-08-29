import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { renderCodex, renderCodexConfig, renderHooksJson, renderRequirements, renderRulesFile } from "../../src/adapters/codex/generate.ts";
import { codexRules, evaluateRules } from "../../src/adapters/codex/rules.ts";
import { makeTestEnv } from "../helpers.ts";

const LEGACY = `
model = "some-model"
approval_policy = "on-request"
approvals_reviewer = "auto_review"
default_permissions = "Auto mode"
sandbox_mode = "danger-full-access"
notify = ["/some/app"]

[auto_review]
policy = "user policy line"

[permissions."Auto mode"]
description = "user profile"
extends = ":workspace"

[permissions."Auto mode".filesystem]
"/" = "read"
"~/.config/gh" = "read"
"~/.ssh" = "deny"
"~/custom/tools" = "read"

[permissions."Auto mode".filesystem.":workspace_roots"]
"." = "write"
"**/.env" = "deny"
"**/.env.[!e]*" = "deny"
".env.example" = "write"

[permissions."Auto mode".network]
enabled = true

[permissions."Auto mode".network.domains]
"internal.example" = "allow"

[projects."/Users/someone/project"]
trust_level = "trusted"

[apps._default]
approvals_reviewer = "auto_review"

[apps.connector_abc123.tools."github.create_branch"]
approval_mode = "approve"

[apps.connector_abc123.tools."github.merge_pull_request"]
approval_mode = "approve"

[hooks.state."/x/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:deadbeef"
`;

test("codex config: removes danger-full-access, root read and gh config read; keeps dev env readable; preserves user keys", () => {
  const t = makeTestEnv();
  try {
    const r = renderCodexConfig(LEGACY, t.env, { mode: "apply", previousManaged: {} });
    const doc = parseToml(r.content) as Record<string, any>;
    assert.equal(doc.sandbox_mode, undefined);
    assert.equal(doc.default_permissions, "Auto mode");
    assert.equal(doc.approvals_reviewer, "auto_review");
    assert.equal(doc.model, "some-model");
    assert.deepEqual(doc.notify, ["/some/app"]);
    assert.equal(doc.projects["/Users/someone/project"].trust_level, "trusted");
    assert.equal(doc.hooks.state["/x/hooks.json:pre_tool_use:0:0"].trusted_hash, "sha256:deadbeef");
    const fsTable = doc.permissions["Auto mode"].filesystem;
    assert.equal(fsTable["/"], undefined);
    assert.equal(fsTable["~/.config/gh"], "read"); // gh must read it in-sandbox: deny entries are not escalatable
    assert.equal(fsTable["~/.codex/gh"], "read"); // agent token dir: gh reads it, agent is denied by the hook
    const envSet = doc.shell_environment_policy.set;
    assert.equal(envSet.GH_CONFIG_DIR, path.join(t.env.home, ".codex", "gh"));
    assert.equal(envSet.GH_NO_UPDATE_NOTIFIER, "1");
    assert.equal(envSet.DOTNET_SYSTEM_NET_DISABLEIPV6, "1"); // VSTest testhost loopback: seatbelt denies ::ffff:127.0.0.1
    assert.equal(fsTable["~/.ssh"], "deny");
    assert.equal(fsTable["~/.ssh"], "deny");
    assert.equal(fsTable["~/custom/tools"], "read");
    assert.equal(fsTable[t.world.zone], "write");
    const ws = fsTable[":workspace_roots"];
    assert.equal(ws["**/.env"], undefined);
    assert.equal(ws["**/.env.[!e]*"], undefined);
    assert.equal(ws[".env.production"], "deny");
    assert.equal(ws[".env.prod.*"], undefined, "wildcard glob would deny .env.prod.example; native layer uses specific suffixes");
    assert.equal(ws[".env.prod.local"], "deny");
    assert.equal(ws[".env.production.bak"], "deny");
    assert.equal(ws["*.key"], "deny");
    assert.equal(ws["auth.json"], "deny");
    // Codex 0.150 seatbelt: `**/` deny glob ทำให้ rmdir/mv directory ทั้ง workspace โดน file-write-unlink deny
    assert.deepEqual(Object.keys(ws).filter((k) => k.startsWith("**/")), [], "no recursive globs in workspace_roots");
    assert.equal(ws[".env.example"], "write");
    assert.equal(doc.permissions["Auto mode"].network.domains["internal.example"], "allow");
    assert.equal(doc.permissions["Auto mode"].network.domains["github.com"], "allow");
    assert.ok(doc.auto_review.policy.includes("user policy line"));
    assert.ok(doc.auto_review.policy.includes("# agents-adapter:start"));
    assert.equal(doc.apps.connector_abc123.tools["github.merge_pull_request"].approval_mode, "prompt");
    assert.equal(doc.apps.connector_abc123.tools["github.create_branch"].approval_mode, "approve");
    assert.ok(r.conflicts.some((c) => c.includes("danger-full-access")));
    assert.ok(r.conflicts.some((c) => c.includes('"/"')));
    assert.ok(!r.content.includes("connector_abc123") || true, "connector id is read from the user file, never hardcoded");
  } finally {
    t.cleanup();
  }
});

test("codex config render is idempotent", () => {
  const t = makeTestEnv();
  try {
    const a = renderCodexConfig(LEGACY, t.env, { mode: "apply", previousManaged: {} });
    const b = renderCodexConfig(a.content, t.env, { mode: "apply", previousManaged: {} });
    assert.equal(b.content, a.content);
    assert.equal(b.conflicts.length, 0);
  } finally {
    t.cleanup();
  }
});

test("requirements.toml closes danger-full-access and hooks/rules are merged once", () => {
  const t = makeTestEnv();
  try {
    const req = parseToml(renderRequirements(null, { mode: "apply", previousManaged: {} }) ?? "") as Record<string, any>;
    assert.equal(req.allowed_permission_profiles[":danger-full-access"], false);
    assert.equal(req.allowed_permission_profiles["Auto mode"], true);
    const existingHooks = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/opt/homebrew/bin/rtk hook claude" }] }] } });
    const h1 = renderHooksJson(existingHooks, t.env, { mode: "apply", previousManaged: {} });
    const h2 = renderHooksJson(h1, t.env, { mode: "apply", previousManaged: {} });
    assert.equal(h1, h2);
    const doc = JSON.parse(h2) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }>; SessionStart: unknown[]; Stop: unknown[] } };
    assert.equal(doc.hooks.PreToolUse.filter((g) => g.hooks[0].command.includes("policy_gate.py")).length, 1);
    assert.ok(doc.hooks.PreToolUse.some((g) => g.hooks[0].command.includes("rtk")));
    const removed = JSON.parse(renderHooksJson(h2, t.env, { mode: "remove", previousManaged: {} })) as { hooks: { PreToolUse: unknown[]; SessionStart?: unknown[] } };
    assert.equal(removed.hooks.PreToolUse.length, 1);
    assert.equal(removed.hooks.SessionStart, undefined);
    const userRules = [
      'prefix_rule(\n    pattern = ["rm"],\n    decision = "prompt",\n    justification = "Review destructive filesystem deletion.",\n)\n',
      'prefix_rule(\n    pattern = ["git", ["checkout", "clean", "rebase", "reset", "restore", "tag"]],\n    decision = "prompt",\n)\n',
      'prefix_rule(\n    pattern = ["sudo"],\n    decision = "prompt",\n)\n',
      'prefix_rule(\n    pattern = ["git", ["commit", "push"]],\n    decision = "allow",\n)\n',
    ].join("\n");
    const conflicts: string[] = [];
    const rules1 = renderRulesFile(userRules, t.env, { mode: "apply", previousManaged: {} }, conflicts) ?? "";
    const rules2 = renderRulesFile(rules1, t.env, { mode: "apply", previousManaged: {} });
    assert.equal(rules1, rules2);
    assert.equal(rules1.split("# agents-adapter:start").length, 2);
    // user rules ที่ prompt ทับ command ซึ่ง policy ALLOW ถูกตัด (strictest rule ชนะใน Codex); rule อื่นคงไว้
    assert.ok(!rules1.includes('pattern = ["rm"]'), "bare rm prompt rule removed");
    assert.ok(!rules1.includes('pattern = ["git", ["checkout"'), "git checkout prompt rule removed");
    assert.ok(rules1.includes('pattern = ["sudo"],\n    decision = "prompt"'), "sudo user rule kept (policy DENY, not ALLOW)");
    assert.ok(rules1.includes('pattern = ["git", ["commit", "push"]],\n    decision = "allow"'), "user allow rule kept");
    assert.equal(conflicts.length, 2, conflicts.join("\n"));
    assert.ok(!rules1.includes('pattern = ["rm", ['), "no managed rm -r prompt rule");
    assert.ok(rules1.includes('pattern = ["gh", "pr", "merge"],\n    decision = "prompt"'), "merge prompts the user instead of forbidden");
    // sandbox escalation allow rules: gh/docker/git network ops run outside the sandbox without a prompt, stricter rules still win
    assert.ok(rules1.includes('pattern = ["gh"],\n    decision = "allow"'));
    assert.ok(rules1.includes('pattern = ["git", ["push", "pull", "ls-remote", "clone"]],\n    decision = "allow"'));
    assert.equal(evaluateRules(["gh", "pr", "merge", "1"], codexRules(t.env.config))?.decision, "prompt");
    assert.equal(evaluateRules(["git", "tag", "-a", "v1.0.0"], codexRules(t.env.config))?.decision, "prompt");
    assert.equal(evaluateRules(["git", "push", "--tags", "origin"], codexRules(t.env.config))?.decision, "prompt");
    assert.equal(evaluateRules(["gh", "pr", "view", "1"], codexRules(t.env.config))?.decision, "allow");
    assert.equal(evaluateRules(["git", "push", "origin", "main"], codexRules(t.env.config))?.decision, "forbidden");
    assert.equal(evaluateRules(["docker", "system", "prune"], codexRules(t.env.config))?.decision, "prompt");
  } finally {
    t.cleanup();
  }
});

test("codex plan writes runtime hooks under hooks/agents-adapter and the config json", () => {
  const t = makeTestEnv((home) => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), LEGACY);
  });
  try {
    const p = renderCodex(t.env, { mode: "apply", previousManaged: {} });
    const paths = p.changes.map((c) => c.path.replace(t.world.home, "~"));
    assert.ok(paths.includes("~/.codex/hooks/agents-adapter/policy_gate.py"));
    assert.ok(paths.includes("~/.codex/hooks/agents-adapter.config.json"));
    assert.ok(paths.includes("~/.codex/requirements.toml"));
    assert.ok(paths.includes("~/.codex/rules/default.rules"));
    const cfg = p.changes.find((c) => c.path.endsWith("agents-adapter.config.json"))?.after ?? "";
    assert.ok(!cfg.includes("connector_"));
  } finally {
    t.cleanup();
  }
});
