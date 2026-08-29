import type { Environment } from "../config/loader.ts";
import type { PolicyContext } from "../core/context.ts";
import type { Verdict } from "../core/decisions.ts";

export type TargetName = "claude" | "codex" | "pi";

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  kind: "create" | "modify" | "delete" | "unchanged";
  /** validator ที่ apply เรียกก่อน rename (parse JSON/TOML) */
  validate?: (content: string) => void;
  mode?: number;
}

export interface AdapterPlan {
  target: TargetName;
  changes: FileChange[];
  managedKeys: string[];
  preserved: string[];
  conflicts: string[];
  unsupported: string[];
  notes: string[];
}

/** action fixture ที่ parity harness ป้อนให้ทุก adapter */
export type Action =
  | { kind: "command"; command: string }
  | { kind: "tool"; tool: { name: string; input: Record<string, unknown> } }
  | { kind: "user_input"; text: string }
  | { kind: "pi_bash"; command: string; excludeFromContext?: boolean };

export type EnforcementLevel = "native" | "runtime" | "isolation" | "best-effort" | "unsupported";

export interface RuleCapability {
  level: EnforcementLevel;
  fallback?: "isolation";
  note?: string;
}

export interface RenderMode {
  mode: "apply" | "remove";
  /** managed entries จาก apply ครั้งก่อน (จาก state) */
  previousManaged: Record<string, unknown>;
}

export interface Adapter {
  name: TargetName;
  render(env: Environment, mode: RenderMode): AdapterPlan;
  /** managed entries ที่ state ต้องจำไว้ */
  managedState(env: Environment): Record<string, unknown>;
  evaluate(action: Action, ctx: PolicyContext, env: Environment): Promise<Verdict>;
  capabilities(env: Environment, detected: DetectedCapabilities): Record<string, RuleCapability>;
}

export interface DetectedCapabilities {
  claudeVersion: string | null;
  codexVersion: string | null;
  piVersion: string | null;
  docker: boolean;
  gondolin: boolean;
  openshell: boolean;
  python3: boolean;
  ghAuthenticated: boolean | null;
  /** doctor ถูกรันจากใน Bash sandbox ของ agent ไหน (probe ที่ต้องใช้ socket/credential จะล้มเหลวโดยไม่ใช่ปัญหาเครื่อง) */
  agentSandbox: "claude" | "codex" | null;
}
