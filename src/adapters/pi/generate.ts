import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { Environment } from "../../config/loader.ts";
import { renderTemplate, stableJson, upsertBlock, removeBlock } from "../../config/merger.ts";
import { serializableContext } from "../../core/policy-loader.ts";
import { claudeBlockVars } from "../claude/generate.ts";
import { change, readIfExists, validateJson } from "../fs-helpers.ts";
import type { AdapterPlan, RenderMode } from "../types.ts";

export const PI_LIB_DIR = "agents-adapter-lib";
const CORE_FILES = ["classifier.ts", "context.ts", "decisions.ts", "paths.ts", "shell.ts"];
const EXTENSIONS = ["policy-gate.ts", "protected-paths.ts", "user-bash-gate.ts", "share-guard.ts"];

/** shared.ts ใน repo import ../../../../src/core/*; ตอนติดตั้งเขียนให้ชี้ ./core/ */
export function rewriteSharedImports(source: string): string {
  return source.replace(/"\.\.\/\.\.\/\.\.\/\.\.\/src\/core\//g, '"./core/');
}

export function renderPi(env: Environment, mode: RenderMode): AdapterPlan {
  const remove = mode.mode === "remove";
  const agentDir = path.join(env.home, ".pi", "agent");
  const extDir = path.join(agentDir, "extensions");
  const libDir = path.join(extDir, PI_LIB_DIR);
  const runtimeDir = path.join(env.repoRoot, "runtime", "pi", "extensions");
  const changes = [];
  const unsupported: string[] = [];
  const notes: string[] = [];

  for (const f of EXTENSIONS) {
    const target = path.join(extDir, f);
    changes.push(change(target, readIfExists(target), remove ? null : fs.readFileSync(path.join(runtimeDir, f), "utf8")));
  }
  const sharedTarget = path.join(libDir, "shared.ts");
  changes.push(change(sharedTarget, readIfExists(sharedTarget), remove ? null : rewriteSharedImports(fs.readFileSync(path.join(runtimeDir, PI_LIB_DIR, "shared.ts"), "utf8"))));
  for (const f of CORE_FILES) {
    const target = path.join(libDir, "core", f);
    changes.push(change(target, readIfExists(target), remove ? null : fs.readFileSync(path.join(env.repoRoot, "src", "core", f), "utf8")));
  }
  const cfgTarget = path.join(libDir, "config.json");
  changes.push(change(cfgTarget, readIfExists(cfgTarget), remove ? null : stableJson(serializableContext(env.ctx)), validateJson));

  // settings.json: validate เท่านั้น; Pi auto-discover extension จาก ~/.pi/agent/extensions จึงไม่มี managed key
  const settingsPath = path.join(agentDir, "settings.json");
  const existingSettings = readIfExists(settingsPath);
  if (existingSettings !== null) {
    try {
      JSON.parse(existingSettings);
    } catch {
      unsupported.push("settings.json is not valid JSON; Pi will ignore it");
    }
  }
  changes.push(change(settingsPath, existingSettings, existingSettings ?? (remove ? null : "{}\n"), validateJson));

  const agentsPath = path.join(agentDir, "AGENTS.md");
  const existingAgents = readIfExists(agentsPath);
  const template = fs.readFileSync(path.join(env.repoRoot, "templates", "pi", "AGENTS.md.tmpl"), "utf8");
  const md = remove ? removeBlock(existingAgents) : upsertBlock(existingAgents, renderTemplate(template, claudeBlockVars(env)));
  changes.push(change(agentsPath, existingAgents, md === "" ? null : md));

  // isolation profile รวมค่า placeholder ที่แทนแล้ว
  const isolationMode = env.config.pi?.isolation_mode ?? "host-macos";
  const profileSrc = path.join(env.repoRoot, "runtime", "pi", "isolation", `${isolationMode}.yaml`);
  const profileTarget = path.join(agentDir, "agents-adapter-isolation.yaml");
  const profileDoc = YAML.parse(fs.readFileSync(profileSrc, "utf8")) as Record<string, unknown>;
  const rendered = YAML.stringify(profileDoc).replace(/\{\{development_root\}\}/g, env.ctx.developmentRoots[0] ?? "");
  changes.push(change(profileTarget, readIfExists(profileTarget), remove ? null : rendered));

  if (isolationMode === "host-macos") {
    notes.push("host-macos: CREDENTIAL_READ/PROD_ENV_READ are best-effort (extension only); use scripts/pi-isolated.sh docker for hard isolation");
  }
  notes.push("Pi has no native permission layer; enforcement = extensions in ~/.pi/agent/extensions (loaded automatically)");
  return {
    target: "pi",
    changes,
    managedKeys: [...EXTENSIONS.map((f) => `extensions/${f}`), `extensions/${PI_LIB_DIR}/*`, "AGENTS.md managed block", "agents-adapter-isolation.yaml"],
    preserved: existingSettings ? Object.keys(JSON.parse(existingSettings) as Record<string, unknown>) : [],
    conflicts: [],
    unsupported,
    notes,
  };
}

export function piManagedState(_env: Environment): Record<string, unknown> {
  return { "pi.extensions": EXTENSIONS };
}
