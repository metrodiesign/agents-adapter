import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { renderPi, rewriteSharedImports } from "../../src/adapters/pi/generate.ts";
import { _resetApprovalsForTests, _setContextForTests, resolveAsk } from "../../runtime/pi/extensions/agents-adapter-lib/shared.ts";
import { gateToolCall } from "../../runtime/pi/extensions/policy-gate.ts";
import { gateUserBash } from "../../runtime/pi/extensions/user-bash-gate.ts";
import { makeTestEnv } from "../helpers.ts";

test("pi plan installs extensions, lib with rewritten imports, config and isolation profile", () => {
  const t = makeTestEnv((home) => {
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ theme: "dark", lastChangelogVersion: "0.84.3" }));
  });
  try {
    const p = renderPi(t.env, { mode: "apply", previousManaged: {} });
    const byPath = Object.fromEntries(p.changes.map((c) => [c.path.replace(t.world.home, "~"), c]));
    assert.equal(byPath["~/.pi/agent/settings.json"].kind, "unchanged");
    const shared = byPath["~/.pi/agent/extensions/agents-adapter-lib/shared.ts"].after ?? "";
    assert.ok(shared.includes('from "./core/classifier.ts"'));
    assert.ok(!shared.split("\n").some((l) => l.startsWith("import") && l.includes("src/core")));
    assert.ok(byPath["~/.pi/agent/extensions/agents-adapter-lib/core/classifier.ts"]);
    assert.ok(byPath["~/.pi/agent/extensions/policy-gate.ts"]);
    assert.ok(byPath["~/.pi/agent/extensions/user-bash-gate.ts"]);
    assert.ok(byPath["~/.pi/agent/agents-adapter-isolation.yaml"].after?.includes("host-macos"));
    assert.ok(p.notes.some((n) => n.includes("best-effort")));
  } finally {
    t.cleanup();
  }
});

test("rewriteSharedImports only touches the src/core prefix", () => {
  assert.equal(rewriteSharedImports('import x from "../../../../src/core/x.ts"; import y from "node:fs";'), 'import x from "./core/x.ts"; import y from "node:fs";');
});

test("pi ASK uses ctx.ui.confirm and caches approval per rule+target only", async () => {
  const t = makeTestEnv();
  try {
    _setContextForTests(t.env.ctx);
    _resetApprovalsForTests();
    const asked: string[] = [];
    const ctx = { cwd: t.world.cwd, hasUI: true, ui: { confirm: async (title: string) => { asked.push(title); return true; }, notify: () => undefined } };
    // rm -rf ใน workspace เป็น ALLOW แล้ว; ใช้ target ที่ยัง ASK (cwd และ .git)
    const r1 = await gateToolCall({ toolName: "bash", input: { command: "rm -rf ." } }, ctx);
    const r2 = await gateToolCall({ toolName: "bash", input: { command: "rm -rf ." } }, ctx);
    const r3 = await gateToolCall({ toolName: "bash", input: { command: "rm -rf .git" } }, ctx);
    assert.equal(r1, undefined);
    assert.equal(r2, undefined);
    assert.equal(r3, undefined);
    assert.equal(asked.length, 2, "same target asked once, different target asked again");
    const noUi = { ...ctx, hasUI: false };
    _resetApprovalsForTests();
    const r4 = await gateToolCall({ toolName: "bash", input: { command: "rm -rf ." } }, noUi);
    assert.equal(r4?.block, true);
    assert.ok(r4?.reason?.includes("ASK [DESTRUCTIVE_DELETE]"));
  } finally {
    t.cleanup();
  }
});

