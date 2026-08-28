import * as fs from "node:fs";
import * as path from "node:path";
import type { Environment } from "../../config/loader.ts";
import { trustedDomains } from "../../config/loader.ts";
import { getPath, isObject, mergeManagedList, renderTemplate, setPath, stableJson, stripManagedList, upsertBlock, removeBlock, type Json } from "../../config/merger.ts";
import { loadProtectedPaths, loadTrustedDefaults } from "../../core/policy-loader.ts";
import { change, readIfExists, validateJson } from "../fs-helpers.ts";
import type { AdapterPlan, RenderMode } from "../types.ts";
import { autoModeEntries, claudePatterns } from "./rules.ts";
import { VERSION } from "../../version.ts";

export interface ClaudeManaged {
  deny: string[];
  ask: string[];
  allow: string[];
  denyRead: string[];
  denyWrite: string[];
  credentialFiles: string[];
  credentialEnvVars: string[];
  excludedCommands: string[];
  allowedDomains: string[];
  additionalDirectories: string[];
  allowWrite: string[];
}

export function claudeManaged(env: Environment): ClaudeManaged {
  const { config, ctx } = env;
  const pats = claudePatterns(config, ctx);
  const protectedPaths = loadProtectedPaths();
  const defaults = loadTrustedDefaults();
  const tilde = (p: string): string => p.replace(ctx.home, "~");
  return {
    deny: pats.deny,
    ask: pats.ask,
    allow: pats.allow,
    denyRead: ctx.credentialPaths.map(tilde),
    denyWrite: [...ctx.credentialPaths.map(tilde), ...ctx.systemConfigPaths.filter((p) => p.startsWith(ctx.home) && /\/\.(zshrc|zprofile|bashrc|bash_profile)$/.test(p)).map(tilde)],
    credentialFiles: ctx.credentialPaths.map(tilde),
    credentialEnvVars: protectedPaths.credential_env_vars,
    excludedCommands: defaults.excluded_commands,
    allowedDomains: trustedDomains(config),
    additionalDirectories: ctx.developmentRoots,
    allowWrite: [...ctx.developmentRoots, ...ctx.agentConfigDirs],
  };
}

