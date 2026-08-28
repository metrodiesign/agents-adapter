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
  else kind = before === after ? "unchanged" : "modify";
  const c: FileChange = { path, before, after, kind };
  if (validate) c.validate = validate;
  if (mode !== undefined) c.mode = mode;
  return c;
}

export function validateJson(content: string): void {
  JSON.parse(content);
}
