#!/usr/bin/env node
/**
 * agents-adapter CLI
 *   init | plan | apply | diff | doctor | verify | rollback | uninstall | generate-check | migrate
 * options: --target claude|codex|pi|all (default all), --config <file>, --home <dir>, --backup <id>, --json, --check
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { selectAdapters } from "./adapters/index.ts";
import type { FileChange } from "./adapters/types.ts";
import { resolveEnvironment, writeInitialConfig, type Environment } from "./config/loader.ts";
import { defaultUserConfigPath } from "./core/policy-loader.ts";
import { detectCapabilities } from "./doctor/capabilities.ts";
import { exitCodeFor, formatChecks, runDoctor } from "./doctor/report.ts";
import { apply, plan } from "./install/apply.ts";
import { listBackups } from "./install/backup.ts";
import { rollback } from "./install/rollback.ts";
import { formatParity, runParity } from "./parity/harness.ts";
import { VERSION } from "./version.ts";

interface Args {
  command: string;
  target: string;
  config?: string;
  home?: string;
  backup?: string;
  json: boolean;
  check: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "help", target: "all", json: false, check: false, yes: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") args.target = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--home") args.home = argv[++i];
    else if (a === "--backup") args.backup = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--check") args.check = true;
    else if (a === "--yes") args.yes = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return args;
}

function env(args: Args, useExample = false): Environment {
  const opts: Parameters<typeof resolveEnvironment>[0] = { useExampleIfMissing: useExample };
  if (args.home) opts.home = args.home;
  if (args.config) opts.configPath = args.config;
  return resolveEnvironment(opts);
}

function tilde(p: string, home: string): string {
  return p.replace(home, "~");
}

function unifiedDiff(c: FileChange, home: string): string {
  const before = (c.before ?? "").split("\n");
  const after = (c.after ?? "").split("\n");
  const out = [`--- ${tilde(c.path, home)} (${c.kind})`, `+++ ${tilde(c.path, home)}`];
  // diff แบบง่าย: บรรทัดที่หายไป/เพิ่มมา (พอสำหรับ review config)
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  for (const l of before) if (!afterSet.has(l)) out.push(`- ${l}`);
  for (const l of after) if (!beforeSet.has(l)) out.push(`+ ${l}`);
  return out.join("\n");
}

function printPlan(e: Environment, target: string, mode: "apply" | "remove", json: boolean, withDiff: boolean): number {
  const result = plan(e, target, mode);
  if (json) {
    console.log(JSON.stringify({ plans: result.plans.map((p) => ({ ...p, changes: p.changes.map((c) => ({ path: c.path, kind: c.kind })) })), backupDestination: result.backupDestination }, null, 2));
    return 0;
  }
  for (const p of result.plans) {
    console.log(`\n== ${p.target} ==`);
    for (const c of p.changes) console.log(`  ${c.kind.padEnd(9)} ${tilde(c.path, e.home)}`);
    if (p.managedKeys.length) console.log(`  managed keys: ${p.managedKeys.join(", ")}`);
    if (p.preserved.length) console.log(`  preserved: ${p.preserved.join(", ")}`);
    for (const x of p.conflicts) console.log(`  conflict: ${x}`);
    for (const x of p.unsupported) console.log(`  unsupported: ${x}`);
    for (const x of p.notes) console.log(`  note: ${x}`);
  }
  console.log(`\nbackup destination: ${tilde(result.backupDestination, e.home)}`);
  if (withDiff) for (const c of result.changed) console.log("\n" + unifiedDiff(c, e.home));
  if (result.changed.length === 0) console.log("no changes");
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      console.log(`agents-adapter ${VERSION}\n\nusage: agents-adapter <init|plan|apply|diff|doctor|verify|rollback|uninstall|migrate|generate-check> [--target claude|codex|pi|all] [--config file] [--home dir] [--backup id] [--json]`);
      return 0;
    case "version":
    case "--version":
      console.log(VERSION);
      return 0;
    case "init": {
      const home = args.home ?? process.env.AGENTS_ADAPTER_HOME ?? (process.env.HOME as string);
      const cfg = args.config ?? defaultUserConfigPath(home);
      const created = writeInitialConfig(cfg, home);
      console.log(created ? `created ${cfg}` : `config already exists: ${cfg}`);
      console.log("edit development_roots, protected_branches and github.owner, then run: agents-adapter plan");
      return 0;
    }
    case "plan":
      return printPlan(env(args), args.target, "apply", args.json, false);
    case "diff":
      return printPlan(env(args), args.target, "apply", false, true);
    case "migrate": {
      const e = env(args);
      const result = plan(e, args.target, "apply");
      console.log("migration report (existing configuration classified)\n");
      for (const p of result.plans) {
        console.log(`== ${p.target} ==`);
        console.log(`  managed:     ${p.managedKeys.join(", ") || "-"}`);
        console.log(`  preserved:   ${p.preserved.join(", ") || "-"}`);
        console.log(`  conflicting: ${p.conflicts.join(" | ") || "-"}`);
        console.log(`  unsafe:      ${p.conflicts.filter((c) => /danger|"\/"|gh/.test(c)).join(" | ") || "-"}`);
        console.log(`  unknown:     ${p.unsupported.join(" | ") || "-"}`);
      }
      return 0;
    }
    case "apply": {
      const e = env(args);
      const r = apply(e, args.target, "apply");
      if (r.applied === 0) {
        console.log("no changes");
        return 0;
      }
      for (const c of r.changed) console.log(`${c.kind.padEnd(9)} ${tilde(c.path, e.home)}`);
      console.log(`applied ${r.applied} file(s); backup ${r.backupId}`);
      for (const p of r.plans) for (const n of p.notes) console.log(`note (${p.target}): ${n}`);
      return 0;
    }
    case "uninstall": {
      const e = env(args);
      const r = apply(e, args.target, "remove");
      console.log(r.applied === 0 ? "nothing to remove" : `removed managed content from ${r.applied} file(s); backup ${r.backupId}`);
      return 0;
    }
    case "rollback": {
      const e = env(args);
      if (args.check) {
        console.log(listBackups(e).join("\n") || "no backups");
        return 0;
      }
      const r = rollback(e, args.backup);
      console.log(`rollback ${r.backupId}: restored ${r.restored.length}, removed ${r.removed.length}, failed ${r.failed.length}`);
      for (const f of r.failed) console.log(`  FAILED ${tilde(f.path, e.home)}: ${f.error}`);
      return r.failed.length === 0 ? 0 : 1;
    }
    case "doctor": {
      const e = env(args, true);
      const checks = await runDoctor(e);
      if (args.json) console.log(JSON.stringify(checks, null, 2));
      else console.log(formatChecks(checks));
      return exitCodeFor(checks);
    }
    case "verify": {
      const e = env(args, true);
      const r = await runParity(e);
      console.log(formatParity(r));
      const detected = detectCapabilities();
      for (const a of selectAdapters(args.target)) {
        const caps = a.capabilities(e, detected);
        const unsupported = Object.entries(caps).filter(([, c]) => c.level === "unsupported");
        console.log(`${a.name}: ${unsupported.length === 0 ? "all rules enforceable or with isolation fallback" : "UNSUPPORTED " + unsupported.map(([k]) => k).join(", ")}`);
      }
      return r.failures.length === 0 ? 0 : 1;
    }
    case "generate-check": {
      // render ด้วย environment คงที่ลง tests/fixtures/generated แล้วเทียบกับที่ commit ไว้
      const { REPO_ROOT } = await import("./core/policy-loader.ts");
      const fixtureHome = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "agents-adapter-gen-"));
      try {
        const e = resolveEnvironment({ home: fixtureHome, useExampleIfMissing: true, deterministic: true, cwd: fixtureHome });
        const result = plan(e, "all", "apply");
        const outDir = path.join(REPO_ROOT, "tests", "fixtures", "generated");
        const files: Record<string, string> = {};
        for (const c of result.changed) {
          if (c.after === null) continue;
          const rel = c.path.replace(fixtureHome, "HOME");
          files[rel] = c.after.split(fixtureHome).join("${HOME}");
        }
        if (args.check) {
          let drift = 0;
          for (const [rel, content] of Object.entries(files)) {
            const target = path.join(outDir, rel);
            if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content) {
              console.log(`drift: ${rel}`);
              drift++;
            }
          }
          console.log(drift === 0 ? "generated fixtures up to date" : `${drift} generated file(s) differ; run: node src/cli.ts generate-check`);
          return drift === 0 ? 0 : 1;
        }
        fs.rmSync(outDir, { recursive: true, force: true });
        for (const [rel, content] of Object.entries(files)) {
          const target = path.join(outDir, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content);
        }
        console.log(`wrote ${Object.keys(files).length} generated fixture file(s) to tests/fixtures/generated`);
        return 0;
      } finally {
        fs.rmSync(fixtureHome, { recursive: true, force: true });
      }
    }
    default:
      throw new Error(`unknown command: ${args.command}`);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
