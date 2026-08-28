import * as fs from "node:fs";
import type { Environment } from "../config/loader.ts";
import { plan } from "../install/apply.ts";
import { sha256 } from "../install/backup.ts";
import { loadState } from "../install/state.ts";

export interface DriftReport {
  policyDrift: string[];
  hashDrift: string[];
  notInstalled: boolean;
}

/** policy drift = render ใหม่แล้วต่างจากไฟล์จริง; hash drift = ไฟล์ถูกแก้หลัง apply */
export function driftReport(env: Environment, target: string): DriftReport {
  const state = loadState(env);
  const p = plan(env, target);
  const policyDrift = p.changed.map((c) => `${c.kind}: ${c.path.replace(env.home, "~")}`);
  const hashDrift: string[] = [];
  for (const [file, hash] of Object.entries(state.hashes)) {
    if (!fs.existsSync(file)) {
      hashDrift.push(`missing: ${file.replace(env.home, "~")}`);
      continue;
    }
    if (sha256(fs.readFileSync(file, "utf8")) !== hash) hashDrift.push(`modified since apply: ${file.replace(env.home, "~")}`);
  }
  return { policyDrift, hashDrift, notInstalled: state.lastApply === null };
}
