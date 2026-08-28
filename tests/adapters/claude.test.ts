import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { renderClaude, renderClaudeSettings } from "../../src/adapters/claude/generate.ts";
import { makeTestEnv } from "../helpers.ts";

const USER_SETTINGS = {
  model: "custom-model",
  enabledPlugins: { "x@y": true },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
  permissions: { allow: ["Bash(my-tool *)"], deny: ["Bash(rm -rf /)"], defaultMode: "auto", additionalDirectories: ["/opt/custom"] },
  sandbox: { network: { allowedDomains: ["internal.example"] } },
  autoMode: { allow: ["$defaults", "user rule"] },
  unknownFutureKey: { nested: true },
};

test("claude settings merge preserves user keys, unknown keys and user entries", () => {
  const t = makeTestEnv();
  try {
    const r = renderClaudeSettings(JSON.stringify(USER_SETTINGS), t.env, { mode: "apply", previousManaged: {} });
    const out = JSON.parse(r.content) as typeof USER_SETTINGS & { permissions: { ask: string[] }; language: string };
    assert.equal(out.model, "custom-model");
    assert.deepEqual(out.enabledPlugins, USER_SETTINGS.enabledPlugins);
    assert.deepEqual(out.hooks, USER_SETTINGS.hooks);
    assert.deepEqual(out.unknownFutureKey, USER_SETTINGS.unknownFutureKey);
    assert.ok(out.permissions.allow.includes("Bash(my-tool *)"));
    assert.ok(out.permissions.deny.includes("Bash(rm -rf /)"));
    assert.ok(out.permissions.deny.includes("Bash(git push * main)"));
    assert.ok(out.permissions.ask.includes("Bash(rm -rf *)"));
    assert.equal(out.permissions.defaultMode, "auto");
    assert.ok(out.permissions.additionalDirectories.includes("/opt/custom"));
    assert.ok(out.sandbox.network.allowedDomains.includes("internal.example"));
    assert.ok(out.autoMode.allow.includes("user rule"));
    assert.equal(out.autoMode.allow[0], "$defaults");
    assert.equal(out.language, "thai");
  } finally {
    t.cleanup();
  }
});

test("claude render is idempotent and stale managed entries are removed on policy change", () => {
  const t = makeTestEnv();
  try {
    const first = renderClaudeSettings(JSON.stringify(USER_SETTINGS), t.env, { mode: "apply", previousManaged: {} });
    const managed = { "claude.permissions.deny": ["Bash(old-managed *)"] };
    const withStale = JSON.parse(first.content) as { permissions: { deny: string[] } };
    withStale.permissions.deny.push("Bash(old-managed *)");
    const second = renderClaudeSettings(JSON.stringify(withStale), t.env, { mode: "apply", previousManaged: managed });
    assert.equal(second.content, first.content);
    const third = renderClaudeSettings(second.content, t.env, { mode: "apply", previousManaged: {} });
    assert.equal(third.content, second.content);
  } finally {
    t.cleanup();
  }
});

test("claude uninstall removes managed content and keeps user content", () => {
  const t = makeTestEnv();
  try {
    const applied = renderClaudeSettings(JSON.stringify(USER_SETTINGS), t.env, { mode: "apply", previousManaged: {} });
    const removed = renderClaudeSettings(applied.content, t.env, { mode: "remove", previousManaged: {} });
    const out = JSON.parse(removed.content) as typeof USER_SETTINGS & { language?: string };
    assert.ok(out.permissions.allow.includes("Bash(my-tool *)"));
    assert.ok(!out.permissions.deny.includes("Bash(git push * main)"));
    assert.ok(out.permissions.deny.includes("Bash(rm -rf /)"));
    assert.equal(out.language, undefined);
  } finally {
    t.cleanup();
  }
});

test("claude CLAUDE.md managed block is inserted once", () => {
  const t = makeTestEnv((home) => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# my rules\n\nkeep me\n");
  });
  try {
    const p1 = renderClaude(t.env, { mode: "apply", previousManaged: {} });
    const md1 = p1.changes.find((c) => c.path.endsWith("CLAUDE.md"))?.after ?? "";
    fs.writeFileSync(path.join(t.world.home, ".claude", "CLAUDE.md"), md1);
    const p2 = renderClaude(t.env, { mode: "apply", previousManaged: {} });
    const md2 = p2.changes.find((c) => c.path.endsWith("CLAUDE.md"));
    assert.equal(md2?.kind, "unchanged");
    assert.ok(md1.startsWith("# my rules"));
    assert.equal(md1.split("<!-- agents-adapter:start -->").length, 2);
    assert.ok(md1.includes("main, develop"));
  } finally {
    t.cleanup();
  }
});
