/**
 * Parity harness: รัน action fixture เดียวกันผ่านทุก adapter แล้วเทียบผล
 * fail เมื่อ adapter ใดต่างจาก expected หรือ adapter ต่างกันเอง
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ADAPTERS } from "../adapters/index.ts";
import type { Action, TargetName } from "../adapters/types.ts";
import type { Environment } from "../config/loader.ts";
import { buildContext, REPO_ROOT } from "../core/policy-loader.ts";
import type { Decision } from "../core/decisions.ts";

export interface FixtureCase {
  id: string;
  name: string;
  kind: Action["kind"];
  command?: string;
  tool?: { name: string; input: Record<string, unknown> };
  text?: string;
  excludeFromContext?: boolean;
  expected: Decision;
  rule?: string;
  ruleAny?: string[];
  cwd?: string;
}

export interface ParityFailure {
  name: string;
  id: string;
  expected: Decision;
  results: Record<string, { decision: Decision; ruleId: string; reason: string }>;
  problem: string;
}

export interface ParityResult {
  total: number;
  failures: ParityFailure[];
  byDecision: Record<Decision, number>;
  perAdapter: Record<TargetName, { agree: number; disagree: number }>;
}

export function loadFixtures(): FixtureCase[] {
  return (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "actions.json"), "utf8")) as { cases: FixtureCase[] }).cases;
}

export interface FixtureWorld {
  home: string;
  zone: string;
  cwd: string;
  cleanup: () => void;
}

/** สร้าง home จำลองพร้อม symlink escape สำหรับ fixture */
export function makeFixtureWorld(): FixtureWorld {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agents-adapter-home-"));
  const zone = path.join(home, "Desktop", "Project");
  const cwd = path.join(zone, "app");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "apps", "api"), { recursive: true });
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "config"), "");
  fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
  fs.symlinkSync(path.join(home, ".ssh"), path.join(cwd, "link-to-ssh"));
  return {
    home,
    zone,
    cwd,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

export function substitute(value: string, world: FixtureWorld): string {
  return value.replace(/\{HOME\}/g, world.home).replace(/\{ZONE\}/g, world.zone).replace(/\{CWD\}/g, world.cwd);
}

export function toAction(c: FixtureCase, world: FixtureWorld): Action {
  switch (c.kind) {
    case "command":
      return { kind: "command", command: substitute(c.command ?? "", world) };
    case "pi_bash":
      return { kind: "pi_bash", command: substitute(c.command ?? "", world), excludeFromContext: c.excludeFromContext ?? false };
    case "user_input":
      return { kind: "user_input", text: c.text ?? "" };
    case "tool": {
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c.tool?.input ?? {})) input[k] = typeof v === "string" ? substitute(v, world) : v;
      return { kind: "tool", tool: { name: c.tool?.name ?? "", input } };
    }
  }
}

const PI_ONLY: Array<Action["kind"]> = ["pi_bash", "user_input"];

export async function runParity(env: Environment, opts: { world?: FixtureWorld; adapters?: TargetName[] } = {}): Promise<ParityResult> {
  const world = opts.world ?? makeFixtureWorld();
  const fixtures = loadFixtures();
  const targets = opts.adapters ?? (Object.keys(ADAPTERS) as TargetName[]);
  const ctx = buildContext({ ...env.config, development_roots: [world.zone] }, { home: world.home, tmpdir: path.join(world.home, "tmp"), cwd: world.cwd });
  // fixture home อยู่ใต้ system tmp; ตัด /tmp ออกจาก always_writable ไม่งั้นทุก path กลายเป็น trusted
  ctx.alwaysWritable = [ctx.tmpdir];
  const failures: ParityFailure[] = [];
  const byDecision: Record<Decision, number> = { ALLOW: 0, ASK: 0, DENY: 0 };
  const perAdapter = Object.fromEntries(targets.map((t) => [t, { agree: 0, disagree: 0 }])) as Record<TargetName, { agree: number; disagree: number }>;
  try {
    for (const c of fixtures) {
      const action = toAction(c, world);
      byDecision[c.expected]++;
      const results: ParityFailure["results"] = {};
      const problems: string[] = [];
      const applicable = PI_ONLY.includes(c.kind) ? targets.filter((t) => t === "pi") : targets;
      for (const t of applicable) {
        const v = await ADAPTERS[t].evaluate(action, ctx, env);
        results[t] = { decision: v.decision, ruleId: v.ruleId, reason: v.reason };
        const ruleOk = c.ruleAny ? c.ruleAny.includes(v.ruleId) : v.ruleId === (c.rule ?? c.id);
        if (v.decision !== c.expected) problems.push(`${t}: ${v.decision} != ${c.expected}`);
        else if (!ruleOk) problems.push(`${t}: rule ${v.ruleId} != ${c.rule ?? c.id}`);
      }
      const decisions = new Set(Object.values(results).map((r) => r.decision));
      if (decisions.size > 1) problems.push(`adapters disagree: ${JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.decision])))}`);
      for (const t of applicable) {
        if (problems.some((p) => p.startsWith(t + ":")) || decisions.size > 1) perAdapter[t].disagree++;
        else perAdapter[t].agree++;
      }
      if (problems.length > 0) failures.push({ name: c.name, id: c.id, expected: c.expected, results, problem: problems.join("; ") });
    }
  } finally {
    if (!opts.world) world.cleanup();
  }
  return { total: fixtures.length, failures, byDecision, perAdapter };
}

export function formatParity(r: ParityResult): string {
  const lines = [`parity: ${r.total - r.failures.length}/${r.total} cases agree (ALLOW ${r.byDecision.ALLOW}, ASK ${r.byDecision.ASK}, DENY ${r.byDecision.DENY})`];
  for (const [t, s] of Object.entries(r.perAdapter)) lines.push(`  ${t}: agree ${s.agree}, disagree ${s.disagree}`);
  for (const f of r.failures) lines.push(`  FAIL ${f.id} (${f.name}): ${f.problem}`);
  return lines.join("\n");
}
