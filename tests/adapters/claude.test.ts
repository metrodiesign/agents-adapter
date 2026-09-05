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
    const pre = (out.hooks as { PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> }).PreToolUse;
    assert.ok(pre.some((g) => g.hooks.some((h) => h.command === "echo hi")), "user hook preserved");
    assert.ok(pre.some((g) => g.matcher === "^(Agent|Task)$" && g.hooks.some((h) => h.command.includes("/hooks/agents-adapter/provider_guard.py"))), "provider guard hook added");
    assert.deepEqual(out.unknownFutureKey, USER_SETTINGS.unknownFutureKey);
    assert.ok(out.permissions.allow.includes("Bash(my-tool *)"));
    assert.ok(out.permissions.deny.includes("Bash(rm -rf /)"));
    assert.ok(out.permissions.deny.includes("Bash(git push * main)"));
    assert.ok(out.permissions.ask.includes("Bash(git reset --hard *)"));
    assert.ok(out.permissions.ask.includes("Bash(gh pr merge *)"), "merge is ASK (user decision), not deny");
    assert.ok(!out.permissions.deny.includes("Bash(gh pr merge *)"));
    assert.ok(out.permissions.ask.includes("Bash(git tag v*)") && out.permissions.ask.includes("Bash(git push --tags*)"), "RELEASE_TAG ask rules");
    assert.ok(out.permissions.deny.includes("Edit(/etc/**)") && out.permissions.deny.includes("Edit(/System/**)"), "SYSTEM_PATH_WRITE deny rules");
    // rm -rf ใน Development Trust Zone เป็น ALLOW; นอก zone sandbox block แล้ว Claude ถามตอนขอ disable sandbox
    assert.ok(!out.permissions.ask.some((p: string) => p.startsWith("Bash(rm -")), "no rm -rf ask rule");
    assert.equal(out.permissions.defaultMode, "auto");
    assert.ok(out.permissions.additionalDirectories.includes("/opt/custom"));
    assert.ok(out.sandbox.network.allowedDomains.includes("internal.example"));
    assert.ok(out.autoMode.allow.includes("user rule"));
    assert.equal(out.autoMode.allow[0], "$defaults");
    assert.ok(out.autoMode.allow.some((s: string) => s.includes("Development Trust Zone")));
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

