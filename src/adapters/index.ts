import { claudeAdapter } from "./claude/index.ts";
import { codexAdapter } from "./codex/index.ts";
import { piAdapter } from "./pi/index.ts";
import type { Adapter, TargetName } from "./types.ts";

export const ADAPTERS: Record<TargetName, Adapter> = { claude: claudeAdapter, codex: codexAdapter, pi: piAdapter };

export function selectAdapters(target: string): Adapter[] {
  if (target === "all") return Object.values(ADAPTERS);
  const a = ADAPTERS[target as TargetName];
  if (!a) throw new Error(`unknown target: ${target} (claude|codex|pi|all)`);
  return [a];
}
