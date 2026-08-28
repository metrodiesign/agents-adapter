import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Environment } from "../config/loader.ts";
import type { FileChange } from "../adapters/types.ts";

export interface BackupManifest {
  timestamp: string;
  files: Array<{ path: string; backup: string | null; existed: boolean; sha256: string | null }>;
}

export function backupsDir(env: Environment): string {
  return path.join(env.stateDir, "backups");
}

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function timestampId(env: Environment): string {
  return env.deterministic ? "19700101T000000Z" : new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** backup ทุกไฟล์ที่จะถูกแก้ (รวมไฟล์ที่ยังไม่มี เพื่อให้ rollback ลบได้) */
export function createBackup(env: Environment, changes: FileChange[]): BackupManifest {
  const id = timestampId(env);
  const dir = path.join(backupsDir(env), id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifest: BackupManifest = { timestamp: id, files: [] };
  for (const c of changes) {
    if (c.kind === "unchanged") continue;
    const rel = c.path.replace(env.home, "HOME");
    if (c.before === null) {
      manifest.files.push({ path: c.path, backup: null, existed: false, sha256: null });
      continue;
    }
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, c.before, { mode: 0o600 });
    manifest.files.push({ path: c.path, backup: target, existed: true, sha256: sha256(c.before) });
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return manifest;
}

export function listBackups(env: Environment): string[] {
  try {
    return fs
      .readdirSync(backupsDir(env))
      .filter((d) => fs.existsSync(path.join(backupsDir(env), d, "manifest.json")))
      .sort();
  } catch {
    return [];
  }
}

export function loadManifest(env: Environment, id: string): BackupManifest {
  return JSON.parse(fs.readFileSync(path.join(backupsDir(env), id, "manifest.json"), "utf8")) as BackupManifest;
}
