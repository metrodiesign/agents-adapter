/**
 * Pi evaluator: เรียก handler ของ extension จริง (policy-gate, user-bash-gate, share-guard, protected-paths)
 * ด้วย fake ExtensionContext ที่ไม่มี UI (ASK = block เพราะ fail-closed) แล้วแปลงผลกลับเป็น Verdict
 */
import type { PolicyContext } from "../../core/context.ts";
import { type Verdict, verdict, strictest } from "../../core/decisions.ts";
import { classifyCommand, classifyTool, classifyUserInput } from "../../core/classifier.ts";
import { gateToolCall } from "../../../runtime/pi/extensions/policy-gate.ts";
import { protectedPathCheck } from "../../../runtime/pi/extensions/protected-paths.ts";
import { gateUserBash } from "../../../runtime/pi/extensions/user-bash-gate.ts";
import { guardInput } from "../../../runtime/pi/extensions/share-guard.ts";
import { _setContextForTests, type PiContext } from "../../../runtime/pi/extensions/agents-adapter-lib/shared.ts";
import type { Action } from "../types.ts";

function fakeCtx(cwd: string): PiContext {
  return {
    cwd,
    hasUI: false,
    ui: {
      confirm: async () => false,
      notify: () => undefined,
    },
  };
}

function fromBlock(reason: string | undefined, fallback: Verdict): Verdict {
  if (reason === undefined) return fallback.decision === "ALLOW" ? fallback : verdict("ALLOW", fallback.ruleId, "extension allowed");
  const deny = reason.match(/DENY \[([A-Z_]+)\]/);
  if (deny) return verdict("DENY", deny[1], reason, fallback.target);
  const ask = reason.match(/ASK \[([A-Z_]+)\]/);
  if (ask) return verdict("ASK", ask[1], reason, fallback.target);
  return verdict("DENY", "UNKNOWN_COMMAND", reason);
}

export async function evaluatePi(action: Action, ctx: PolicyContext): Promise<Verdict> {
  _setContextForTests(ctx);
  const pc = fakeCtx(ctx.cwd);
  if (action.kind === "user_input") {
    const r = guardInput({ text: action.text }, pc);
    return r === undefined ? verdict("ALLOW", "SHELL_READ_ONLY", "user input") : (classifyUserInput(action.text) ?? verdict("DENY", "PI_SHARE", "blocked"));
  }
  if (action.kind === "pi_bash") {
    const expected = classifyCommand(action.command, ctx);
    const r = await gateUserBash({ command: action.command, excludeFromContext: action.excludeFromContext ?? false, cwd: ctx.cwd }, pc);
    return fromBlock(r?.result?.output, expected);
  }
  if (action.kind === "command") {
    const expected = classifyCommand(action.command, ctx);
    const r = await gateToolCall({ toolName: "bash", input: { command: action.command } }, pc);
    return fromBlock(r?.reason, expected);
  }
  const expected = classifyTool({ toolName: action.tool.name.toLowerCase(), input: action.tool.input }, ctx);
  const ev = { toolName: action.tool.name.toLowerCase(), input: action.tool.input };
  const a = await gateToolCall(ev, pc);
  const b = protectedPathCheck(ev, pc);
  return strictest([fromBlock(a?.reason, expected), fromBlock(b?.reason, expected)]);
}
