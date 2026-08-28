/**
 * Managed-merge helpers: agents-adapter เป็นเจ้าของเฉพาะ key/entry/block ที่มันสร้าง
 * ค่าอื่นของ user (รวม unknown key) ต้อง preserve เสมอ
 */

export const BLOCK_START = "<!-- agents-adapter:start -->";
export const BLOCK_END = "<!-- agents-adapter:end -->";
export const HASH_START = "# agents-adapter:start";
export const HASH_END = "# agents-adapter:end";

/** แทนที่หรือเพิ่ม managed block ในไฟล์ข้อความ; รันซ้ำไม่สร้าง block ซ้ำ */
export function upsertBlock(existing: string | null, body: string, markers: { start: string; end: string } = { start: BLOCK_START, end: BLOCK_END }): string {
  const cleanBody = body.replace(/\s+$/, "");
  const block = `${markers.start}\n${cleanBody}\n${markers.end}`;
  if (existing === null || existing.trim() === "") return block + "\n";
  const start = existing.indexOf(markers.start);
  const end = existing.indexOf(markers.end);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + markers.end.length);
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block + "\n";
}

/** ลบ managed block ออก (uninstall) */
export function removeBlock(existing: string | null, markers: { start: string; end: string } = { start: BLOCK_START, end: BLOCK_END }): string | null {
  if (existing === null) return null;
  const start = existing.indexOf(markers.start);
  const end = existing.indexOf(markers.end);
  if (start === -1 || end === -1) return existing;
  const out = (existing.slice(0, start) + existing.slice(end + markers.end.length)).replace(/\n{3,}/g, "\n\n");
  return out.trim() === "" ? "" : out;
}

/** ตัดข้อความที่จะทำให้ marker พัง (template injection ผ่าน user config) */
export function sanitizeForBlock(value: string): string {
  return value.replace(/<!--/g, "<!- -").replace(/-->/g, "- ->").replace(/\r/g, "");
}

/**
 * รวม list ที่ user เป็นเจ้าของบางส่วน:
 * - entry ที่อยู่ใน previousManaged แต่ไม่อยู่ใน nextManaged ถูกลบ (stale)
 * - entry ของ user ที่เหลือ preserve ตามลำดับเดิม
 * - nextManaged ต่อท้าย (ไม่ซ้ำ)
 */
export function mergeManagedList<T>(current: T[] | undefined, previousManaged: T[], nextManaged: T[], key: (t: T) => string = (t) => JSON.stringify(t)): T[] {
  const prev = new Set(previousManaged.map(key));
  const next = new Map(nextManaged.map((t) => [key(t), t] as const));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of current ?? []) {
    const k = key(item);
    if (seen.has(k)) continue;
    if (prev.has(k) && !next.has(k)) continue; // stale managed entry
    seen.add(k);
    out.push(item); // entry ที่มีอยู่แล้ว (ของ user หรือ managed) คงตำแหน่งเดิม
  }
  for (const [k, item] of next) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/** ลบ managed entries ออกจาก list (uninstall) */
export function stripManagedList<T>(current: T[] | undefined, managed: T[], key: (t: T) => string = (t) => JSON.stringify(t)): T[] {
  const m = new Set(managed.map(key));
  return (current ?? []).filter((t) => !m.has(key(t)));
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function isObject(v: unknown): v is Record<string, Json> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** ตั้งค่า nested key โดยไม่ทำลาย sibling */
export function setPath(obj: Record<string, Json>, path: string[], value: Json): void {
  let cur: Record<string, Json> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!isObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, Json>;
  }
  cur[path[path.length - 1]] = value;
}

export function getPath(obj: Record<string, Json>, path: string[]): Json | undefined {
  let cur: Json | undefined = obj;
  for (const k of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function deletePath(obj: Record<string, Json>, path: string[]): void {
  const parent = getPath(obj, path.slice(0, -1));
  if (isObject(parent)) delete parent[path[path.length - 1]];
}

/** template แบบ {{key}} เท่านั้น; ค่า string ถูก sanitize กัน marker injection */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`template variable missing: ${name}`);
    return sanitizeForBlock(vars[name]);
  });
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
