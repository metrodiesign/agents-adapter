import * as fs from "node:fs";
import * as path from "node:path";
import type { PolicyContext } from "./context.ts";
import { type Verdict, verdict } from "./decisions.ts";

export type PathOp = "read" | "write" | "delete";

const SYSTEM_READ_ONLY_PREFIXES = ["/usr", "/opt", "/bin", "/sbin", "/Library", "/System", "/etc", "/dev", "/proc"];

/** ขยาย ~, ${HOME}, $HOME, ${TMPDIR}, $TMPDIR, $PWD */
export function expandPath(raw: string, ctx: PolicyContext): string {
  let p = raw.trim();
  if (p.startsWith("~/") || p === "~") p = ctx.home + p.slice(1);
  p = p.replace(/\$\{HOME\}|\$HOME\b/g, ctx.home);
  p = p.replace(/\$\{TMPDIR\}|\$TMPDIR\b/g, ctx.tmpdir);
  p = p.replace(/\$\{PWD\}|\$PWD\b/g, ctx.cwd);
  if (!path.isAbsolute(p)) p = path.join(ctx.cwd, p);
  return path.normalize(p);
}

/** realpath ของ ancestor ที่มีอยู่จริง เพื่อจับ symlink escape แม้ไฟล์ปลายทางยังไม่ถูกสร้าง */
export function resolveReal(absPath: string, ctx: PolicyContext): string {
  const real = ctx.realpath ?? defaultRealpath;
  let current = absPath;
  const tail: string[] = [];
  while (true) {
    try {
      const resolved = real(current);
      return tail.length === 0 ? resolved : path.join(resolved, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absPath;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function defaultRealpath(p: string): string {
  return fs.realpathSync(p);
}

export function isUnder(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** glob แบบ basename: รองรับ * เท่านั้น */
export function basenameMatches(basename: string, patterns: string[]): boolean {
  return patterns.some((pat) => {
    const re = new RegExp("^" + pat.split("*").map(escapeRegex).join(".*") + "$");
    return re.test(basename);
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface PathClass {
  kind: "credential" | "prod_env" | "dev_env" | "system_config" | "trusted" | "system_read" | "outside";
  resolved: string;
}

export function classifyPathKind(raw: string, ctx: PolicyContext): PathClass {
  const expanded = expandPath(raw, ctx);
  const resolved = resolveReal(expanded, ctx);
  const base = path.basename(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const candidates = [expanded, resolved];

  const credentialRoots = ctx.credentialPaths.map((p) => resolveReal(expandPath(p, ctx), ctx));
  if (
    candidates.some((c) => credentialRoots.some((root) => isUnder(c, root))) ||
    ctx.credentialBasenames.includes(base) ||
    ctx.credentialExtensions.includes(ext)
  ) {
    return { kind: "credential", resolved };
  }
  if (basenameMatches(base, ctx.prodEnvPatterns)) return { kind: "prod_env", resolved };

  const trustedRoots = [...ctx.developmentRoots, ctx.cwd, ...ctx.alwaysWritable, ...ctx.agentConfigDirs]
    .map((p) => expandPath(p, ctx))
    .map((p) => resolveReal(p, ctx));
  const inZone = candidates.some((c) => trustedRoots.some((root) => isUnder(c, root)));

  const systemRoots = ctx.systemConfigPaths.map((p) => resolveReal(expandPath(p, ctx), ctx));
  if (candidates.some((c) => systemRoots.some((root) => isUnder(c, root)))) return { kind: "system_config", resolved };

  if (basenameMatches(base, ctx.devEnvPatterns)) {
    return { kind: inZone ? "dev_env" : "outside", resolved };
  }
  if (inZone) return { kind: "trusted", resolved };
  if (SYSTEM_READ_ONLY_PREFIXES.some((p) => isUnder(resolved, p))) return { kind: "system_read", resolved };
  return { kind: "outside", resolved };
}

export function classifyPath(op: PathOp, raw: string, ctx: PolicyContext): Verdict {
  const { kind, resolved } = classifyPathKind(raw, ctx);
  const write = op !== "read";
  switch (kind) {
    case "credential":
      return verdict("DENY", write ? "CREDENTIAL_WRITE" : "CREDENTIAL_READ", `credential path: ${resolved}`, resolved);
    case "prod_env":
      return verdict("DENY", write ? "PROD_ENV_WRITE" : "PROD_ENV_READ", `production env: ${resolved}`, resolved);
    case "dev_env":
      return verdict("ALLOW", write ? "DEV_ENV_WRITE" : "DEV_ENV_READ", `development env: ${resolved}`, resolved);
    case "system_config":
      return write
        ? verdict("ASK", "SYSTEM_CONFIG_CHANGE", `system configuration: ${resolved}`, resolved)
        : verdict("ALLOW", "FS_READ_SOURCE", `read system configuration: ${resolved}`, resolved);
    case "trusted":
      return write
        ? verdict("ALLOW", op === "delete" ? "FS_WRITE_SOURCE" : "FS_WRITE_SOURCE", `trusted: ${resolved}`, resolved)
        : verdict("ALLOW", "FS_READ_SOURCE", `trusted: ${resolved}`, resolved);
    case "system_read":
      return write
        ? verdict("ASK", "OUTSIDE_TRUST_ZONE", `system path write: ${resolved}`, resolved)
        : verdict("ALLOW", "FS_READ_SOURCE", `system path read: ${resolved}`, resolved);
    case "outside":
      return verdict("ASK", "OUTSIDE_TRUST_ZONE", `outside Development Trust Zone: ${resolved}`, resolved);
  }
}

/** word ใน shell ที่น่าจะเป็น path */
export function looksLikePath(word: string, ctx: PolicyContext): boolean {
  if (word.startsWith("-")) return false;
  if (word.includes("://")) return false;
  if (word.startsWith("/") || word.startsWith("~") || word.startsWith("./") || word.startsWith("../") || word.startsWith("$HOME") || word.startsWith("${HOME}")) return true;
  if (word.includes("/")) return true;
  const base = path.basename(word);
  if (basenameMatches(base, ctx.devEnvPatterns) || basenameMatches(base, ctx.prodEnvPatterns)) return true;
  if (ctx.credentialBasenames.includes(base)) return true;
  if (ctx.credentialExtensions.includes(path.extname(base).toLowerCase())) return true;
  return false;
}
