/**
 * Shared runtime for agents-adapter Pi extensions.
 *
 * ในเครื่องที่ติดตั้งแล้ว installer จะคัดลอก src/core/*.ts มาไว้ใน ./core/ และ
 * เขียน import ด้านล่างให้ชี้ ./core/ (ดู src/adapters/pi/generate.ts)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyCommand, classifyTool, classifyUserInput } from "./core/classifier.ts";
import type { PolicyContext } from "./core/context.ts";
import type { Verdict } from "./core/decisions.ts";

export type { Verdict, PolicyContext };
export { classifyCommand, classifyTool, classifyUserInput };

/** โครงสร้างขั้นต่ำของ Pi ExtensionAPI/ExtensionContext ที่ extension นี้ใช้ (ไม่พึ่ง type package ของ Pi) */
export interface PiUi {
  confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}
/** subset ของ Pi ExtensionContext ที่ auto-review ใช้ (ดู examples/extensions/qna.ts ของ Pi) */
export interface PiModelRegistry {
  complete(model: unknown, context: { systemPrompt?: string; messages: unknown[] }, options?: { signal?: AbortSignal }): Promise<{ content: Array<{ type: string; text?: string }> }>;
}
export interface PiSessionManager {
  getBranch(): Array<{ type: string; message?: { role?: string; content?: unknown } }>;
}
export interface PiContext {
  ui: PiUi;
  hasUI: boolean;
  cwd: string;
  model?: unknown;
  modelRegistry?: PiModelRegistry;
  sessionManager?: PiSessionManager;
}
export interface PiApi {
  on(event: string, handler: (event: any, ctx: PiContext) => unknown): void;
}

export interface BashResultLike {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
}

const CONFIG_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), "config.json");

/** ข้อความ policy ของ Claude Auto mode (allow/soft_deny/hard_deny/environment) ที่ generate ลง config.json */
export interface AutoModeSets {
  allow: string[];
  soft_deny: string[];
  hard_deny: string[];
  environment: string[];
}

let cached: Omit<PolicyContext, "cwd"> | null = null;
let autoMode: AutoModeSets | null = null;

export function loadContext(cwd: string): PolicyContext {
  if (cached === null) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Omit<PolicyContext, "cwd"> & { autoMode?: AutoModeSets };
      const { autoMode: am, ...rest } = raw;
      cached = rest;
      autoMode = am ?? null;
    } catch {
      // fail closed: ไม่มี config ก็ยังปกป้อง credential ด้วยค่าเริ่มต้นแคบที่สุด
      const home = os.homedir();
      cached = {
        home,
        tmpdir: os.tmpdir(),
        developmentRoots: [],
        protectedBranches: ["main", "develop"],
        devEnvPatterns: [".env", ".env.local", ".env.development", ".env.test", ".env.testing"],
        prodEnvPatterns: [".env.production", ".env.production.*", ".env.prod", ".env.prod.*"],
        credentialPaths: [`${home}/.ssh`, `${home}/.aws`, `${home}/.azure`, `${home}/.kube`, `${home}/.config/gh`, `${home}/.codex/auth.json`, `${home}/.claude/.credentials.json`, `${home}/.claude.json`, `${home}/.docker/config.json`, `${home}/Library/Keychains`, `${home}/.pi/agent/auth.json`],
        credentialBasenames: ["id_rsa", "id_ed25519", "auth.json", "credentials.json"],
        credentialExtensions: [".pem", ".key", ".p12", ".pfx"],
        systemConfigPaths: [`${home}/.zshrc`, `${home}/.bashrc`, `${home}/.zprofile`, `${home}/.bash_profile`],
        alwaysWritable: [os.tmpdir()],
        agentConfigDirs: [`${home}/.pi`],
        securityAgentTypes: ["auditor", "skeptic", "security-review", "security-reviewer", "security-auditor"],
        anthropicHosts: ["api.anthropic.com"],
      };
    }
  }
  const providerHost = cached.providerHost ?? hostFromEnv(process.env.ANTHROPIC_BASE_URL);
  return providerHost ? { ...cached, cwd, providerHost } : { ...cached, cwd };
}

function hostFromEnv(url: string | undefined): string | undefined {
  if (!url || url.trim() === "") return undefined;
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** approval cache ต่อ session: key = rule + target (+ environment marker) */
const approvals = new Map<string, boolean>();

export function approvalKey(v: Verdict): string {
  const env = /prod/i.test(v.target ?? "") ? "production" : "development";
  return `${v.ruleId}|${v.target ?? ""}|${env}`;
}

/**
 * rule ที่ Claude ใส่ใน permissions.ask (user decision): dialog เสมอ ไม่ส่งให้ reviewer
 * ต้องตรงกับ ask list ใน src/adapters/claude/rules.ts
 */
export const USER_DECISION_RULES: ReadonlySet<string> = new Set([
  "GH_PR_MERGE",
  "RELEASE_TAG",
  "GIT_RESET_HARD",
  "GIT_CLEAN",
  "GIT_BRANCH_FORCE_DELETE",
  "GIT_REMOTE_DELETE",
  "GIT_REMOTE_CHANGE",
  "SYSTEM_CONFIG_CHANGE",
  "GH_AUTH_CHANGE",
  "GH_REPO_CREATE",
  "GH_DELETE_FILE",
  "DOCKER_PRUNE",
  "DOCKER_DELETE_VOLUME",
  "GLOBAL_DEP_INSTALL",
  "STAGING_DEPLOY",
  "PROD_DEPLOY",
  "LOCAL_DESTRUCTIVE_DB",
]);

const REVIEW_TIMEOUT_MS = 20_000;

/** ข้อความ user ล่าสุดใน branch ปัจจุบันของ session (reviewer ใช้ตัดสิน intent เหมือน Claude Auto mode) */
export function lastUserRequest(ctx: PiContext): string {
  const entries = ctx.sessionManager?.getBranch() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const c = e.message.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : "")).join("\n") : "";
    if (text.trim() !== "") return text.slice(0, 4000);
  }
  return "";
}