test("pi ASK is auto-reviewed by the session model like Claude Auto mode; ask rules stay a dialog", async () => {
  const t = makeTestEnv();
  try {
    const sets = { allow: ["routine dev work"], soft_deny: ["needs intent"], hard_deny: ["never merge"], environment: ["trust zone"] };
    _setContextForTests(t.env.ctx, sets);
    const asked: string[] = [];
    const reviewed: string[] = [];
    let answer = "allow";
    const ctx = {
      cwd: t.world.cwd,
      hasUI: true,
      ui: { confirm: async (title: string) => { asked.push(title); return true; }, notify: () => undefined },
      model: { id: "test-model" },
      modelRegistry: {
        complete: async (_m: unknown, c: { systemPrompt?: string; messages: unknown[] }) => {
          reviewed.push(JSON.stringify(c));
          return { content: [{ type: "text", text: answer }] };
        },
      },
      sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: "list files with ls $(date)" }] } }] },
    };
    // classifier says allow -> no dialog, cached per rule+target
    assert.equal(await gateToolCall({ toolName: "bash", input: { command: "ls $(date)" } }, ctx), undefined);
    assert.equal(await gateToolCall({ toolName: "bash", input: { command: "ls $(date)" } }, ctx), undefined);
    assert.equal(reviewed.length, 1, "second call served from approval cache");
    assert.equal(asked.length, 0);
    assert.ok(reviewed[0].includes("## hard_deny") && reviewed[0].includes("never merge"), "system prompt carries the autoMode sets");
    assert.ok(reviewed[0].includes("list files with ls $(date)"), "reviewer sees the current user request");
    assert.ok(reviewed[0].includes("SHELL_SUBSTITUTION"));
    // classifier says ask -> fall back to the dialog
    answer = "ask";
    assert.equal(await gateToolCall({ toolName: "bash", input: { command: "ls $(whoami)" } }, ctx), undefined);
    assert.equal(asked.length, 1);
    // user-decision rule never reaches the reviewer
    const before = reviewed.length;
    await gateToolCall({ toolName: "bash", input: { command: "gh pr merge 1" } }, ctx);
    assert.equal(reviewed.length, before);
    assert.equal(asked.length, 2);
    // reviewer failure -> dialog, never allow
    answer = "allow";
    ctx.modelRegistry.complete = async () => { throw new Error("no api key"); };
    await gateToolCall({ toolName: "bash", input: { command: "ls $(id)" } }, ctx);
    assert.equal(asked.length, 3);
    // no UI + no model = fail closed (unchanged)
    _resetApprovalsForTests();
    const r = await gateToolCall({ toolName: "bash", input: { command: "ls $(date)" } }, { cwd: t.world.cwd, hasUI: false, ui: ctx.ui });
    assert.equal(r?.block, true);
  } finally {
    t.cleanup();
  }
});

test("pi config.json carries the Claude autoMode sets", () => {
  const t = makeTestEnv();
  try {
    const p = renderPi(t.env, { mode: "apply", previousManaged: {} });
    const cfg = p.changes.find((c) => c.path.endsWith("agents-adapter-lib/config.json"));
    const doc = JSON.parse(cfg?.after ?? "{}") as { autoMode?: { allow: string[]; hard_deny: string[]; environment: string[] } };
    assert.ok(doc.autoMode && doc.autoMode.allow.length > 0 && doc.autoMode.hard_deny.length > 0);
    assert.ok(!doc.autoMode.allow.includes("$defaults"));
    assert.ok(doc.autoMode.environment.some((e) => e.includes("example-owner")));
  } finally {
    t.cleanup();
  }
});

test("pi user_bash gate blocks with a bash result instead of executing", async () => {
  const t = makeTestEnv();
  try {
    _setContextForTests(t.env.ctx);
    const ctx = { cwd: t.world.cwd, hasUI: false, ui: { confirm: async () => false, notify: () => undefined } };
    const r = await gateUserBash({ command: "git push origin main", excludeFromContext: true, cwd: t.world.cwd }, ctx);
    assert.equal(r?.result?.exitCode, 1);
    assert.ok(r?.result?.output.includes("DENY [GIT_PUSH_PROTECTED]"));
    const ok = await gateUserBash({ command: "ls", excludeFromContext: false, cwd: t.world.cwd }, ctx);
    assert.equal(ok, undefined);
    const declined = await resolveAsk({ decision: "ASK", ruleId: "GIT_CLEAN", reason: "x", target: "-fd" }, ctx, "git clean");
    assert.equal(declined, false);
  } finally {
    t.cleanup();
  }
});