test("claude sandbox keeps only codex and the agents-adapter wrapper outside the sandbox; every removed entry has an in-sandbox replacement", () => {
  const t = makeTestEnv();
  try {
    const s = JSON.parse(renderClaudeSettings(null, t.env, { mode: "apply", previousManaged: {} }).content);
    const excluded = s.sandbox.excludedCommands as string[];
    const wrapper = path.join(t.env.home, ".claude", "hooks", "agents-adapter", "agents-free-port.sh");
    assert.deepEqual(excluded, ["codex *", `${wrapper} *`]);
    // gh *, rtk gh *, git push/fetch/pull/ls-remote/clone, rtk git fetch/pull, docker *, rtk docker *: ต้องไม่กลับมา
    for (const c of ["gh *", "rtk gh *", "git push *", "git fetch *", "git pull *", "git ls-remote *", "git clone *", "rtk git fetch *", "rtk git pull *", "docker *", "rtk docker *", "dotnet test *", "ps *", "kill *", "pgrep *"]) assert.ok(!excluded.includes(c), `${c} must stay inside the sandbox`);
    // replacement 1: gh + git credential helper อ่าน agent token จาก ~/.claude/gh ซึ่ง sandbox ต้องไม่บัง
    const ghDir = path.join(t.env.home, ".claude", "gh");
    assert.equal(s.env.GH_CONFIG_DIR, ghDir);
    assert.equal(s.env.GH_NO_UPDATE_NOTIFIER, "1");
    assert.ok(!s.sandbox.filesystem.denyRead.includes("~/.claude/gh"), "gh must read its own token dir inside the sandbox");
    assert.ok(!s.sandbox.credentials.files.some((f: { path: string }) => f.path === "~/.claude/gh"));
    assert.ok(s.sandbox.filesystem.denyWrite.includes("~/.claude/gh"), "agent token dir stays write-denied");
    assert.ok(s.sandbox.filesystem.denyRead.includes("~/.codex/gh"), "the other CLI's token dir stays read-denied");
    assert.ok(s.permissions.deny.includes("Read(~/.claude/gh/**)") && s.permissions.deny.includes("Edit(~/.claude/gh/**)"));
    assert.ok(s.permissions.deny.includes("Bash(*/.claude/gh*)") && s.permissions.deny.includes("Bash(*/.codex/gh*)"), "Bash pattern denies reading the token dir the sandbox no longer hides");
    assert.ok(s.permissions.deny.includes("Bash(*GH_CONFIG_DIR*)") && s.permissions.deny.includes("Bash(*gh/hosts.yml*)"), "indirections created by this change are denied deterministically");
    // system config ของทุก CLI (รวม hooks dir ของ Codex ที่เก็บ wrapper ซึ่ง Codex รัน escalated) ต้องเขียนจาก Claude sandbox ไม่ได้
    for (const p of ["~/.codex/hooks", "~/.codex/config.toml", "~/.codex/rules", "~/.claude/hooks", "~/.claude/settings.json", "~/.pi/agent/extensions", "~/.config/agents-adapter/config.yaml", "~/.zshrc"]) assert.ok(s.sandbox.filesystem.denyWrite.includes(p), `${p} write-denied`);
    // replacement 2: Go TLS (gh, docker buildx) และ pgrep ผ่าน mach lookup ที่ระบุชื่อ service ไม่ใช่ wildcard
    assert.deepEqual(s.sandbox.network.allowMachLookup, ["com.apple.trustd.agent", "com.apple.sysmond"]);
    assert.equal(s.sandbox.enableWeakerNetworkIsolation, undefined, "use the named service, not the blanket flag");
    // replacement 3: docker daemon ผ่าน socket (process ลูกด้วย)
    assert.ok(s.sandbox.network.allowUnixSockets.includes("/var/run/docker.sock"));
    // wrapper: allow pattern เดียวกับ excluded และไฟล์ถูก render ลง hooks dir ที่ sandbox เขียนไม่ได้
    assert.ok(s.permissions.allow.includes(`Bash(${wrapper} *)`));
    const plan = renderClaude(t.env, { mode: "apply", previousManaged: {} });
    const w = plan.changes.find((c) => c.path === wrapper);
    assert.ok(w && w.after?.startsWith("#!/usr/bin/env bash") && w.mode === 0o755);
    const probe = plan.changes.find((c) => c.path.endsWith("/.claude/hooks/agents-adapter/sandbox-probe.sh"));
    assert.ok(probe && probe.after?.includes("summary: FAIL="), "probe installed next to the wrapper (runs inside the sandbox)");
    assert.ok(!excluded.some((c) => c.includes("sandbox-probe.sh")), "probe must stay inside the sandbox");
    assert.ok(plan.unsupported.some((u) => u.includes("hosts.yml missing")), "plan warns when the agent token is not set up yet");
    // wrapper ที่เนื้อหาเท่าเดิมแต่ mode ถูกแก้เป็น 644 ต้องนับเป็น modify ไม่ใช่ unchanged
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, w!.after!, { mode: 0o644 });
    const again = renderClaude(t.env, { mode: "apply", previousManaged: {} }).changes.find((c) => c.path === wrapper);
    assert.equal(again?.kind, "modify", "mode drift is a change");
    fs.chmodSync(wrapper, 0o755);
    assert.equal(renderClaude(t.env, { mode: "apply", previousManaged: {} }).changes.find((c) => c.path === wrapper)?.kind, "unchanged");
  } finally {
    t.cleanup();
  }
});

