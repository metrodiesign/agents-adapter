import * as fs from "node:fs";
import type { Environment } from "../config/loader.ts";
import { plan } from "../install/apply.ts";
import { sha256 } from "../install/backup.ts";
import { loadState } from "../install/state.ts";

export interface DriftReport {
  policyDrift: string[];
  hashDrift: string[];
  /** ไฟล์ merge (settings.json, hooks.json, config.toml) ที่ถูกแก้หลัง apply แต่ render ใหม่แล้วเท่าเดิม = แก้นอก managed keys ไม่ใช่ drift */
  foreignEdit: string[];
  notInstalled: boolean;
}

/** policy drift = render ใหม่แล้วต่างจากไฟล์จริง; hash drift = ไฟล์ถูกแก้หลัง apply */
export function driftReport(env: Environment, target: string): DriftReport {
  const state = loadState(env);
  const p = plan(env, target);
  const policyDrift = p.changed.map((c) => `${c.kind}: ${c.path.replace(env.home, "~")}`);
  const hashDrift: string[] = [];
  const foreignEdit: string[] = [];
  // เทียบเฉพาะไฟล์ที่ target นี้ render ไม่งั้น drift ของ Claude โผล่ใต้ codex/pi ด้วย
  const changes = new Map(p.plans.flatMap((a) => a.changes.map((c) => [c.path, c.kind] as const)));
  for (const [file, hash] of Object.entries(state.hashes)) {
    const kind = changes.get(file);
    if (kind === undefined) continue;
    if (!fs.existsSync(file)) {
      hashDrift.push(`missing: ${file.replace(env.home, "~")}`);
      continue;
    }
    if (sha256(fs.readFileSync(file, "utf8")) === hash) continue;
    // Codex/Claude เขียน key ของตัวเอง (trusted_hash, ui state) ลงไฟล์เดียวกัน: ถ้า render ใหม่ยังเท่าไฟล์จริง managed ส่วนของเราไม่ได้ถูกแตะ
    (kind === "unchanged" ? foreignEdit : hashDrift).push(`modified since apply: ${file.replace(env.home, "~")}`);
  }
  return { policyDrift, hashDrift, foreignEdit, notInstalled: state.lastApply === null };
}
