export type Decision = "ALLOW" | "ASK" | "DENY";

export interface Verdict {
  decision: Decision;
  ruleId: string;
  reason: string;
  /** target ที่ใช้เป็น key ของ approval cache เช่น path, refspec, package */
  target?: string;
}

const RANK: Record<Decision, number> = { ALLOW: 0, ASK: 1, DENY: 2 };

/** รวมหลาย verdict: DENY > ASK > ALLOW */
export function strictest(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) {
    return { decision: "ALLOW", ruleId: "SHELL_READ_ONLY", reason: "empty command" };
  }
  return verdicts.reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a));
}

export function verdict(decision: Decision, ruleId: string, reason: string, target?: string): Verdict {
  return target === undefined ? { decision, ruleId, reason } : { decision, ruleId, reason, target };
}
