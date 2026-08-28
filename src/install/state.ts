import * as fs from "node:fs";
import * as path from "node:path";
import type { Environment } from "../config/loader.ts";
import { VERSION } from "../version.ts";

export interface InstallState {
  version: string;
  lastApply: string | null;
  lastBackup: string | null;
  managed: Record<string, unknown>;
  /** sha256 ของไฟล์ที่ apply ล่าสุด เพื่อตรวจ drift */
  hashes: Record<string, string>;
}

export function statePath(env: Environment): string {
  return path.join(env.stateDir, "state.json");
}

export function loadState(env: Environment): InstallState {
  try {
    return JSON.parse(fs.readFileSync(statePath(env), "utf8")) as InstallState;
  } catch {
    return { version: VERSION, lastApply: null, lastBackup: null, managed: {}, hashes: {} };
  }
}

export function saveState(env: Environment, state: InstallState): void {
  fs.mkdirSync(env.stateDir, { recursive: true, mode: 0o700 });
  const tmp = statePath(env) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, statePath(env));
}
