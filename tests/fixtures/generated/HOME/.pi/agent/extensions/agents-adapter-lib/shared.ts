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
export interface PiContext {
  ui: PiUi;
  hasUI: boolean;
  cwd: string;
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

let cached: Omit<PolicyContext, "cwd"> | null = null;

export function loadContext(cwd: string): PolicyContext {
  if (cached === null) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Omit<PolicyContext, "cwd">;
      cached = raw;
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
      };
    }
  }
  return { ...cached, cwd };
}

/** approval cache ต่อ session: key = rule + target (+ environment marker) */
const approvals = new Map<string, boolean>();

export function approvalKey(v: Verdict): string {
  const env = /prod/i.test(v.target ?? "") ? "production" : "development";
  return `${v.ruleId}|${v.target ?? ""}|${env}`;
}

export async function resolveAsk(v: Verdict, ctx: PiContext, what: string): Promise<boolean> {
  const key = approvalKey(v);
  if (approvals.has(key)) return approvals.get(key) as boolean;
  if (!ctx.hasUI) return false; // ไม่มี UI ให้ถาม = fail closed
  const ok = await ctx.ui.confirm(
    `agents-adapter: อนุมัติ ${v.ruleId}?`,
    `${what}\n\ntarget: ${v.target ?? "-"}\nrisk: ${v.reason}\n\napproval ใช้ซ้ำได้ใน session นี้เฉพาะ target เดียวกัน`,
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
export function _setContextForTests(ctx: PolicyContext): void {
  const { cwd: _cwd, ...rest } = ctx;
  cached = rest;
  approvals.clear();
}
