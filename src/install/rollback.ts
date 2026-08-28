import * as fs from "node:fs";
import type { Environment } from "../config/loader.ts";
import { atomicWrite } from "./apply.ts";
import { listBackups, loadManifest, sha256 } from "./backup.ts";
import { loadState, saveState } from "./state.ts";

export interface RollbackResult {
  backupId: string;
  restored: string[];
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * คืนทุกไฟล์จาก backup เดียวกัน; ตรวจ backup ครบก่อนเริ่มเขียน (transaction แบบ best-effort)
 * ถ้าคืนบางไฟล์ไม่ได้ รายงานชัดเจนและไม่ลบ backup
 */
export function rollback(env: Environment, backupId?: string): RollbackResult {
  const ids = listBackups(env);
  const id = backupId ?? ids[ids.length - 1];
  if (!id) throw new Error("no backup found");
  const manifest = loadManifest(env, id);
  for (const f of manifest.files) {
    if (f.existed) {
      if (f.backup === null || !fs.existsSync(f.backup)) throw new Error(`backup file missing for ${f.path}; rollback aborted before any change`);
      const content = fs.readFileSync(f.backup, "utf8");
      if (f.sha256 !== null && sha256(content) !== f.sha256) throw new Error(`backup checksum mismatch for ${f.path}; rollback aborted`);
    }
  }
  const result: RollbackResult = { backupId: id, restored: [], removed: [], failed: [] };
  const state = loadState(env);
  for (const f of manifest.files) {
    try {
      if (f.existed && f.backup) {
        const content = fs.readFileSync(f.backup, "utf8");
        atomicWrite(f.path, content);
        state.hashes[f.path] = sha256(content);
        result.restored.push(f.path);
      } else {
        if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        delete state.hashes[f.path];
        result.removed.push(f.path);
      }
    } catch (err) {
      result.failed.push({ path: f.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (result.failed.length === 0) {
    state.lastApply = null;
    state.managed = {};
  }
  saveState(env, state);
  return result;
}
