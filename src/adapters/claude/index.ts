import type { Environment } from "../../config/loader.ts";
import { loadMatrix } from "../../core/policy-loader.ts";
import type { Adapter, DetectedCapabilities, RuleCapability } from "../types.ts";
import { evaluateClaude } from "./evaluate.ts";
import { claudeManagedState, renderClaude } from "./generate.ts";
import { claudePatterns } from "./rules.ts";

export const claudeAdapter: Adapter = {
  name: "claude",
  render: renderClaude,
  managedState: claudeManagedState,
  async evaluate(action, ctx, env) {
    return evaluateClaude(action, ctx, claudePatterns(env.config, ctx));
  },
  capabilities(_env: Environment, detected: DetectedCapabilities): Record<string, RuleCapability> {
    const out: Record<string, RuleCapability> = {};
    for (const rule of loadMatrix().rules) {
      if (rule.id === "PI_SHARE") {
        out[rule.id] = { level: "native", note: "Claude has no share command" };
        continue;
      }
      if (rule.id === "SECURITY_AGENT_PROVIDER") {
        out[rule.id] = { level: "runtime", note: "PreToolUse hook provider_guard.py on Agent|Task" };
        continue;
      }
      if (rule.id === "UNKNOWN_COMMAND" || rule.id === "SHELL_SUBSTITUTION") {
        out[rule.id] = { level: "native", note: "autoMode classifier decides; classifyAllShell=true" };
        continue;
      }
      out[rule.id] = { level: "native" };
    }
    if (detected.claudeVersion === null) for (const k of Object.keys(out)) out[k] = { level: "unsupported", note: "claude CLI not installed" };
    return out;
  },
};