test("claude allowMachLookup merge keeps user services and drops stale managed ones", () => {
  const t = makeTestEnv();
  try {
    const user = JSON.stringify({ sandbox: { network: { allowMachLookup: ["com.apple.coresimulator.*", "com.apple.old"] } } });
    const first = JSON.parse(renderClaudeSettings(user, t.env, { mode: "apply", previousManaged: { "claude.sandbox.network.allowMachLookup": ["com.apple.old"] } }).content);
    assert.deepEqual(first.sandbox.network.allowMachLookup, ["com.apple.coresimulator.*", "com.apple.trustd.agent", "com.apple.sysmond"]);
    const removed = JSON.parse(renderClaudeSettings(JSON.stringify(first), t.env, { mode: "remove", previousManaged: {} }).content);
    assert.deepEqual(removed.sandbox.network.allowMachLookup, ["com.apple.coresimulator.*"]);
  } finally {
    t.cleanup();
  }
});

test("claude sandbox keeps toolchains working inside the sandbox: docker socket, dotnet IPv4, cache dirs", () => {
  const t = makeTestEnv();
  try {
    const s = JSON.parse(renderClaudeSettings(null, t.env, { mode: "apply", previousManaged: {} }).content);
    // docker ที่ถูกเรียกจาก script เป็น process ลูก ไม่ได้รับการยกเว้นจาก excludedCommands
    assert.ok(s.sandbox.network.allowUnixSockets.includes("/var/run/docker.sock"), "docker.sock allowed");
    assert.ok(s.sandbox.network.allowUnixSockets.some((p: string) => p.endsWith("/.docker/run/docker.sock")), "docker.sock symlink target allowed");
    // MSBuild worker node ใช้ NamedPipeServerStream = AF_UNIX socket ใน temp dir
    for (const p of ["/tmp", "/private/tmp"]) assert.ok(s.sandbox.network.allowUnixSockets.includes(p), p);
    // VSTest testhost ใช้ v4-mapped IPv6 loopback ที่ seatbelt ปฏิเสธ
    assert.equal(s.env.DOTNET_SYSTEM_NET_DISABLEIPV6, "1");
    assert.ok(!s.sandbox.excludedCommands.includes("dotnet test *"), "dotnet test no longer needs to leave the sandbox");
    assert.ok((s.sandbox.filesystem.allowWrite as string[]).includes(path.join(t.env.home, ".claude")), "hooks dir parent writable for apply; Claude itself protects ~/.claude/hooks");
    // ถ้า allowUnsandboxedCommands หาย excludedCommands ทั้งชุดไร้ผลโดยเงียบ
    assert.equal(s.sandbox.allowUnsandboxedCommands, true);
    assert.equal(s.sandbox.failIfUnavailable, true);
    assert.equal(s.sandbox.network.allowLocalBinding, true);
    // always_writable (temp + cache ของ toolchain) ต้องไหลเข้า allowWrite; test env ตั้ง alwaysWritable = [tmpdir]
    assert.ok((s.sandbox.filesystem.allowWrite as string[]).includes(t.env.ctx.tmpdir), "always_writable flows into allowWrite");
  } finally {
    t.cleanup();
  }
});

test("claude provider guard hook is added once, removed on uninstall, and the runtime file is rendered", () => {
  const t = makeTestEnv();
  try {
    const first = renderClaudeSettings(JSON.stringify(USER_SETTINGS), t.env, { mode: "apply", previousManaged: {} });
    const second = renderClaudeSettings(first.content, t.env, { mode: "apply", previousManaged: {} });
    const pre = (JSON.parse(second.content).hooks as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse;
    assert.equal(pre.filter((g) => g.hooks.some((h) => h.command.includes("provider_guard.py"))).length, 1, "idempotent");
    const removed = JSON.parse(renderClaudeSettings(second.content, t.env, { mode: "remove", previousManaged: {} }).content) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    assert.ok(!removed.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command.includes("provider_guard.py"))), "removed on uninstall");
    assert.ok(removed.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command === "echo hi")), "user hook survives uninstall");
    const plan = renderClaude(t.env, { mode: "apply", previousManaged: {} });
    assert.ok(plan.changes.some((c) => c.path.endsWith("/hooks/agents-adapter/provider_guard.py") && c.after !== null));
    const cfg = plan.changes.find((c) => c.path.endsWith("/hooks/agents-adapter/agents-adapter.config.json"));
    assert.ok(cfg && cfg.after && JSON.parse(cfg.after).securityAgentTypes.includes("auditor"));
  } finally {
    t.cleanup();
  }
});
