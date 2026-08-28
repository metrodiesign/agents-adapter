import * as fs from "node:fs";
import * as path from "node:path";
export { loadCorePolicy, loadMatrix, loadProvenance, REPO_ROOT } from "../../src/core/policy-loader.ts";
import { REPO_ROOT } from "../../src/core/policy-loader.ts";

export function loadFixturesIds(): Set<string> {
  const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "actions.json"), "utf8")) as { cases: Array<{ id: string; rule?: string; ruleAny?: string[] }> };
  const used = new Set<string>();
  for (const c of data.cases) {
    used.add(c.id);
    if (c.rule) used.add(c.rule);
    for (const r of c.ruleAny ?? []) used.add(r);
  }
  return used;
}
