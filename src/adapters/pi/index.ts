import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { Environment } from "../../config/loader.ts";
import { loadMatrix } from "../../core/policy-loader.ts";
import type { Adapter, DetectedCapabilities, RuleCapability } from "../types.ts";
import { evaluatePi } from "./evaluate.ts";
import { piManagedState, renderPi } from "./generate.ts";

interface IsolationProfile {
  profile: string;
  limitations?: Array<{ rule: string; status: string; fallback?: string; note?: string }>;
  hard_boundaries_enforced_by_isolation?: string[];
}

export function loadIsolationProfile(repoRoot: string, mode: string): IsolationProfile {
  return YAML.parse(fs.readFileSync(path.join(repoRoot, "runtime", "pi", "isolation", `${mode}.yaml`), "utf8")) as IsolationProfile;
}

export const piAdapter: Adapter = {
  name: "pi",
  render: renderPi,
  managedState: piManagedState,
  async evaluate(action, ctx) {
    return evaluatePi(action, ctx);
  },
  capabilities(env: Environment, detected: DetectedCapabilities): Record<string, RuleCapability> {
    const mode = env.config.pi?.isolation_mode ?? "host-macos";
    const profile = loadIsolationProfile(env.repoRoot, mode);
    const isolationAvailable = mode === "docker" ? detected.docker : mode === "gondolin" ? detected.gondolin : mode === "openshell" ? detected.openshell : false;
    const anyIsolation = detected.docker || detected.gondolin || detected.openshell;
    const out: Record<string, RuleCapability> = {};
    for (const rule of loadMatrix().rules) {
      const limitation = profile.limitations?.find((l) => l.rule === rule.id);
      if (limitation && limitation.status === "best-effort") {
        out[rule.id] = anyIsolation
          ? { level: "best-effort", fallback: "isolation", note: `${limitation.note ?? "extension only on host"}; fallback: scripts/pi-isolated.sh ${detected.docker ? "docker" : detected.gondolin ? "gondolin" : "openshell"}` }
          : { level: "unsupported", note: "host mode cannot enforce robustly and no isolation runtime detected" };
        continue;
      }
      if (profile.hard_boundaries_enforced_by_isolation?.includes(rule.id)) {
        out[rule.id] = isolationAvailable ? { level: "isolation" } : { level: "unsupported", note: `${mode} runtime not detected` };
        continue;
      }
      out[rule.id] = rule.decision === "ALLOW" ? { level: "native" } : { level: "runtime", note: "extension (tool_call/user_bash/input)" };
    }
    if (detected.piVersion === null) for (const k of Object.keys(out)) out[k] = { level: "unsupported", note: "pi CLI not installed" };
    return out;
  },
};
