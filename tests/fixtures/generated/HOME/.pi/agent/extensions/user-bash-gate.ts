/**
 * agents-adapter Pi extension: gate สำหรับ !command และ !!command ของ user
 *
 * Pi ไม่มี block flag ใน user_bash event จึงส่ง result แทนการรันจริง (exitCode 1)
 * เมื่อ DENY หรือ ASK ที่ไม่ได้รับอนุมัติ
 */
import { blockedBashResult, classifyCommand, denyMessage, loadContext, resolveAsk, type BashResultLike, type PiApi, type PiContext } from "./agents-adapter-lib/shared.ts";

export async function gateUserBash(event: { command: string; excludeFromContext: boolean; cwd: string }, ctx: PiContext): Promise<{ result?: BashResultLike } | undefined> {
  const policy = loadContext(event.cwd || ctx.cwd);
  const v = classifyCommand(event.command, policy);
  if (v.decision === "ALLOW") return undefined;
  if (v.decision === "DENY") return { result: blockedBashResult(denyMessage(v)) };
  const ok = await resolveAsk(v, ctx, `${event.excludeFromContext ? "!!" : "!"}${event.command}`);
  return ok ? undefined : { result: blockedBashResult(`agents-adapter ASK [${v.ruleId}] not approved: ${v.reason}`) };
}

export default function userBashGate(pi: PiApi): void {
  pi.on("user_bash", gateUserBash);
}
