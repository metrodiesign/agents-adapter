import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { loadProtectedPaths, loadTrustedDefaults, REPO_ROOT, agentGhConfigDir, wrapperPaths } from "../../src/core/policy-loader.ts";

/**
 * key ใน trusted-defaults / protected-paths ที่ Claude และ Codex sandbox พึ่งเพื่อให้ toolchain ทำงานโดยไม่ต้องออกนอก sandbox
 * ถ้า key ใดหาย test นี้ต้องล้มก่อนที่ generated config จะพังเงียบ ๆ (อาการปลายทาง: TLS -26276, Cannot get process list, EPERM ที่ buildx)
 */
test("trusted-defaults keeps every sandbox capability key the adapters depend on", () => {
  const d = loadTrustedDefaults();
  // socket: docker daemon (ทั้ง symlink และ target) + AF_UNIX ใน temp dir สำหรับ MSBuild worker node
  for (const s of ["/var/run/docker.sock", "${HOME}/.docker/run/docker.sock", "/tmp", "/private/tmp"]) assert.ok(d.allowed_unix_sockets.includes(s), `allowed_unix_sockets missing ${s}`);
  // env: VSTest testhost loopback + gh state file
  assert.equal(d.sandbox_shell_env.DOTNET_SYSTEM_NET_DISABLEIPV6, "1");
  assert.equal(d.sandbox_shell_env.GH_NO_UPDATE_NOTIFIER, "1");
  // mach services: Go TLS + pgrep; ห้ามใช้ wildcard
  assert.deepEqual(d.sandbox_mach_services, ["com.apple.trustd.agent", "com.apple.sysmond"]);
  assert.equal(d.sandbox_git_config_writable, true, "git push -u / branch -d need .git/config writable");
  for (const m of d.sandbox_mach_services) assert.ok(!m.includes("*"), `${m}: mach service must be named, not a wildcard`);
  // allowWrite: temp + cache ของแต่ละ toolchain + buildx state
  for (const w of ["/tmp", "/private/tmp", "${TMPDIR}", "${HOME}/.npm", "${HOME}/.nuget/packages", "${HOME}/.composer/cache", "${HOME}/.m2", "${HOME}/.cargo", "${HOME}/go/pkg", "${HOME}/.cache", "${HOME}/.docker/buildx"]) assert.ok(d.always_writable.includes(w), `always_writable missing ${w}`);
  // gh agent token dir ต่อ CLI
  assert.equal(d.gh_agent_config_subdir, "gh");
  assert.equal(agentGhConfigDir("/h", "claude"), "/h/.claude/gh");
  assert.equal(agentGhConfigDir("/h", "codex"), "/h/.codex/gh");
  // wrapper ที่รันนอก sandbox ต้องมี source ใน runtime/shared และ executable
  assert.deepEqual(d.unsandboxed_wrappers, ["agents-free-port.sh"]);
  for (const f of d.unsandboxed_wrappers) {
    const src = path.join(REPO_ROOT, "runtime", "shared", f);
    assert.ok(fs.existsSync(src), `runtime/shared/${f} missing`);
    assert.ok((fs.statSync(src).mode & 0o111) !== 0, `${f} must be executable`);
  }
  assert.deepEqual(wrapperPaths("/h", "claude"), ["/h/.claude/hooks/agents-adapter/agents-free-port.sh"]);
  assert.deepEqual(d.shared_scripts, ["sandbox-probe.sh"]);
  for (const f of d.shared_scripts) assert.ok(fs.existsSync(path.join(REPO_ROOT, "runtime", "shared", f)), `runtime/shared/${f} missing`);
  assert.ok(!d.unsandboxed_wrappers.includes("sandbox-probe.sh"), "the probe must run inside the sandbox");
});

test("excluded_commands shrinks to codex only and never re-adds process tools", () => {
  const d = loadTrustedDefaults();
  assert.deepEqual(d.excluded_commands, ["codex *"]);
  for (const c of d.excluded_commands) assert.ok(!/^(rtk )?(ps|kill|pgrep|pkill|gh|docker|git) /.test(c), `${c} has an in-sandbox replacement`);
});

test("protected-paths lists both gh agent token dirs and the docker credential file", () => {
  const p = loadProtectedPaths();
  for (const c of ["${HOME}/.claude/gh", "${HOME}/.codex/gh", "${HOME}/.config/gh", "${HOME}/.docker/config.json"]) assert.ok(p.credential_paths.includes(c), `credential_paths missing ${c}`);
});
