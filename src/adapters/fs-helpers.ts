import * as fs from "node:fs";
import type { FileChange } from "./types.ts";

export function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function change(path: string, before: string | null, after: string | null, validate?: (c: string) => void, mode?: number): FileChange {
  let kind: FileChange["kind"];
  if (before === null && after === null) kind = "unchanged";
  else if (before === null) kind = "create";
  else if (after === null) kind = "delete";
  else kind = before === after && !modeDrifted(path, mode) ? "unchanged" : "modify";
  const c: FileChange = { path, before, after, kind };
  if (validate) c.validate = validate;
  if (mode !== undefined) c.mode = mode;
  return c;
}

/** ไฟล์ executable (wrapper/hook) ที่เนื้อหาเท่าเดิมแต่ mode ถูกแก้ (เช่น chmod 644) ต้องนับเป็น modify ไม่งั้น apply ข้ามและ drift เงียบ */
function modeDrifted(p: string, mode?: number): boolean {
  if (mode === undefined) return false;
  try {
    return (fs.statSync(p).mode & 0o777) !== mode;
  } catch {
    return false;
  }
}

export function validateJson(content: string): void {
  JSON.parse(content);
}
