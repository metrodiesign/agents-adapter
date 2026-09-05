import * as fs from "node:fs";
import * as path from "node:path";
import type { Environment } from "../../config/loader.ts";
import { trustedDomains } from "../../config/loader.ts";
import { getPath, isObject, mergeManagedList, renderTemplate, setPath, stableJson, stripManagedList, upsertBlock, removeBlock, type Json } from "../../config/merger.ts";
import { agentGhConfigDir, loadProtectedPaths, loadTrustedDefaults, serializableContext, sharedScriptPaths, wrapperPaths } from "../../core/policy-loader.ts";
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
  allowedUnixSockets: string[];
  allowMachLookup: string[];
  additionalDirectories: string[];
  allowWrite: string[];
  shellEnv: Record<string, string>;
  /** absolute path ของ wrapper ที่ติดตั้งใน ~/.claude/hooks/agents-adapter (excludedCommands + permissions.allow) */
  wrappers: string[];
}

export function claudeManaged(env: Environment): ClaudeManaged {
  const { config, ctx } = env;
  const pats = claudePatterns(config, ctx);
  const protectedPaths = loadProtectedPaths();
  const defaults = loadTrustedDefaults();
  const tilde = (p: string): string => p.replace(ctx.home, "~");
  // gh subprocess (gh, gh auth git-credential ที่ git เรียก) ต้องอ่าน agent token dir ของ Claude เองใน sandbox:
  // ตัดออกจาก denyRead/credentials.files เฉพาะ dir นี้ (ยัง deny write, ยัง deny Read/Edit tool และ Bash pattern ใน permissions)
  const ghDir = agentGhConfigDir(ctx.home, "claude");
  const sandboxDenied = ctx.credentialPaths.filter((p) => p !== ghDir);
  const wrappers = wrapperPaths(ctx.home, "claude");
  return {
    deny: pats.deny,
    ask: pats.ask,
    allow: pats.allow,
    denyRead: sandboxDenied.map(tilde),
    // system config ใต้ home ทั้งชุด (shell rc, settings/config/hooks/rules ของทุก CLI, config ของ adapter): SYSTEM_CONFIG_CHANGE เป็น ASK
    // และ hooks dir ของ Codex ต้องแก้จาก Claude sandbox ไม่ได้ ไม่งั้น wrapper ที่ Codex รัน escalated ถูกเขียนทับจากใน sandbox
    denyWrite: [...ctx.credentialPaths.map(tilde), ...ctx.systemConfigPaths.filter((p) => p.startsWith(ctx.home)).map(tilde)],
    credentialFiles: sandboxDenied.map(tilde),
    credentialEnvVars: protectedPaths.credential_env_vars,
    // wrapper ต้องรันนอก sandbox (signal ข้าม sandbox); match ด้วย absolute path จึงต้องเป็นไฟล์ใน hooks dir ที่ sandbox เขียนไม่ได้
    excludedCommands: [...defaults.excluded_commands, ...wrappers.map((p) => `${p} *`)],
    allowedDomains: trustedDomains(config),
    // socket ที่ process ลูกใน sandbox ต้องต่อได้ (docker ที่ถูกเรียกจาก script ไม่ได้รับการยกเว้นจาก excludedCommands)
    allowedUnixSockets: defaults.allowed_unix_sockets.map((p) => p.replace(/\$\{HOME\}/g, ctx.home)),
    // trustd.agent: Go TLS (gh, docker buildx); sysmond: pgrep/pkill process list; entry ของ user (เช่น coresimulator) คงอยู่
    allowMachLookup: defaults.sandbox_mach_services,
    additionalDirectories: ctx.developmentRoots,
    allowWrite: [...ctx.developmentRoots, ...ctx.agentConfigDirs, ...ctx.alwaysWritable],
    // GH_CONFIG_DIR: gh อ่าน agent token จาก ~/.claude/gh แทน ~/.config/gh + keychain (ใช้ทั้งใน/นอก sandbox)
    shellEnv: { GH_CONFIG_DIR: ghDir, ...defaults.sandbox_shell_env },
    wrappers,
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
  const preservedTop = Object.keys(settings).filter((k) => !["permissions", "sandbox", "autoMode", "language", "hooks"].includes(k));

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
    [["sandbox", "network", "allowUnixSockets"], "allowedUnixSockets", "claude.sandbox.network.allowUnixSockets"],
    [["sandbox", "network", "allowMachLookup"], "allowMachLookup", "claude.sandbox.network.allowMachLookup"],
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
    // ถ้า allowUnsandboxedCommands เป็น false ทั้ง excludedCommands จะไร้ผลโดยไม่มีสัญญาณเตือน
    [["sandbox", "allowUnsandboxedCommands"], true],
    // fail-closed: ถ้า sandbox ใช้ไม่ได้ต้องหยุด ไม่ใช่รันดิบ
    [["sandbox", "failIfUnavailable"], true],
    [["sandbox", "network", "allowLocalBinding"], true],
    [["autoMode", "classifyAllShell"], true],
    [["language"], "thai"],
    ...Object.entries(m.shellEnv).map(([k, v]) => [["env", k], v] as [string[], Json]),
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
  // hooks: เฉพาะ entry ที่ command ชี้ hooks/agents-adapter/ เป็น managed; entry ของ user คงอยู่
  mergeClaudeHooks(settings, env.home, remove);
  managedKeys.push("hooks.PreToolUse (agents-adapter entries)");

  if (!remove && getPath(settings, ["permissions", "defaultMode"]) === "bypassPermissions") {
    conflicts.push("permissions.defaultMode was bypassPermissions; reset to default");
    setPath(settings, ["permissions", "defaultMode"], "default");
  }
  return { content: stableJson(settings), managedKeys, preserved: preservedTop, conflicts };
}

export const CLAUDE_HOOK_DIR_NAME = "agents-adapter";
const CLAUDE_RUNTIME_HOOKS = ["provider_guard.py"];
/** wrapper ที่ใช้ร่วมทุก CLI (runtime/shared) ติดตั้งลง hooks dir เดียวกับ hook เพราะ sandbox เขียน dir นี้ไม่ได้ */
export function sharedWrapperSource(repoRoot: string, file: string): string {
  return fs.readFileSync(path.join(repoRoot, "runtime", "shared", file), "utf8");
}

export function claudeHookCommand(home: string, file: string): string {
  const script = path.join(home, ".claude", "hooks", CLAUDE_HOOK_DIR_NAME, file);
  // fail-open เมื่อไม่มี python3 หรือไฟล์หาย ตามกฎ hook ของ Claude reference
  return `/bin/sh -c 'if command -v python3 >/dev/null 2>&1 && [ -f "${script}" ]; then exec python3 "${script}"; fi'`;
}

function mergeClaudeHooks(settings: Record<string, Json>, home: string, remove: boolean): void {
  const marker = `/hooks/${CLAUDE_HOOK_DIR_NAME}/`;
  const hooksRaw = getPath(settings, ["hooks"]);
  const hooks: Record<string, Json> = isObject(hooksRaw) ? hooksRaw : {};
  const wanted: Record<string, Array<{ matcher: string; file: string; timeout: number }>> = {
    PreToolUse: [{ matcher: "^(Agent|Task)$", file: "provider_guard.py", timeout: 5 }],
  };
  for (const [event, entries] of Object.entries(wanted)) {
    const cur = Array.isArray(hooks[event]) ? (hooks[event] as Json[]) : [];
    const kept = cur.filter((group) => {
      if (!isObject(group)) return true;
      const inner = Array.isArray(group.hooks) ? (group.hooks as Json[]) : [];
      return !inner.some((h) => isObject(h) && typeof h.command === "string" && h.command.includes(marker));
    });
    if (remove) {
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
      continue;
    }
    const ours: Json[] = entries.map((e) => ({ matcher: e.matcher, hooks: [{ type: "command", command: claudeHookCommand(home, e.file), timeout: e.timeout }] }));
    hooks[event] = [...ours, ...kept];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
}

export function claudeBlockVars(env: Environment): Record<string, string> {
  return {
    version: VERSION,
    development_roots: env.ctx.developmentRoots.map((r) => r.replace(env.home, "${HOME}")).join("\n"),
    protected_branches: env.config.protected_branches.join(", "),
    development_env_patterns: env.ctx.devEnvPatterns.join(", "),
    production_env_patterns: env.ctx.prodEnvPatterns.join(", "),
    pi_isolation_mode: env.config.pi?.isolation_mode ?? "host-macos",
    gh_agent_config_dir_claude: agentGhConfigDir(env.home, "claude").replace(env.home, "~"),
    gh_agent_config_dir_codex: agentGhConfigDir(env.home, "codex").replace(env.home, "~"),
    free_port_wrapper_claude: wrapperPaths(env.home, "claude")[0] ?? "",
    free_port_wrapper_codex: wrapperPaths(env.home, "codex")[0] ?? "",
    sandbox_probe_claude: sharedScriptPaths(env.home, "claude")[0] ?? "",
    sandbox_probe_codex: sharedScriptPaths(env.home, "codex")[0] ?? "",
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
  const remove = mode.mode === "remove";
  const changes = [
    change(settingsPath, existingSettings, rendered.content, validateJson, 0o600),
    change(mdPath, existingMd, md === "" ? null : md),
  ];
  // runtime hook + serialized PolicyContext (provider guard อ่าน securityAgentTypes/anthropicHosts จากไฟล์นี้)
  const hookDir = path.join(dir, "hooks", CLAUDE_HOOK_DIR_NAME);
  const runtimeDir = path.join(env.repoRoot, "runtime", "claude", "hooks");
  for (const f of CLAUDE_RUNTIME_HOOKS) {
    const target = path.join(hookDir, f);
    changes.push(change(target, readIfExists(target), remove ? null : fs.readFileSync(path.join(runtimeDir, f), "utf8"), undefined, 0o755));
  }
  const ctxPath = path.join(hookDir, "agents-adapter.config.json");
  changes.push(change(ctxPath, readIfExists(ctxPath), remove ? null : stableJson(serializableContext(env.ctx)), validateJson));
  for (const f of [...loadTrustedDefaults().unsandboxed_wrappers, ...loadTrustedDefaults().shared_scripts]) {
    const target = path.join(hookDir, f);
    changes.push(change(target, readIfExists(target), remove ? null : sharedWrapperSource(env.repoRoot, f), undefined, 0o755));
  }
  const unsupported: string[] = [];
  // stat เท่านั้น ไม่อ่านเนื้อหา: env.GH_CONFIG_DIR ชี้ dir นี้ทันทีหลัง apply ถ้ายังไม่มี token gh/git push ทุกรูปแบบจะพัง
  const hosts = path.join(agentGhConfigDir(env.home, "claude"), "hosts.yml");
  if (!remove && !fs.existsSync(hosts)) unsupported.push(`${hosts.replace(env.home, "~")} missing: gh and git push/fetch will fail until the GitHub setup in docs/claude-adapter.md is done (doctor: gh agent token (claude))`);
  return {
    target: "claude",
    changes,
    managedKeys: rendered.managedKeys.concat(["CLAUDE.md managed block", `hooks/${CLAUDE_HOOK_DIR_NAME}/*`]),
    preserved: rendered.preserved,
    conflicts: rendered.conflicts,
    unsupported,
    notes: [
      "Claude uses native permissions.allow/ask/deny + sandbox + autoMode; the only hook is provider_guard.py (PreToolUse Agent|Task)",
      "provider guard denies security agents (auditor, skeptic, security-review) when ANTHROPIC_BASE_URL is not Anthropic",
      `gh, git push/fetch/pull and docker now run inside the sandbox: env.GH_CONFIG_DIR=${agentGhConfigDir(env.home, "claude").replace(env.home, "~")} needs an agent token (see docs/claude-adapter.md GitHub setup; doctor: gh agent token (claude)), allowMachLookup adds com.apple.trustd.agent (Go TLS) and com.apple.sysmond (pgrep)`,
      "sandbox settings are read at session start: open a new Claude session after apply, then run scripts/sandbox-probe.sh",
    ],
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
    "claude.sandbox.network.allowUnixSockets": m.allowedUnixSockets,
    "claude.sandbox.network.allowMachLookup": m.allowMachLookup,
    "claude.sandbox.credentials.files": m.credentialFiles.map((p) => ({ path: p, mode: "deny" })),
    "claude.sandbox.credentials.envVars": m.credentialEnvVars.map((n) => ({ name: n, mode: "deny" })),
    ...Object.fromEntries(Object.entries(autoModeEntries(env.config, env.ctx)).map(([k, v]) => [`claude.autoMode.${k}`, v])),
  };
}
