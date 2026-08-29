import * as fs from "node:fs";
import { nativeProdEnvGlobs } from "../../core/paths.ts";
import * as path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { Environment } from "../../config/loader.ts";
import { trustedDomains } from "../../config/loader.ts";
import { HASH_END, HASH_START, isObject, renderTemplate, stableJson, upsertBlock, removeBlock, type Json } from "../../config/merger.ts";
import { classifyCommand } from "../../core/classifier-facade.ts";
import type { PolicyContext } from "../../core/context.ts";
import { serializableContext } from "../../core/policy-loader.ts";
import { claudeBlockVars } from "../claude/generate.ts";
import { change, readIfExists, validateJson } from "../fs-helpers.ts";
import type { AdapterPlan, RenderMode } from "../types.ts";
import { codexRules, renderRulesBlock } from "./rules.ts";

export const CODEX_HOOK_DIR_NAME = "agents-adapter";
const PROFILE = "Auto mode";
export const CODEX_GH_CONFIG_DIR_TILDE = "~/.codex/gh";
/** env ที่ Codex ตั้งให้ทุก shell command: gh และ `gh auth git-credential` (git push/pull/fetch) ใช้ token จาก ~/.codex/gh */
export function codexShellEnvManaged(env: Environment): Record<string, string> {
  return { GH_CONFIG_DIR: path.join(env.home, ".codex", "gh"), GH_NO_UPDATE_NOTIFIER: "1" };
}

function validateToml(content: string): void {
  parseToml(content);
}

/** managed filesystem entries ของ permission profile */
export function codexFilesystemManaged(env: Environment): { profile: Record<string, string>; workspace: Record<string, string>; removeKeys: string[]; removeWorkspaceKeysPrefix: string[] } {
  const { ctx } = env;
  const tilde = (p: string): string => p.replace(ctx.home, "~");
  const profile: Record<string, string> = { ":minimal": "read" };
  for (const root of ctx.developmentRoots) profile[root] = "write";
  for (const c of ctx.credentialPaths) profile[tilde(c)] = "deny";
  // ข้อยกเว้น Codex: deny entry ใน managed profile เป็น escalatable=false (Codex 0.150) จึงไม่มีทางให้ gh รันนอก sandbox
  // เหมือน excludedCommands ของ Claude; gh และ `gh auth git-credential` (git push/fetch) ต้องอ่าน ~/.config/gh เอง
  // agent ยังห้ามอ่านเอง: hook CREDENTIAL_READ DENY + rule `gh auth token` forbidden
  profile["~/.config/gh"] = "read";
  // token ของ gh ใน ~/.config/gh อยู่ใน macOS keychain ซึ่ง seatbelt ของ Codex ปิดทุกโหมด (แม้ escalated) จึงใช้ agent token
  // แยกใน ~/.codex/gh (hosts.yml ที่ user สร้างด้วย fine-grained PAT ผ่าน `gh auth login --insecure-storage`) และชี้ด้วย
  // GH_CONFIG_DIR; gh ต้องอ่าน dir นี้ใน sandbox แต่ agent ยังห้ามอ่าน/แสดง (credential_paths -> hook DENY)
  profile[CODEX_GH_CONFIG_DIR_TILDE] = "read";
  profile["~/.gitconfig"] = "read";
  profile["~/.config/git"] = "read";
  profile["~/.codex/hooks"] = "read";
  profile["~/.codex/rules"] = "read";
  profile["~/.codex/skills"] = "read";
  profile["~/.codex/tmp"] = "write";
  profile["~/.cache"] = "write";
  profile["~/.npm"] = "write";
  profile["~/.nvm/versions/node"] = "read";
  profile["/opt/homebrew"] = "read";
  profile["/usr/local"] = "read";
  const workspace: Record<string, string> = { ".": "write", ".git": "write" };
  const prodGlobs = nativeProdEnvGlobs(ctx.prodEnvPatterns);
  // root-level เท่านั้น ห้ามใช้ `**/`: Codex 0.150 seatbelt deny file-write-unlink/rename ของทุก directory
  // ที่อาจเป็น parent ของ match ทำให้ rmdir / rm -r / mv directory ใน workspace ล้ม "Operation not permitted"
  // ไฟล์ซ้อนลึกยังถูก hook classifier DENY (PROD_ENV_*, CREDENTIAL_*)
  for (const pat of prodGlobs) workspace[pat] = "deny";
  for (const ext of ctx.credentialExtensions) workspace[`*${ext}`] = "deny";
  for (const base of ctx.credentialBasenames) workspace[base] = "deny";
  workspace[".env.example"] = "write";
  return {
    profile,
    workspace,
    removeKeys: ["/"],
    // development env ต้องอ่านและแก้ได้: ลบ deny ที่ครอบ .env / .env.* ทั้งหมด
    removeWorkspaceKeysPrefix: ["**/.env", ".env"],
  };
}

