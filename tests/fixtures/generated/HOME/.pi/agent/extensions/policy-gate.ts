/**
 * agents-adapter Pi extension: policy gate for model tool calls.
 *
 * intercept tool_call (bash, read, write, edit, grep, glob, ls และ tool อื่นทุกตัว)
 *   ALLOW -> ทำต่อ
 *   ASK   -> ctx.ui.confirm() พร้อม action + target + risk (cache ต่อ session/action/target)
 *   DENY  -> block พร้อม rule id
 */
import { classifyTool, denyMessage, loadContext, resolveAsk, type PiApi, type PiContext } from "./agents-adapter-lib/shared.ts";

export async function gateToolCall(event: { toolName: string; input: Record<string, unknown> }, ctx: PiContext): Promise<{ block?: boolean; reason?: string } | undefined> {
  const policy = loadContext(ctx.cwd);
  const v = classifyTool({ toolName: event.toolName, input: event.input ?? {} }, policy);
  if (v.decision === "ALLOW") return undefined;
  if (v.decision === "DENY") return { block: true, reason: denyMessage(v) };
  const ok = await resolveAsk(v, ctx, `tool ${event.toolName}`);
  return ok ? undefined : { block: true, reason: `agents-adapter ASK [${v.ruleId}] not approved: ${v.reason}` };
}

export default function policyGate(pi: PiApi): void {
  pi.on("tool_call", gateToolCall);
}
