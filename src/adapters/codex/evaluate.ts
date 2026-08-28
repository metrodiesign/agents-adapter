/**
 * Codex evaluator: รัน policy_gate.py จริงผ่าน subprocess (PreToolUse payload)
 * แล้วรวมกับ prefix rules ที่ generate (strictest wins)
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Environment } from "../../config/loader.ts";
import type { PolicyContext } from "../../core/context.ts";
import { type Verdict, strictest, verdict } from "../../core/decisions.ts";
import { serializableContext } from "../../core/policy-loader.ts";
import { parseCommand } from "../../core/shell.ts";
import { classifyUserInput } from "../../core/classifier.ts";
import type { Action } from "../types.ts";
import { codexRules, evaluateRules } from "./rules.ts";

let configFile: string | null = null;
let configFor: string | null = null;

function contextFile(ctx: PolicyContext): string {
  const key = JSON.stringify(serializableContext(ctx));
  if (configFile !== null && configFor === key) return configFile;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-adapter-codex-"));
  configFile = path.join(dir, "agents-adapter.config.json");
  fs.writeFileSync(configFile, key);
  configFor = key;
  return configFile;
}

export function runPolicyGate(toolName: string, toolInput: unknown, ctx: PolicyContext, repoRoot: string): Verdict {
  const payload = {
    session_id: "parity",
    turn_id: "1",
    cwd: ctx.cwd,
    hook_event_name: "PreToolUse",
    model: "test",
    permission_mode: "default",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "t1",
    transcript_path: null,
  };
  const script = path.join(repoRoot, "runtime", "codex", "hooks", "policy_gate.py");
  const res = spawnSync("python3", [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, AGENTS_ADAPTER_CONFIG: contextFile(ctx), AGENTS_ADAPTER_VERBOSE: "1" },
  });
  if (res.error) throw res.error;
  if (res.status === 2) {
    const m = res.stderr.match(/DENY \[([A-Z_]+)\]: (.*)/);
    return verdict("DENY", m ? m[1] : "UNKNOWN_COMMAND", m ? m[2].trim() : res.stderr.trim());
  }
  if (res.status !== 0) throw new Error(`policy_gate.py failed (${res.status}): ${res.stderr}`);
  const out = res.stdout.trim();
  if (out !== "") {
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } };
    const text = parsed.hookSpecificOutput?.additionalContext ?? "";
    const m = text.match(/ASK \[([A-Z_]+)\]: (.*?)\. Requires one explicit user approval for target '(.*)'/);
    if (m) return verdict("ASK", m[1], m[2], m[3]);
  }
  const allow = res.stderr.match(/ALLOW \[([A-Z_]+)\]: (.*)/);
  return verdict("ALLOW", allow ? allow[1] : "SHELL_READ_ONLY", allow ? allow[2].trim() : "hook allowed");
}

export async function evaluateCodex(action: Action, ctx: PolicyContext, env: Environment): Promise<Verdict> {
  if (action.kind === "user_input") return classifyUserInput(action.text) ?? verdict("ALLOW", "SHELL_READ_ONLY", "user input");
  if (action.kind === "pi_bash") return verdict("ALLOW", "SHELL_READ_ONLY", "not applicable to Codex (Pi-only path)");
  if (action.kind === "tool") return runPolicyGate(action.tool.name, action.tool.input, ctx, env.repoRoot);
  const hook = runPolicyGate("Bash", { command: action.command }, ctx, env.repoRoot);
  // rules layer: Codex ข้ามคำสั่งที่มี substitution/env prefix; เทียบเฉพาะ segment ที่เป็น simple command
  const rules = codexRules(env.config);
  const verdicts: Verdict[] = [hook];
  for (const seg of parseCommand(action.command)) {
    if (seg.hasSubstitution) continue;
    const r = evaluateRules(seg.words, rules);
    if (r === null || r.decision === "allow") continue;
    verdicts.push(verdict(r.decision === "forbidden" ? "DENY" : "ASK", r.ruleId, `codex rule ${r.ruleId}`, hook.target));
  }
  return strictest(verdicts);
}