export const AUTO_REVIEW_POLICY = `${HASH_START}
Approve only reversible, task-scoped development actions whose target and intent are explicit in the current user request.
Never approve: merge or auto-merge of pull requests, repository deletion, gist creation, credential or token access, force push, push to protected branches, production deploy or production database mutation.
Approve destructive local operations (delete, rename, overwrite) when every target is inside the Development Trust Zone workspace and is not a repository root, .git directory or the zone root.
Approve delete_file, protected-ref update, staging deploy or destructive operations outside the workspace only when the current user request names that exact action and target.
${HASH_END}`;

export function renderCodexConfig(existing: string | null, env: Environment, mode: RenderMode): { content: string; managedKeys: string[]; conflicts: string[]; preserved: string[]; unsupported: string[] } {
  const doc: Record<string, Json> = existing ? (parseToml(existing) as Record<string, Json>) : {};
  const conflicts: string[] = [];
  const unsupported: string[] = [];
  const managedKeys: string[] = [];
  const remove = mode.mode === "remove";
  const fsm = codexFilesystemManaged(env);

  if (remove) {
    // uninstall: คืนเฉพาะ managed keys ที่เพิ่ม; ไม่คืน sandbox_mode (danger-full-access) เพราะเป็น conflict เดิม
    const perm = getObj(doc, ["permissions", PROFILE]);
    if (perm) {
      const fsTable = getObj(perm, ["filesystem"]);
      if (fsTable) for (const k of Object.keys(fsm.profile)) delete fsTable[k];
      const ws = fsTable ? getObj(fsTable, [":workspace_roots"]) : null;
      if (ws) for (const k of Object.keys(fsm.workspace)) delete ws[k];
    }
    const ar = getObj(doc, ["auto_review"]);
    if (ar && typeof ar.policy === "string") ar.policy = removeBlock(ar.policy, { start: HASH_START, end: HASH_END }) ?? "";
    const envSet = getObj(doc, ["shell_environment_policy", "set"]);
    if (envSet) for (const k of Object.keys(codexShellEnvManaged(env))) delete envSet[k];
    return { content: stringifyToml(doc) + "\n", managedKeys: [], conflicts, preserved: Object.keys(doc), unsupported };
  }

  // 1. conflict: sandbox_mode + default_permissions
  if ("sandbox_mode" in doc) {
    conflicts.push(`sandbox_mode = ${JSON.stringify(doc.sandbox_mode)} removed (conflicts with default_permissions; danger-full-access is forbidden)`);
    delete doc.sandbox_mode;
  }
  doc.approval_policy = "on-request";
  doc.approvals_reviewer = "auto_review";
  doc.default_permissions = PROFILE;
  managedKeys.push("approval_policy", "approvals_reviewer", "default_permissions", "sandbox_mode (removed)");

  // 2. permission profile
  const perm = ensureObj(doc, ["permissions", PROFILE]);
  if (perm.extends !== ":workspace") {
    if (perm.extends !== undefined) conflicts.push(`permissions."${PROFILE}".extends was ${JSON.stringify(perm.extends)}`);
    perm.extends = ":workspace";
  }
  if (typeof perm.description !== "string") perm.description = "agents-adapter managed workspace profile";
  const fsTable = ensureObj(perm, ["filesystem"]);
  for (const k of fsm.removeKeys) {
    if (k in fsTable) {
      conflicts.push(`permissions."${PROFILE}".filesystem["${k}"] = ${JSON.stringify(fsTable[k])} removed`);
      delete fsTable[k];
    }
  }
  for (const [k, v] of Object.entries(fsm.profile)) {
    if (k in fsTable && fsTable[k] !== v) conflicts.push(`filesystem["${k}"]: ${JSON.stringify(fsTable[k])} -> "${v}"`);
    fsTable[k] = v;
  }
  const ws = ensureObj(fsTable, [":workspace_roots"]);
  for (const k of Object.keys(ws)) {
    if (k.startsWith("**/") && ws[k] === "deny") {
      conflicts.push(`workspace_roots["${k}"] = "deny" removed (recursive glob makes Codex seatbelt deny unlink/rename of every workspace directory; root-level pattern used instead)`);
      delete ws[k];
      continue;
    }
    if (fsm.removeWorkspaceKeysPrefix.some((p) => k.startsWith(p)) && ws[k] === "deny" && !(k in fsm.workspace)) {
      conflicts.push(`workspace_roots["${k}"] = "deny" removed (not a managed production env glob; development env must stay readable/writable)`);
      delete ws[k];
    }
  }
  for (const [k, v] of Object.entries(fsm.workspace)) ws[k] = v;
  managedKeys.push(`permissions."${PROFILE}".filesystem`, `permissions."${PROFILE}".filesystem.":workspace_roots"`);

  // 3. network: เติม trusted domains ถ้ายังไม่มี network section
  const net = ensureObj(perm, ["network"]);
  if (net.enabled === undefined) net.enabled = true;
  const domains = ensureObj(net, ["domains"]);
  for (const d of trustedDomains(env.config)) {
    const key = d.startsWith("*.") ? `**${d.slice(1)}` : d;
    if (!(key in domains)) domains[key] = "allow";
  }
  managedKeys.push(`permissions."${PROFILE}".network.domains (additive)`);

  // 3b. shell env: GH_CONFIG_DIR ชี้ agent token dir (keychain ของ gh ใช้ใน seatbelt ไม่ได้); key อื่นใน set ของ user คงไว้
  const envSet = ensureObj(ensureObj(doc, ["shell_environment_policy"]), ["set"]);
  for (const [k, v] of Object.entries(codexShellEnvManaged(env))) {
    if (k in envSet && envSet[k] !== v) conflicts.push(`shell_environment_policy.set.${k}: ${JSON.stringify(envSet[k])} -> ${JSON.stringify(v)}`);
    envSet[k] = v;
  }
  managedKeys.push("shell_environment_policy.set.GH_CONFIG_DIR", "shell_environment_policy.set.GH_NO_UPDATE_NOTIFIER");

  // 4. auto_review policy managed block
  const ar = ensureObj(doc, ["auto_review"]);
  ar.policy = upsertBlock(typeof ar.policy === "string" ? ar.policy : null, AUTO_REVIEW_POLICY.split("\n").slice(1, -1).join("\n"), { start: HASH_START, end: HASH_END }).trimEnd();
  managedKeys.push("auto_review.policy (managed block)");

  // 5. GitHub connector tools: detect dynamically, never hardcode connector id
  const apps = getObj(doc, ["apps"]);
  const appsDefault = ensureObj(ensureObj(doc, ["apps"]), ["_default"]);
  if (appsDefault.approvals_reviewer === undefined) appsDefault.approvals_reviewer = "auto_review";
  if (appsDefault.default_tools_approval_mode === undefined) appsDefault.default_tools_approval_mode = "writes";
  let connectorCount = 0;
  if (apps) {
    for (const [id, app] of Object.entries(apps)) {
      if (id === "_default" || !isObject(app)) continue;
      const tools = getObj(app as Record<string, Json>, ["tools"]);
      const isGithub = tools !== null && Object.keys(tools).some((t) => t.startsWith("github."));
      if (!isGithub) continue;
      connectorCount++;
      const t = ensureObj(app as Record<string, Json>, ["tools"]);
      for (const name of ["github.merge_pull_request", "github.enable_auto_merge", "github.delete_file", "github.update_ref"]) {
        const entry = ensureObj(t, [name]);
        entry.approval_mode = "prompt";
      }
      managedKeys.push(`apps.<github connector>.tools.* approval_mode=prompt (detected ${id.slice(0, 10)}...)`);
    }
  }
  if (connectorCount === 0) unsupported.push("no GitHub connector detected in [apps]; connector tool controls will be applied when a connector appears");

  const preserved = Object.keys(doc).filter((k) => !["approval_policy", "approvals_reviewer", "default_permissions", "permissions", "auto_review", "apps", "shell_environment_policy"].includes(k));
  return { content: stringifyToml(doc) + "\n", managedKeys, conflicts, preserved, unsupported };
}

