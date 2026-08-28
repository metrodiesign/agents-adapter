/**
 * agents-adapter Pi extension: block /share และ session upload
 *
 * /share ของ Pi อัปโหลด session (รวมเนื้อหา repository) ไปบริการภายนอกหรือ gist
 * policy ถือว่าเท่ากับ PUBLIC_GIST จึง DENY จนกว่าจะมี share workflow ที่มี approval และ redaction
 */
import { classifyUserInput, denyMessage, type PiApi, type PiContext } from "./agents-adapter-lib/shared.ts";

export function guardInput(event: { text: string }, ctx: PiContext): { action: "handled" } | undefined {
  const v = classifyUserInput(event.text ?? "");
  if (v === null) return undefined;
  ctx.ui.notify(denyMessage(v), "error");
  return { action: "handled" };
}

export default function shareGuard(pi: PiApi): void {
  pi.on("input", guardInput);
  pi.on("tool_call", (event: { toolName: string }) => {
    const n = event.toolName.toLowerCase();
    if (n === "share" || n === "share_session" || n === "export_session") return { block: true, reason: "agents-adapter DENY [PI_SHARE]: session share is blocked" };
    return undefined;
  });
}
