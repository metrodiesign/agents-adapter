import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ADAPTERS } from "../adapters/index.ts";
import type { DetectedCapabilities } from "../adapters/types.ts";
import type { Environment } from "../config/loader.ts";
import { nativeProdEnvGlobs } from "../core/paths.ts";
import { loadMatrix } from "../core/policy-loader.ts";
import { runParity } from "../parity/harness.ts";
import { detectCapabilities } from "./capabilities.ts";
import { driftReport } from "./drift.ts";

export type Level = "PASS" | "WARN" | "FAIL" | "UNSUPPORTED";

export interface Check {
  level: Level;
  name: string;
  detail: string;
}

const MIN = { claude: "2.1.0", codex: "0.100.0", pi: "0.80.0" };

function versionGte(v: string | null, min: string): boolean {
  if (!v) return false;
  const a = v.match(/\d+(\.\d+)+/)?.[0].split(".").map(Number) ?? [];
  const b = min.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) > b[i]) return true;
    if ((a[i] ?? 0) < b[i]) return false;
  }
  return true;
}

export async function runDoctor(env: Environment, opts: { parity?: boolean; detected?: DetectedCapabilities } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const d = opts.detected ?? detectCapabilities();
  const ver = (name: "claude" | "codex" | "pi", v: string | null): void => {
    if (v === null) checks.push({ level: "UNSUPPORTED", name: `${name} version`, detail: "CLI not found" });
    else checks.push({ level: versionGte(v, MIN[name]) ? "PASS" : "WARN", name: `${name} version`, detail: `${v} (min ${MIN[name]})` });
  };
  ver("claude", d.claudeVersion);
  ver("codex", d.codexVersion);
  ver("pi", d.piVersion);
  checks.push({ level: "PASS", name: "config file", detail: env.configPath.replace(env.home, "~") });
  checks.push({ level: d.python3 ? "PASS" : "FAIL", name: "python3 for Codex hooks", detail: d.python3 ? "available" : "missing" });
  // ใน Bash sandbox ของ Claude/Codex socket ของ docker และ ~/.config/gh ถูกปิด: probe ล้มเหลวไม่ได้แปลว่าเครื่องไม่มี
  const probeBlocked = (ok: boolean): boolean => !ok && d.agentSandbox !== null;
  checks.push({ level: d.docker ? "PASS" : probeBlocked(d.docker) ? "UNSUPPORTED" : "WARN", name: "Docker availability", detail: d.docker ? "available" : probeBlocked(d.docker) ? `cannot probe inside the ${d.agentSandbox} sandbox; run doctor from a terminal` : "not available (Pi isolated profile needs docker/gondolin/openshell)" });
  checks.push({ level: d.gondolin ? "PASS" : "UNSUPPORTED", name: "Gondolin", detail: d.gondolin ? "available" : "not installed" });
  checks.push({ level: d.openshell ? "PASS" : "UNSUPPORTED", name: "OpenShell", detail: d.openshell ? "available" : "not installed" });
  checks.push({ level: d.ghAuthenticated === null ? "UNSUPPORTED" : d.ghAuthenticated ? "PASS" : probeBlocked(false) ? "UNSUPPORTED" : "WARN", name: "GitHub auth status", detail: d.ghAuthenticated === null ? "gh not installed" : d.ghAuthenticated ? "authenticated (token never printed)" : probeBlocked(false) ? `cannot probe inside the ${d.agentSandbox} sandbox; run doctor from a terminal` : "not authenticated" });
  // GitHub ปฏิเสธ push ที่แตะ .github/workflows เมื่อ OAuth/classic token ไม่มี scope `workflow` (fine-grained PAT ต้องมี Workflows: write แต่ gh ไม่รายงาน scope ให้ตรวจ)
  for (const [name, scopes, fix] of [
    ["GitHub token workflow scope", d.ghTokenScopes, "gh auth refresh -h github.com -s workflow"],
    ["gh agent token workflow scope (codex)", d.ghAgentTokenScopes, "re-login with a token that has the scope: GH_CONFIG_DIR=~/.codex/gh gh auth logout -h github.com; then gh auth login --with-token --insecure-storage (gh auth refresh moves the token into the keyring)"],
  ] as const) {
    if (scopes === null || scopes === undefined) continue;
    const ok = scopes.includes("workflow");
    checks.push({ level: ok ? "PASS" : "WARN", name, detail: ok ? "workflow scope present" : `push touching .github/workflows is refused (\`refusing to allow an OAuth App ... without \`workflow\` scope\`); run: ${fix}` });
  }

  // Codex config conflicts
  const codexConfig = path.join(env.home, ".codex", "config.toml");
  if (fs.existsSync(codexConfig)) {
    try {
      const doc = parseToml(fs.readFileSync(codexConfig, "utf8")) as Record<string, unknown>;
      const danger = doc.sandbox_mode === "danger-full-access";
      const both = doc.sandbox_mode !== undefined && doc.default_permissions !== undefined;
      checks.push({ level: danger ? "FAIL" : "PASS", name: "danger-full-access", detail: danger ? "sandbox_mode = danger-full-access present" : "not enabled" });
      checks.push({ level: both ? "FAIL" : "PASS", name: "permission profile conflict", detail: both ? "sandbox_mode and default_permissions both set" : "no conflict" });
      const perms = (doc.permissions as Record<string, Record<string, unknown>> | undefined)?.[String(doc.default_permissions ?? "")];
      const fsTable = (perms?.filesystem ?? {}) as Record<string, unknown>;
      checks.push({ level: fsTable["/"] === "read" ? "FAIL" : "PASS", name: "filesystem root read", detail: fsTable["/"] === "read" ? '"/" = "read" exposes whole filesystem' : "root not readable" });
      // gh ต้องอ่าน ~/.config/gh ใน sandbox (deny entry ไม่ escalatable) จึงยอม read; write เท่านั้นที่เปิดช่องให้แก้ credential
      const ghWrite = fsTable["~/.config/gh"] === "write";
      checks.push({ level: ghWrite ? "FAIL" : "PASS", name: "credential exposure (gh config)", detail: ghWrite ? "~/.config/gh writable by shell" : "gh config read-only" });
      // agent token ของ gh สำหรับ Codex sandbox (keychain ใช้ไม่ได้ใน seatbelt): ตรวจแค่มีไฟล์และ mode ไม่พิมพ์เนื้อหา
      const ghDir = path.join(env.home, ".codex", "gh");
      const hosts = path.join(ghDir, "hosts.yml");
      const envSet = ((doc.shell_environment_policy as Record<string, unknown> | undefined)?.set ?? {}) as Record<string, unknown>;
      const envOk = envSet.GH_CONFIG_DIR === ghDir;
      // ~/.codex/gh เป็น credential path: Bash sandbox ของ Claude deny read ทั้ง dir (stat ก็ EPERM) ไม่ใช่ปัญหา config
      let hostsStat: fs.Stats | null | "blocked" = null;
      try {
        hostsStat = fs.statSync(hosts);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") hostsStat = null;
        else if ((code === "EPERM" || code === "EACCES") && d.agentSandbox !== null) hostsStat = "blocked";
        else throw err;
      }
      if (hostsStat === "blocked") checks.push({ level: "UNSUPPORTED", name: "gh agent token (codex)", detail: `cannot stat ~/.codex/gh inside the ${d.agentSandbox} sandbox (credential path); run doctor from a terminal` });
      else if (hostsStat === null) checks.push({ level: "WARN", name: "gh agent token (codex)", detail: "~/.codex/gh/hosts.yml missing: gh/git push fail in the Codex sandbox; see docs/codex-adapter.md GitHub setup" });
      else {
        const loose = (hostsStat.mode & 0o077) !== 0;
        checks.push({ level: loose ? "FAIL" : envOk ? "PASS" : "WARN", name: "gh agent token (codex)", detail: loose ? "~/.codex/gh/hosts.yml readable by group/other; chmod 600" : envOk ? "present, GH_CONFIG_DIR set (token never printed)" : "present but shell_environment_policy.set.GH_CONFIG_DIR not applied" });
      }
      // gh auth refresh (แม้ใส่ --insecure-storage) ย้าย token เข้า keyring: seatbelt อ่าน keychain ไม่ได้ -> gh ใน sandbox ตอบ HTTP 401
      if (d.ghAgentTokenKeyring === true) checks.push({ level: "FAIL", name: "gh agent token storage (codex)", detail: "~/.codex/gh token is in the keyring (gh auth status shows `(keyring)`): the Codex sandbox cannot read it (HTTP 401 Requires authentication); run: GH_CONFIG_DIR=~/.codex/gh gh auth logout -h github.com; then pbpaste | GH_CONFIG_DIR=~/.codex/gh gh auth login --with-token --insecure-storage" });
      else if (d.ghAgentTokenKeyring === false) checks.push({ level: "PASS", name: "gh agent token storage (codex)", detail: "plaintext hosts.yml (readable inside the seatbelt)" });
      const ws = (fsTable[":workspace_roots"] ?? {}) as Record<string, unknown>;
      // pattern เป็น root-level ตั้งแต่เลิกใช้ `**/` (seatbelt deny unlink ทั้ง workspace)
      const prodDenied = nativeProdEnvGlobs(env.ctx.prodEnvPatterns).every((p) => ws[p] === "deny");
      checks.push({ level: prodDenied ? "PASS" : "WARN", name: "production env exposure (codex)", detail: prodDenied ? "production env denied" : "production env not denied in workspace roots" });
      const hooksState = (doc.hooks as Record<string, unknown> | undefined)?.state as Record<string, unknown> | undefined;
      const hooksJson = path.join(env.home, ".codex", "hooks.json");
      const hasOurHooks = fs.existsSync(hooksJson) && fs.readFileSync(hooksJson, "utf8").includes("/hooks/agents-adapter/");
      checks.push({ level: hasOurHooks ? "PASS" : "WARN", name: "hook availability (codex)", detail: hasOurHooks ? "agents-adapter hooks registered" : "hooks not registered; run apply --target codex" });
      if (hasOurHooks) {
        const trusted = hooksState ? Object.keys(hooksState).some((k) => k.includes("hooks.json:pre_tool_use")) : false;
        checks.push({ level: trusted ? "PASS" : "WARN", name: "hook trust (codex)", detail: trusted ? "hooks.state has trusted hashes" : "open codex once to trust the new hooks" });
      }
    } catch (err) {
      checks.push({ level: "FAIL", name: "codex config parse", detail: err instanceof Error ? err.message : String(err) });
    }
  } else {
    checks.push({ level: "UNSUPPORTED", name: "codex config", detail: "~/.codex/config.toml not found" });
  }
  const req = path.join(env.home, ".codex", "requirements.toml");
  if (fs.existsSync(req)) {
    const r = parseToml(fs.readFileSync(req, "utf8")) as Record<string, Record<string, unknown>>;
    const closed = r.allowed_permission_profiles?.[":danger-full-access"] === false;
    checks.push({ level: closed ? "PASS" : "FAIL", name: "requirements danger-full-access", detail: closed ? '":danger-full-access" = false' : "danger-full-access not closed" });
  } else {
    checks.push({ level: "WARN", name: "requirements.toml", detail: "not found; run apply --target codex" });
  }

  // Claude
  const claudeSettings = path.join(env.home, ".claude", "settings.json");
  if (fs.existsSync(claudeSettings)) {
    try {
      const s = JSON.parse(fs.readFileSync(claudeSettings, "utf8")) as Record<string, unknown>;
      const perms = (s.permissions ?? {}) as Record<string, unknown>;
      const bypass = perms.defaultMode === "bypassPermissions" || perms.disableBypassPermissionsMode !== "disable";
      checks.push({ level: bypass ? "FAIL" : "PASS", name: "claude bypass mode", detail: bypass ? "bypass permissions not disabled" : "disableBypassPermissionsMode = disable" });
      const sandbox = (s.sandbox ?? {}) as Record<string, unknown>;
      checks.push({ level: sandbox.enabled === true ? "PASS" : "WARN", name: "claude sandbox", detail: sandbox.enabled === true ? "enabled" : "sandbox disabled" });
      const deny = (perms.deny ?? []) as string[];
      const credDeny = deny.some((x) => x.includes("Read(~/.ssh"));
      checks.push({ level: credDeny ? "PASS" : "WARN", name: "credential exposure (claude)", detail: credDeny ? "credential Read/Edit denied" : "credential deny rules missing" });
    } catch (err) {
      checks.push({ level: "FAIL", name: "claude settings parse", detail: err instanceof Error ? err.message : String(err) });
    }
  } else {
    checks.push({ level: "UNSUPPORTED", name: "claude settings", detail: "~/.claude/settings.json not found" });
  }

  // Pi
  const piExt = path.join(env.home, ".pi", "agent", "extensions", "policy-gate.ts");
  checks.push({ level: fs.existsSync(piExt) ? "PASS" : "WARN", name: "extension availability (pi)", detail: fs.existsSync(piExt) ? "policy-gate.ts installed" : "policy extension missing; run apply --target pi" });
  const mode = env.config.pi?.isolation_mode ?? "host-macos";
  const isolationOk = mode === "host-macos" ? true : mode === "docker" ? d.docker : mode === "gondolin" ? d.gondolin : d.openshell;
  checks.push({ level: isolationOk ? (mode === "host-macos" ? "WARN" : "PASS") : "FAIL", name: "OS isolation availability (pi)", detail: mode === "host-macos" ? "host-macos: credential rules are best-effort; docker fallback " + (d.docker ? "available" : "missing") : `${mode}: ${isolationOk ? "available" : "runtime not found"}` });

  // unsupported keys / schema compatibility
  const matrix = loadMatrix();
  for (const adapter of Object.values(ADAPTERS)) {
    const caps = adapter.capabilities(env, d);
    const unsupported = matrix.rules.filter((r) => caps[r.id]?.level === "unsupported").map((r) => r.id);
    checks.push({ level: unsupported.length === 0 ? "PASS" : "UNSUPPORTED", name: `${adapter.name} rule coverage`, detail: unsupported.length === 0 ? "all rules enforceable or have isolation fallback" : `unsupported without fallback: ${unsupported.join(", ")}` });
  }

  // drift
  for (const target of ["claude", "codex", "pi"] as const) {
    try {
      const drift = driftReport(env, target);
      if (drift.notInstalled) checks.push({ level: "WARN", name: `policy drift (${target})`, detail: "never applied" });
      else checks.push({ level: drift.policyDrift.length === 0 ? "PASS" : "WARN", name: `policy drift (${target})`, detail: drift.policyDrift.length === 0 ? "generated output matches installed files" : drift.policyDrift.join("; ") });
      if (drift.hashDrift.length > 0) checks.push({ level: "WARN", name: `generated hash drift (${target})`, detail: drift.hashDrift.join("; ") });
      if (drift.foreignEdit.length > 0) checks.push({ level: "PASS", name: `generated hash drift (${target})`, detail: "edited outside managed keys only: " + drift.foreignEdit.map((f) => f.replace("modified since apply: ", "")).join(", ") });
    } catch (err) {
      checks.push({ level: "FAIL", name: `policy drift (${target})`, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  if (opts.parity !== false) {
    const parity = await runParity(env);
    checks.push({ level: parity.failures.length === 0 ? "PASS" : "FAIL", name: "parity test result", detail: `${parity.total - parity.failures.length}/${parity.total} cases agree` + (parity.failures.length ? "; " + parity.failures.slice(0, 3).map((f) => f.name).join(", ") : "") });
  }
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${c.level.padEnd(11)} ${c.name.padEnd(width)}  ${c.detail}`).join("\n");
}

export function exitCodeFor(checks: Check[]): number {
  return checks.some((c) => c.level === "FAIL") ? 1 : 0;
}
