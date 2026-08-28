/**
 * agents-adapter Pi extension: protected paths (second layer).
 *
 * block credential และ production env path บน read/write/edit tool แม้ policy-gate จะถูกปิด
 */
import { classifyTool, denyMessage, loadContext, type PiApi, type PiContext } from "./agents-adapter-lib/shared.ts";

const HARD = new Set(["CREDENTIAL_READ", "CREDENTIAL_WRITE", "PROD_ENV_READ", "PROD_ENV_WRITE"]);
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "glob", "ls", "find"]);

export function protectedPathCheck(event: { toolName: string; input: Record<string, unknown> }, ctx: PiContext): { block?: boolean; reason?: string } | undefined {
  if (!FILE_TOOLS.has(event.toolName)) return undefined;
  const v = classifyTool({ toolName: event.toolName, input: event.input ?? {} }, loadContext(ctx.cwd));
  if (HARD.has(v.ruleId)) return { block: true, reason: denyMessage(v) };
  return undefined;
}

export default function protectedPaths(pi: PiApi): void {
  pi.on("tool_call", protectedPathCheck);
}
