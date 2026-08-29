import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { apply, atomicWrite, plan } from "../../src/install/apply.ts";
import { listBackups } from "../../src/install/backup.ts";
import { rollback } from "../../src/install/rollback.ts";
import { loadState } from "../../src/install/state.ts";
import { driftReport } from "../../src/doctor/drift.ts";
import { runDoctor } from "../../src/doctor/report.ts";
import { makeTestEnv } from "../helpers.ts";

const LEGACY_CODEX = 'model = "m"\ndefault_permissions = "Auto mode"\nsandbox_mode = "danger-full-access"\n\n[permissions."Auto mode".filesystem]\n"/" = "read"\n';

function seed(home: string): void {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "keep", permissions: { allow: ["Bash(user *)"] } }, null, 2));
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# mine\n");
  fs.mkdirSync(path.join(home, ".codex", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), LEGACY_CODEX);
  fs.writeFileSync(path.join(home, ".codex", "AGENTS.md"), "# codex mine\n");
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), "{\n  \"theme\": \"dark\"\n}\n");
}

test("plan does not touch files; apply backs up, writes atomically and is idempotent; rollback restores everything", () => {
  const t = makeTestEnv(seed);
  try {
    const before = fs.readFileSync(path.join(t.world.home, ".codex", "config.toml"), "utf8");
    const p = plan(t.env, "all");
    assert.ok(p.changed.length > 5);
    assert.equal(fs.readFileSync(path.join(t.world.home, ".codex", "config.toml"), "utf8"), before, "plan must not modify files");

    const first = apply(t.env, "all");
    assert.ok(first.applied > 5);
    assert.ok(first.backupId);
    const codex = parseToml(fs.readFileSync(path.join(t.world.home, ".codex", "config.toml"), "utf8")) as Record<string, any>;
    assert.equal(codex.sandbox_mode, undefined);
    assert.equal(codex.model, "m");
    assert.ok(fs.existsSync(path.join(t.world.home, ".codex", "hooks", "agents-adapter", "policy_gate.py")));
    assert.ok(fs.existsSync(path.join(t.world.home, ".pi", "agent", "extensions", "policy-gate.ts")));
    const claude = JSON.parse(fs.readFileSync(path.join(t.world.home, ".claude", "settings.json"), "utf8")) as { model: string; permissions: { allow: string[] } };
    assert.equal(claude.model, "keep");
    assert.ok(claude.permissions.allow.includes("Bash(user *)"));
    assert.ok(!fs.readdirSync(path.join(t.world.home, ".claude")).some((f) => f.includes("agents-adapter-tmp")), "no temp files left behind");

    const second = apply(t.env, "all");
    assert.equal(second.applied, 0, "second apply must be no changes");
    assert.equal(driftReport(t.env, "all").policyDrift.length, 0);
    const md = fs.readFileSync(path.join(t.world.home, ".claude", "CLAUDE.md"), "utf8");
    assert.equal(md.split("<!-- agents-adapter:start -->").length, 2);

    const backups = listBackups(t.env);
    assert.equal(backups.length, 1);
    const r = rollback(t.env, backups[0]);
    assert.equal(r.failed.length, 0);
    assert.equal(fs.readFileSync(path.join(t.world.home, ".codex", "config.toml"), "utf8"), before);
    assert.equal(fs.readFileSync(path.join(t.world.home, ".claude", "CLAUDE.md"), "utf8"), "# mine\n");
    assert.ok(!fs.existsSync(path.join(t.world.home, ".codex", "hooks", "agents-adapter", "policy_gate.py")), "created files removed on rollback");
    assert.ok(fs.existsSync(path.join(t.env.stateDir, "backups", backups[0], "manifest.json")), "backup kept after rollback");
    assert.equal(loadState(t.env).lastApply, null);
  } finally {
    t.cleanup();
  }
});

test("apply refuses to replace a file when validation fails and leaves the original intact", () => {
  const t = makeTestEnv(seed);
  try {
    const file = path.join(t.world.home, ".claude", "settings.json");
    const original = fs.readFileSync(file, "utf8");
    assert.throws(() => atomicWrite(file, "{not json", (c) => JSON.parse(c)));
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.ok(!fs.existsSync(file + ".agents-adapter-tmp"));
  } finally {
    t.cleanup();
  }
});

test("uninstall removes managed content and keeps user content", () => {
  const t = makeTestEnv(seed);
  try {
    apply(t.env, "all");
    const r = apply(t.env, "all", "remove");
    assert.ok(r.applied > 0);
    assert.ok(!fs.existsSync(path.join(t.world.home, ".pi", "agent", "extensions", "policy-gate.ts")));
    assert.equal(fs.readFileSync(path.join(t.world.home, ".codex", "AGENTS.md"), "utf8").trim(), "# codex mine");
    const claude = JSON.parse(fs.readFileSync(path.join(t.world.home, ".claude", "settings.json"), "utf8")) as { model: string; permissions: { deny?: string[] } };
    assert.equal(claude.model, "keep");
    assert.ok(!(claude.permissions.deny ?? []).includes("Bash(git push * main)"));
  } finally {
    t.cleanup();
  }
});

test("doctor reports FAIL on legacy codex config and PASS after apply; never prints secrets", async () => {
  const t = makeTestEnv((home) => {
    seed(home);
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"SECRET-VALUE-XYZ"}');
  });
  try {
    const detected = { claudeVersion: "2.1.250", codexVersion: "0.150.1", piVersion: "0.84.3", docker: true, gondolin: false, openshell: false, python3: true, ghAuthenticated: true, agentSandbox: null };
    const before = await runDoctor(t.env, { parity: false, detected });
    assert.ok(before.some((c) => c.name === "danger-full-access" && c.level === "FAIL"));
    assert.ok(before.some((c) => c.name === "filesystem root read" && c.level === "FAIL"));
    apply(t.env, "all");
    const after = await runDoctor(t.env, { parity: false, detected });
    assert.ok(after.every((c) => c.level !== "FAIL"), JSON.stringify(after.filter((c) => c.level === "FAIL")));
    assert.ok(!JSON.stringify(after).includes("SECRET-VALUE-XYZ"));
  } finally {
    t.cleanup();
  }
});

test("hash drift is reported only under the target that owns the file", () => {
  const t = makeTestEnv(seed);
  try {
    apply(t.env, "all");
    const claudeSettings = path.join(t.world.home, ".claude", "settings.json");
    fs.appendFileSync(claudeSettings, "\n");
    assert.ok(driftReport(t.env, "claude").hashDrift.some((d) => d.includes("settings.json")));
    assert.equal(driftReport(t.env, "codex").hashDrift.length, 0);
    assert.equal(driftReport(t.env, "pi").hashDrift.length, 0);
  } finally {
    t.cleanup();
  }
});
