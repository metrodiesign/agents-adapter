import * as fs from "node:fs";
import * as path from "node:path";
import { selectAdapters } from "../adapters/index.ts";
import type { AdapterPlan, FileChange } from "../adapters/types.ts";
import type { Environment } from "../config/loader.ts";
import { createBackup, sha256 } from "./backup.ts";
import { loadState, saveState } from "./state.ts";

export interface PlanResult {
  plans: AdapterPlan[];
  changed: FileChange[];
  backupDestination: string;
}

export function plan(env: Environment, target: string, mode: "apply" | "remove" = "apply"): PlanResult {
  const state = loadState(env);
  const plans = selectAdapters(target)
    .filter((a) => mode === "remove" || env.config.adapters?.[a.name] !== false)
    .map((a) => a.render(env, { mode, previousManaged: state.managed }));
  const changed = plans.flatMap((p) => p.changes).filter((c) => c.kind !== "unchanged");
  return { plans, changed, backupDestination: path.join(env.stateDir, "backups", "<timestamp>") };
}

/** เขียนแบบ atomic: temp ในโฟลเดอร์เดียวกัน -> validate -> fsync -> rename */
export function atomicWrite(file: string, content: string, validate?: (c: string) => void, mode?: number): void {
  if (validate) validate(content);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.agents-adapter-tmp`);
  const fd = fs.openSync(tmp, "w", mode ?? 0o644);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (validate) validate(fs.readFileSync(tmp, "utf8"));
  fs.renameSync(tmp, file);
}

export interface ApplyResult extends PlanResult {
  applied: number;
  backupId: string | null;
}

export function apply(env: Environment, target: string, mode: "apply" | "remove" = "apply"): ApplyResult {
  const result = plan(env, target, mode);
  if (result.changed.length === 0) return { ...result, applied: 0, backupId: null };

  // validate ทุกไฟล์ก่อนแตะ disk: ถ้า validation ไม่ผ่านห้ามแทนที่ไฟล์จริง
  for (const c of result.changed) {
    if (c.after !== null && c.validate) c.validate(c.after);
  }
  const manifest = createBackup(env, result.changed);
  const state = loadState(env);
  for (const c of result.changed) {
    if (c.after === null) {
      if (fs.existsSync(c.path)) fs.unlinkSync(c.path);
      delete state.hashes[c.path];
      continue;
    }
    atomicWrite(c.path, c.after, c.validate, c.mode);
    state.hashes[c.path] = sha256(c.after);
  }
  for (const p of result.plans) {
    const adapter = selectAdapters(p.target)[0];
    const managed = adapter.managedState(env);
    if (mode === "remove") for (const k of Object.keys(managed)) delete state.managed[k];
    else Object.assign(state.managed, managed);
  }
  state.lastApply = manifest.timestamp;
  state.lastBackup = manifest.timestamp;
  saveState(env, state);
  return { ...result, applied: result.changed.length, backupId: manifest.timestamp };
}