function getObj(obj: Record<string, Json>, p: string[]): Record<string, Json> | null {
  let cur: Json | undefined = obj;
  for (const k of p) {
    if (!isObject(cur)) return null;
    cur = cur[k];
  }
  return isObject(cur) ? cur : null;
}

function ensureObj(obj: Record<string, Json>, p: string[]): Record<string, Json> {
  let cur = obj;
  for (const k of p) {
    if (!isObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, Json>;
  }
  return cur;
}

export function renderRequirements(existing: string | null, mode: RenderMode): string | null {
  const doc: Record<string, Json> = existing ? (parseToml(existing) as Record<string, Json>) : {};
  if (mode.mode === "remove") {
    delete doc.allowed_permission_profiles;
    delete doc.allowed_sandbox_modes;
    delete doc.allowed_approval_policies;
    delete doc.allowed_approvals_reviewers;
    return Object.keys(doc).length === 0 ? null : stringifyToml(doc) + "\n";
  }
  doc.allowed_permission_profiles = { [PROFILE]: true, ":read-only": true, ":workspace": true, ":danger-full-access": false };
  doc.allowed_sandbox_modes = ["read-only", "workspace-write"];
  doc.allowed_approval_policies = ["untrusted", "on-request"];
  doc.allowed_approvals_reviewers = ["user", "auto_review"];
  return stringifyToml(doc) + "\n";
}

export function hookCommands(home: string): Record<string, string> {
  const dir = path.join(home, ".codex", "hooks", CODEX_HOOK_DIR_NAME);
  return {
    policy_gate: `python3 '${dir}/policy_gate.py'`,
    protected_paths: `python3 '${dir}/protected_paths.py'`,
    startup_preflight: `python3 '${dir}/startup_preflight.py'`,
    lang_guard: `python3 '${dir}/lang_guard.py'`,
  };
}

export function renderHooksJson(existing: string | null, env: Environment, mode: RenderMode): string {
  const doc: Record<string, Json> = existing ? (JSON.parse(existing) as Record<string, Json>) : {};
  const hooks = ensureObj(doc, ["hooks"]);
  const cmds = hookCommands(env.home);
  const marker = `/hooks/${CODEX_HOOK_DIR_NAME}/`;
  const wanted: Record<string, Array<{ matcher?: string; command: string; timeout: number; statusMessage: string }>> = {
    PreToolUse: [
      { matcher: ".*", command: cmds.policy_gate, timeout: 10, statusMessage: "agents-adapter policy gate" },
      { matcher: "^(Read|Write|Edit|MultiEdit|apply_patch|read_file|write_file)$", command: cmds.protected_paths, timeout: 10, statusMessage: "agents-adapter protected paths" },
    ],
    SessionStart: [{ matcher: "startup|resume", command: cmds.startup_preflight, timeout: 5, statusMessage: "agents-adapter preflight" }],
    Stop: [{ command: cmds.lang_guard, timeout: 5, statusMessage: "agents-adapter language guard" }],
  };
  for (const [event, entries] of Object.entries(wanted)) {
    const cur = Array.isArray(hooks[event]) ? (hooks[event] as Json[]) : [];
    const kept = cur.filter((group) => {
      if (!isObject(group)) return true;
      const inner = Array.isArray(group.hooks) ? (group.hooks as Json[]) : [];
      return !inner.some((h) => isObject(h) && typeof h.command === "string" && h.command.includes(marker));
    });
    if (mode.mode === "remove") {
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
      continue;
    }
    const ours: Json[] = entries.map((e) => {
      const group: Record<string, Json> = { hooks: [{ type: "command", command: e.command, timeout: e.timeout, statusMessage: e.statusMessage }] };
      if (e.matcher) group.matcher = e.matcher;
      return group;
    });
    hooks[event] = [...ours, ...kept];
  }
  return stableJson(doc);
}

export function renderRulesFile(existing: string | null, env: Environment, mode: RenderMode, conflicts: string[] = []): string | null {
  if (mode.mode === "remove") {
    const out = removeBlock(existing, { start: HASH_START, end: HASH_END });
    return out === null || out.trim() === "" ? null : out;
  }
  const stripped = existing === null ? null : stripShadowingUserRules(existing, env.ctx, conflicts);
  return upsertBlock(stripped, renderRulesBlock(codexRules(env.config)), { start: HASH_START, end: HASH_END });
}

/**
 * user prefix_rule ที่ prompt/forbidden ทับ command ซึ่ง policy ตัดสิน ALLOW (เช่น `rm`, `rmdir`, `git checkout`)
 * Codex ใช้ strictest matching rule จึงทำให้งาน routine ใน workspace ต้องขอ approval ทุกครั้ง; ตัดออกแล้วรายงานเป็น conflict
 */
export function stripShadowingUserRules(text: string, ctx: PolicyContext, conflicts: string[]): string {
  const re = /prefix_rule\(\s*pattern\s*=\s*(\[[^\n]*\])\s*,\s*decision\s*=\s*"(prompt|forbidden)"[\s\S]*?\)\n*/g;
  return text.replace(re, (block: string, pat: string, decision: string) => {
    if (block.includes("agents-adapter")) return block;
    let pattern: Array<string | string[]>;
    try {
      pattern = JSON.parse(pat) as Array<string | string[]>;
    } catch {
      return block;
    }
    const commands = pattern.reduce<string[]>((acc, part) => {
      const alts = Array.isArray(part) ? part : [part];
      return acc.flatMap((prefix) => alts.map((a) => (prefix ? `${prefix} ${a}` : a)));
    }, [""]);
    if (commands.length === 0 || !commands.every((c) => classifyCommand(c, ctx).decision === "ALLOW")) return block;
    conflicts.push(`rules: user prefix_rule ${pat} = "${decision}" removed (policy classifies it ALLOW inside the Development Trust Zone)`);
    return "";
  });
}

export function renderCodex(env: Environment, mode: RenderMode): AdapterPlan {
  const codexDir = path.join(env.home, ".codex");
  const hookDir = path.join(codexDir, "hooks", CODEX_HOOK_DIR_NAME);
  const remove = mode.mode === "remove";
  const changes = [];
  const notes: string[] = [];

  const configPath = path.join(codexDir, "config.toml");
  const existingConfig = readIfExists(configPath);
  const cfg = renderCodexConfig(existingConfig, env, mode);
  changes.push(change(configPath, existingConfig, cfg.content, validateToml, 0o600));

  const reqPath = path.join(codexDir, "requirements.toml");
  const existingReq = readIfExists(reqPath);
  changes.push(change(reqPath, existingReq, renderRequirements(existingReq, mode), validateToml));

  const hooksPath = path.join(codexDir, "hooks.json");
  const existingHooks = readIfExists(hooksPath);
  changes.push(change(hooksPath, existingHooks, renderHooksJson(existingHooks, env, mode), validateJson));

  const rulesPath = path.join(codexDir, "rules", "default.rules");
  const existingRules = readIfExists(rulesPath);
  changes.push(change(rulesPath, existingRules, renderRulesFile(existingRules, env, mode, cfg.conflicts)));

  const agentsPath = path.join(codexDir, "AGENTS.md");
  const existingAgents = readIfExists(agentsPath);
  const template = fs.readFileSync(path.join(env.repoRoot, "templates", "codex", "AGENTS.md.tmpl"), "utf8");
  const agentsMd = remove ? removeBlock(existingAgents) : upsertBlock(existingAgents, renderTemplate(template, claudeBlockVars(env)));
  changes.push(change(agentsPath, existingAgents, agentsMd === "" ? null : agentsMd));

  // runtime files
  const runtimeDir = path.join(env.repoRoot, "runtime", "codex", "hooks");
  for (const f of ["agents_adapter_policy.py", "policy_gate.py", "protected_paths.py", "startup_preflight.py", "lang_guard.py"]) {
    const target = path.join(hookDir, f);
    const existing = readIfExists(target);
    changes.push(change(target, existing, remove ? null : fs.readFileSync(path.join(runtimeDir, f), "utf8"), undefined, 0o755));
  }
  const ctxPath = path.join(hookDir, "agents-adapter.config.json");
  const existingCtx = readIfExists(ctxPath);
  changes.push(change(ctxPath, existingCtx, remove ? null : stableJson(serializableContext(env.ctx)), validateJson));
  // ค่า config path ที่ hook คาดหวังคือ ~/.codex/hooks/agents-adapter.config.json (ตาม policy_gate.DEFAULT_CONFIG)
  const ctxDefaultPath = path.join(codexDir, "hooks", "agents-adapter.config.json");
  const existingCtxDefault = readIfExists(ctxDefaultPath);
  changes.push(change(ctxDefaultPath, existingCtxDefault, remove ? null : stableJson(serializableContext(env.ctx)), validateJson));

  notes.push("hooks require trust in Codex before they run: open codex once and accept the new hooks (hooks.state trusted_hash)");
  notes.push("ASK is enforced natively by rules (prompt) + approvals reviewer policy; PreToolUse hook enforces DENY and adds context for ASK");
  notes.push("requirements.toml at ~/.codex is honoured by Codex only when loaded as system requirements; verify with `codex doctor`");
  return {
    target: "codex",
    changes,
    managedKeys: cfg.managedKeys.concat(["requirements.toml managed keys", "hooks.json agents-adapter entries", "rules/default.rules managed block", "AGENTS.md managed block", `hooks/${CODEX_HOOK_DIR_NAME}/*`]),
    preserved: cfg.preserved,
    conflicts: cfg.conflicts,
    unsupported: cfg.unsupported,
    notes,
  };
}

export function codexManagedState(env: Environment): Record<string, unknown> {
  const fsm = codexFilesystemManaged(env);
  return { "codex.filesystem.profile": Object.keys(fsm.profile), "codex.filesystem.workspace": Object.keys(fsm.workspace) };
}