function prev<T>(mode: RenderMode, key: string): T[] {
  const v = (mode.previousManaged as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

export function renderClaudeSettings(existing: string | null, env: Environment, mode: RenderMode): { content: string; managedKeys: string[]; preserved: string[]; conflicts: string[] } {
  const settings: Record<string, Json> = existing ? (JSON.parse(existing) as Record<string, Json>) : {};
  const m = claudeManaged(env);
  const remove = mode.mode === "remove";
  const managedKeys: string[] = [];
  const conflicts: string[] = [];
  const preservedTop = Object.keys(settings).filter((k) => !["permissions", "sandbox", "autoMode", "language"].includes(k));

  const lists: Array<[string[], keyof ClaudeManaged, string]> = [
    [["permissions", "deny"], "deny", "claude.permissions.deny"],
    [["permissions", "ask"], "ask", "claude.permissions.ask"],
    [["permissions", "allow"], "allow", "claude.permissions.allow"],
    [["permissions", "additionalDirectories"], "additionalDirectories", "claude.permissions.additionalDirectories"],
    [["sandbox", "filesystem", "denyRead"], "denyRead", "claude.sandbox.filesystem.denyRead"],
    [["sandbox", "filesystem", "denyWrite"], "denyWrite", "claude.sandbox.filesystem.denyWrite"],
    [["sandbox", "filesystem", "allowWrite"], "allowWrite", "claude.sandbox.filesystem.allowWrite"],
    [["sandbox", "excludedCommands"], "excludedCommands", "claude.sandbox.excludedCommands"],
    [["sandbox", "network", "allowedDomains"], "allowedDomains", "claude.sandbox.network.allowedDomains"],
  ];
  for (const [p, key, stateKey] of lists) {
    const current = getPath(settings, p);
    const cur = Array.isArray(current) ? (current as string[]) : [];
    const next = remove ? stripManagedList(cur, prev<string>(mode, stateKey).concat(m[key] as string[])) : mergeManagedList(cur, prev<string>(mode, stateKey), m[key] as string[]);
    setPath(settings, p, next);
    managedKeys.push(p.join("."));
  }

  // credentials.files / envVars: object entries keyed by path/name
  const credFilesPath = ["sandbox", "credentials", "files"];
  const curFiles = getPath(settings, credFilesPath);
  const files = Array.isArray(curFiles) ? (curFiles as Array<Record<string, Json>>) : [];
  const nextFiles = m.credentialFiles.map((p) => ({ path: p, mode: "deny" }) as Record<string, Json>);
  const fileKey = (f: Record<string, Json>): string => String(f.path);
  setPath(settings, credFilesPath, remove ? stripManagedList(files, nextFiles, fileKey) : mergeManagedList(files, prev<Record<string, Json>>(mode, "claude.sandbox.credentials.files"), nextFiles, fileKey));
  const envPath = ["sandbox", "credentials", "envVars"];
  const curEnv = getPath(settings, envPath);
  const envs = Array.isArray(curEnv) ? (curEnv as Array<Record<string, Json>>) : [];
  const nextEnv = m.credentialEnvVars.map((n) => ({ name: n, mode: "deny" }) as Record<string, Json>);
  const envKey = (f: Record<string, Json>): string => String(f.name);
  setPath(settings, envPath, remove ? stripManagedList(envs, nextEnv, envKey) : mergeManagedList(envs, prev<Record<string, Json>>(mode, "claude.sandbox.credentials.envVars"), nextEnv, envKey));
  managedKeys.push("sandbox.credentials.files", "sandbox.credentials.envVars");

  // autoMode text entries (จาก Claude reference; managed ผ่าน state ไม่ใช่ prefix)
  const am = autoModeEntries(env.config, env.ctx);
  for (const key of ["allow", "soft_deny", "hard_deny", "environment"] as const) {
    const p = ["autoMode", key];
    const cur = getPath(settings, p);
    const list = Array.isArray(cur) ? (cur as string[]) : ["$defaults"];
    const stateKey = `claude.autoMode.${key}`;
    const next = remove ? stripManagedList(list, prev<string>(mode, stateKey).concat(am[key])) : mergeManagedList(list, prev<string>(mode, stateKey), am[key]);
    setPath(settings, p, next.includes("$defaults") ? next : ["$defaults", ...next]);
    managedKeys.push(p.join("."));
  }

  // scalar managed keys
  const scalars: Array<[string[], Json]> = [
    [["permissions", "disableBypassPermissionsMode"], "disable"],
    [["sandbox", "enabled"], true],
    [["sandbox", "autoAllowBashIfSandboxed"], true],
    [["autoMode", "classifyAllShell"], true],
    [["language"], "thai"],
  ];
  for (const [p, value] of scalars) {
    const cur = getPath(settings, p);
    if (remove) {
      if (cur === value) {
        const parent = getPath(settings, p.slice(0, -1));
        if (isObject(parent)) delete parent[p[p.length - 1]];
      }
      continue;
    }
    if (cur !== undefined && cur !== value) conflicts.push(`${p.join(".")}: user value ${JSON.stringify(cur)} replaced by ${JSON.stringify(value)}`);
    setPath(settings, p, value);
    managedKeys.push(p.join("."));
  }
  if (!remove && getPath(settings, ["permissions", "defaultMode"]) === "bypassPermissions") {
    conflicts.push("permissions.defaultMode was bypassPermissions; reset to default");
    setPath(settings, ["permissions", "defaultMode"], "default");
  }
  return { content: stableJson(settings), managedKeys, preserved: preservedTop, conflicts };
}

export function claudeBlockVars(env: Environment): Record<string, string> {
  return {
    version: VERSION,
    development_roots: env.ctx.developmentRoots.map((r) => r.replace(env.home, "${HOME}")).join("\n"),
    protected_branches: env.config.protected_branches.join(", "),
    development_env_patterns: env.ctx.devEnvPatterns.join(", "),
    production_env_patterns: env.ctx.prodEnvPatterns.join(", "),
    pi_isolation_mode: env.config.pi?.isolation_mode ?? "host-macos",
  };
}

export function renderClaude(env: Environment, mode: RenderMode): AdapterPlan {
  const dir = path.join(env.home, ".claude");
  const settingsPath = path.join(dir, "settings.json");
  const mdPath = path.join(dir, "CLAUDE.md");
  const existingSettings = readIfExists(settingsPath);
  const rendered = renderClaudeSettings(existingSettings, env, mode);
  const template = fs.readFileSync(path.join(env.repoRoot, "templates", "claude", "CLAUDE.md.tmpl"), "utf8");
  const existingMd = readIfExists(mdPath);
  const md = mode.mode === "remove" ? removeBlock(existingMd) : upsertBlock(existingMd, renderTemplate(template, claudeBlockVars(env)));
  const changes = [
    change(settingsPath, existingSettings, rendered.content, validateJson, 0o600),
    change(mdPath, existingMd, md === "" ? null : md),
  ];
  return {
    target: "claude",
    changes,
    managedKeys: rendered.managedKeys.concat(["CLAUDE.md managed block"]),
    preserved: rendered.preserved,
    conflicts: rendered.conflicts,
    unsupported: [],
    notes: ["Claude uses native permissions.allow/ask/deny + sandbox + autoMode; no hook required"],
  };
}

export function claudeManagedState(env: Environment): Record<string, unknown> {
  const m = claudeManaged(env);
  return {
    "claude.permissions.deny": m.deny,
    "claude.permissions.ask": m.ask,
    "claude.permissions.allow": m.allow,
    "claude.permissions.additionalDirectories": m.additionalDirectories,
    "claude.sandbox.filesystem.denyRead": m.denyRead,
    "claude.sandbox.filesystem.denyWrite": m.denyWrite,
    "claude.sandbox.filesystem.allowWrite": m.allowWrite,
    "claude.sandbox.excludedCommands": m.excludedCommands,
    "claude.sandbox.network.allowedDomains": m.allowedDomains,
    "claude.sandbox.credentials.files": m.credentialFiles.map((p) => ({ path: p, mode: "deny" })),
    "claude.sandbox.credentials.envVars": m.credentialEnvVars.map((n) => ({ name: n, mode: "deny" })),
    ...Object.fromEntries(Object.entries(autoModeEntries(env.config, env.ctx)).map(([k, v]) => [`claude.autoMode.${k}`, v])),
  };
}