export function autoReviewPrompt(sets: AutoModeSets): string {
  const list = (xs: string[]): string => xs.map((x) => `- ${x}`).join("\n");
  return [
    "You are the permission classifier for an autonomous coding agent (same role as Claude Code Auto mode).",
    "Decide whether ONE pending tool action may run without asking the human.",
    "Reply with exactly one word: allow or ask.",
    "Answer allow only when the action is reversible, task-scoped and its target and intent are explicit in the current user request.",
    "Answer ask when unsure, when the action matches soft_deny without explicit user intent, or when it matches hard_deny.",
    "",
    "## allow",
    list(sets.allow),
    "",
    "## soft_deny (needs explicit user intent naming action and target)",
    list(sets.soft_deny),
    "",
    "## hard_deny (never allow)",
    list(sets.hard_deny),
    "",
    "## environment",
    list(sets.environment),
  ].join("\n");
}

/** เรียก model ปัจจุบันตัดสิน ASK; allow = ทำต่อ, อื่น ๆ (ask/error/timeout/ไม่มี model) = ถาม user พร้อมเหตุผลใน note */
export async function autoReview(v: Verdict, ctx: PiContext, what: string): Promise<{ allow: boolean; note: string }> {
  if (!autoMode) return { allow: false, note: "auto-review unavailable: config.json has no autoMode" };
  if (!ctx.model || !ctx.modelRegistry) return { allow: false, note: "auto-review unavailable: no session model" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REVIEW_TIMEOUT_MS);
  try {
    const request = lastUserRequest(ctx);
    const user = {
      role: "user",
      content: [{ type: "text", text: [`Current user request:\n${request || "(none)"}`, "", `Pending action: ${what}`, `Rule: ${v.ruleId}`, `Target: ${v.target ?? "-"}`, `Risk: ${v.reason}`, "", "Reply `allow` or `ask: <one-line reason>`."].join("\n") }],
      timestamp: Date.now(),
    };
    const res = await ctx.modelRegistry.complete(ctx.model, { systemPrompt: autoReviewPrompt(autoMode), messages: [user] }, { signal: ac.signal });
    const text = res.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ").trim();
    const first = text.match(/\b(allow|ask)\b/i);
    if (first?.[1].toLowerCase() === "allow") return { allow: true, note: "" };
    return { allow: false, note: `auto-review: ${text.slice(0, 200) || "(empty reply)"}` };
  } catch (e) {
    return { allow: false, note: `auto-review error: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveAsk(v: Verdict, ctx: PiContext, what: string): Promise<boolean> {
  const key = approvalKey(v);
  if (approvals.has(key)) return approvals.get(key) as boolean;
  // Claude Auto mode: ask rule = dialog เสมอ; ASK อื่นให้ classifier ตัดสินก่อน, ไม่ allow ค่อยถาม user
  let note = "";
  if (!USER_DECISION_RULES.has(v.ruleId)) {
    const r = await autoReview(v, ctx, what);
    if (r.allow) {
      approvals.set(key, true);
      ctx.ui.notify(`agents-adapter auto-review allowed [${v.ruleId}] ${v.target ?? ""}`.trim(), "info");
      return true;
    }
    note = `\n${r.note}`;
  }
  if (!ctx.hasUI) return false; // ไม่มี UI ให้ถาม = fail closed
  const ok = await ctx.ui.confirm(
    `agents-adapter: อนุมัติ ${v.ruleId}?`,
    `${what}\n\ntarget: ${v.target ?? "-"}\nrisk: ${v.reason}${note}\n\napproval ใช้ซ้ำได้ใน session นี้เฉพาะ target เดียวกัน`,
  );
  approvals.set(key, ok);
  return ok;
}

export function denyMessage(v: Verdict): string {
  return `agents-adapter DENY [${v.ruleId}]: ${v.reason}`;
}

export function blockedBashResult(message: string): BashResultLike {
  return { output: message, exitCode: 1, cancelled: false, truncated: false };
}

export function _resetApprovalsForTests(): void {
  approvals.clear();
}

/** ใช้ใน parity test: ฉีด context แทนการอ่าน config.json */
export function _setContextForTests(ctx: PolicyContext, sets: AutoModeSets | null = null): void {
  const { cwd: _cwd, ...rest } = ctx;
  cached = rest;
  autoMode = sets;
  approvals.clear();
}
