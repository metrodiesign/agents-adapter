import type { Environment } from "../../config/loader.ts";
import { loadMatrix } from "../../core/policy-loader.ts";
import type { Adapter, DetectedCapabilities, RuleCapability } from "../types.ts";
import { evaluateCodex } from "./evaluate.ts";
import { codexManagedState, renderCodex } from "./generate.ts";

export const codexAdapter: Adapter = {
  name: "codex",
  render: renderCodex,
  managedState: codexManagedState,
  evaluate: evaluateCodex,
  capabilities(_env: Environment, detected: DetectedCapabilities): Record<string, RuleCapability> {
    const out: Record<string, RuleCapability> = {};
    for (const rule of loadMatrix().rules) {
      if (rule.id === "PI_SHARE") {
        out[rule.id] = { level: "native", note: "Codex has no share command" };
      } else if (rule.decision === "DENY") {
        out[rule.id] = { level: "runtime", note: "PreToolUse hook (exit 2) + rules forbidden + sandbox deny paths" };
      } else if (rule.decision === "ASK") {
        out[rule.id] = { level: "native", note: "rules prompt + approvals reviewer policy; hook adds context" };
      } else {
        out[rule.id] = { level: "native" };
      }
    }
    if (!detected.python3) for (const k of Object.keys(out)) if (out[k].level === "runtime") out[k] = { level: "unsupported", note: "python3 missing: hooks cannot run" };
    if (detected.codexVersion === null) for (const k of Object.keys(out)) out[k] = { level: "unsupported", note: "codex CLI not installed" };
    return out;
  },
};
