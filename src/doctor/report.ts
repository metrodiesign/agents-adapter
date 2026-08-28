import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ADAPTERS } from "../adapters/index.ts";
import type { DetectedCapabilities } from "../adapters/types.ts";
import type { Environment } from "../config/loader.ts";
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
  checks.push({ level: d.docker ? "PASS" : "WARN", name: "Docker availability", detail: d.docker ? "available" : "not available (Pi isolated profile needs docker/gondolin/openshell)" });
  checks.push({ level: d.gondolin ? "PASS" : "UNSUPPORTED", name: "Gondolin", detail: d.gondolin ? "available" : "not installed" });
  checks.push({ level: d.openshell ? "PASS" : "UNSUPPORTED", name: "OpenShell", detail: d.openshell ? "available" : "not installed" });
  checks.push({ level: d.ghAuthenticated === null ? "UNSUPPORTED" : d.ghAuthenticated ? "PASS" : "WARN", name: "GitHub auth status", detail: d.ghAuthenticated === null ? "gh not installed" : d.ghAuthenticated ? "authenticated (token never printed)" : "not authenticated" });

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
      const ghRead = fsTable["~/.config/gh"] === "read";
      checks.push({ level: ghRead ? "FAIL" : "PASS", name: "credential exposure (gh config)", detail: ghRead ? "~/.config/gh readable by shell" : "gh config not readable" });
      const ws = (fsTable[":workspace_roots"] ?? {}) as Record<string, unknown>;
      const prodDenied = env.ctx.prodEnvPatterns.every((p) => ws[`**/${p}`] === "deny");
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
