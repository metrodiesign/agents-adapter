import type { UserConfig } from "../core/policy-loader.ts";

/** ตรวจความหมายที่ JSON schema บอกไม่ได้ */
export function validateConfigSemantics(config: UserConfig): void {
  const problems: string[] = [];
  for (const root of config.development_roots) {
    if (root === "/" || root === "${HOME}" || root === "~") problems.push(`development_roots must not be the whole filesystem or home: ${root}`);
    if (!root.startsWith("/") && !root.startsWith("${HOME}") && !root.startsWith("~")) problems.push(`development_roots must be absolute or start with \${HOME}: ${root}`);
    if (/[\n\r"']/.test(root)) problems.push(`development_roots contains unsafe characters: ${root}`);
  }
  for (const b of config.protected_branches) {
    if (b.includes("..") || b.startsWith("-")) problems.push(`invalid protected branch name: ${b}`);
  }
  for (const p of [...(config.development_env_patterns ?? []), ...(config.production_env_patterns ?? [])]) {
    if (p.includes("/")) problems.push(`env patterns are basename patterns, no slash allowed: ${p}`);
  }
  const dev = new Set(config.development_env_patterns ?? []);
  for (const p of config.production_env_patterns ?? []) {
    if (dev.has(p)) problems.push(`pattern is both development and production: ${p}`);
  }
  if (problems.length > 0) throw new Error("user config semantic validation failed:\n  " + problems.join("\n  "));
}
