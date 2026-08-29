/**
 * Codex execpolicy prefix rules ที่สกัดจาก permission matrix
 * decision: allow | prompt | forbidden (strictest matching rule wins ใน Codex)
 * ใช้เป็นชั้นเสริมของ hook: ห้ามพึ่ง rules ชั้นเดียวสำหรับ hard boundary
 */
import type { UserConfig } from "../../core/policy-loader.ts";

export interface PrefixRule {
  pattern: Array<string | string[]>;
  decision: "allow" | "prompt" | "forbidden";
  justification: string;
  ruleId: string;
}

export function codexRules(config: UserConfig): PrefixRule[] {
  const rules: PrefixRule[] = [
    { pattern: ["sudo"], decision: "forbidden", justification: "PRIVILEGE_ESCALATION: privileged execution is never allowed", ruleId: "PRIVILEGE_ESCALATION" },
    { pattern: ["doas"], decision: "forbidden", justification: "PRIVILEGE_ESCALATION", ruleId: "PRIVILEGE_ESCALATION" },
    { pattern: ["git", "push", ["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror"]], decision: "forbidden", justification: "GIT_FORCE_PUSH: force push is never allowed", ruleId: "GIT_FORCE_PUSH" },
    { pattern: ["gh", "pr", "merge"], decision: "forbidden", justification: "GH_PR_MERGE: merge is a user decision", ruleId: "GH_PR_MERGE" },
    { pattern: ["gh", "repo", "delete"], decision: "forbidden", justification: "GH_REPO_DELETE", ruleId: "GH_REPO_DELETE" },
    { pattern: ["gh", "gist"], decision: "forbidden", justification: "PUBLIC_GIST", ruleId: "PUBLIC_GIST" },
    { pattern: ["gh", "secret"], decision: "forbidden", justification: "GH_SECRET_MANAGE", ruleId: "GH_SECRET_MANAGE" },
    { pattern: ["gh", "auth", "token"], decision: "forbidden", justification: "CREDENTIAL_READ: never print credentials", ruleId: "CREDENTIAL_READ" },
    { pattern: ["git", "reset", "--hard"], decision: "prompt", justification: "GIT_RESET_HARD", ruleId: "GIT_RESET_HARD" },
    { pattern: ["git", "clean", ["-f", "-fd", "-fdx", "-fx", "-df", "-dfx", "-ffd", "-ffdx", "--force", "-xf", "-xdf", "-dxf"]], decision: "prompt", justification: "GIT_CLEAN", ruleId: "GIT_CLEAN" },
    { pattern: ["git", "branch", "-D"], decision: "prompt", justification: "GIT_BRANCH_FORCE_DELETE", ruleId: "GIT_BRANCH_FORCE_DELETE" },
    { pattern: ["git", "tag", "-d"], decision: "prompt", justification: "GIT_BRANCH_FORCE_DELETE", ruleId: "GIT_BRANCH_FORCE_DELETE" },
    { pattern: ["git", "push", ["--delete", "-d"]], decision: "prompt", justification: "GIT_REMOTE_DELETE", ruleId: "GIT_REMOTE_DELETE" },
    { pattern: ["git", "remote", ["add", "set-url", "remove", "rm", "rename"]], decision: "prompt", justification: "GIT_REMOTE_CHANGE", ruleId: "GIT_REMOTE_CHANGE" },
    { pattern: ["git", "config", ["--global", "--system"]], decision: "prompt", justification: "SYSTEM_CONFIG_CHANGE", ruleId: "SYSTEM_CONFIG_CHANGE" },
    { pattern: ["gh", "auth", ["login", "logout", "refresh", "switch"]], decision: "prompt", justification: "GH_AUTH_CHANGE", ruleId: "GH_AUTH_CHANGE" },
    { pattern: ["gh", "repo", ["create", "fork", "archive", "rename", "edit"]], decision: "prompt", justification: "GH_REPO_CREATE", ruleId: "GH_REPO_CREATE" },
    { pattern: ["gh", "release", ["create", "edit", "upload", "delete"]], decision: "prompt", justification: "GH_REPO_CREATE", ruleId: "GH_REPO_CREATE" },
    { pattern: ["gh", "pr", "close"], decision: "prompt", justification: "GH_REPO_CREATE", ruleId: "GH_REPO_CREATE" },
    { pattern: ["docker", "system", "prune"], decision: "prompt", justification: "DOCKER_PRUNE", ruleId: "DOCKER_PRUNE" },
    { pattern: ["docker", ["image", "container", "network"], ["prune", "rm"]], decision: "prompt", justification: "DOCKER_PRUNE", ruleId: "DOCKER_PRUNE" },
    { pattern: ["docker", ["rmi", "rm"]], decision: "prompt", justification: "DOCKER_PRUNE", ruleId: "DOCKER_PRUNE" },
    { pattern: ["docker", "volume", ["rm", "prune"]], decision: "prompt", justification: "DOCKER_DELETE_VOLUME", ruleId: "DOCKER_DELETE_VOLUME" },
    { pattern: ["docker", "push"], decision: "prompt", justification: "STAGING_DEPLOY", ruleId: "STAGING_DEPLOY" },
    { pattern: ["npm", ["install", "i"], ["-g", "--global"]], decision: "prompt", justification: "GLOBAL_DEP_INSTALL", ruleId: "GLOBAL_DEP_INSTALL" },
    { pattern: ["pnpm", "add", "-g"], decision: "prompt", justification: "GLOBAL_DEP_INSTALL", ruleId: "GLOBAL_DEP_INSTALL" },
    { pattern: ["yarn", "global"], decision: "prompt", justification: "GLOBAL_DEP_INSTALL", ruleId: "GLOBAL_DEP_INSTALL" },
    { pattern: ["brew", ["install", "uninstall", "upgrade"]], decision: "prompt", justification: "GLOBAL_DEP_INSTALL", ruleId: "GLOBAL_DEP_INSTALL" },
    { pattern: ["pipx", "install"], decision: "prompt", justification: "GLOBAL_DEP_INSTALL", ruleId: "GLOBAL_DEP_INSTALL" },
    { pattern: ["cargo", "install"], decision: "prompt", justification: "GLOBAL_DEP_INSTALL", ruleId: "GLOBAL_DEP_INSTALL" },
    { pattern: ["kubectl", ["apply", "delete", "rollout", "scale", "exec"]], decision: "prompt", justification: "STAGING_DEPLOY", ruleId: "STAGING_DEPLOY" },
    { pattern: ["terraform", ["apply", "destroy", "import"]], decision: "prompt", justification: "STAGING_DEPLOY", ruleId: "STAGING_DEPLOY" },
    { pattern: ["vercel"], decision: "prompt", justification: "STAGING_DEPLOY", ruleId: "STAGING_DEPLOY" },
    { pattern: ["firebase", "deploy"], decision: "prompt", justification: "STAGING_DEPLOY", ruleId: "STAGING_DEPLOY" },
    { pattern: ["dropdb"], decision: "prompt", justification: "LOCAL_DESTRUCTIVE_DB", ruleId: "LOCAL_DESTRUCTIVE_DB" },
    { pattern: ["prisma", "migrate", "reset"], decision: "prompt", justification: "LOCAL_DESTRUCTIVE_DB", ruleId: "LOCAL_DESTRUCTIVE_DB" },
    { pattern: ["php", "artisan", ["migrate:fresh", "migrate:reset", "db:wipe", "migrate:refresh"]], decision: "prompt", justification: "LOCAL_DESTRUCTIVE_DB", ruleId: "LOCAL_DESTRUCTIVE_DB" },
    { pattern: ["dotnet", "ef", "database", "drop"], decision: "prompt", justification: "LOCAL_DESTRUCTIVE_DB", ruleId: "LOCAL_DESTRUCTIVE_DB" },
    { pattern: ["git", ["status", "diff", "log", "show", "fetch", "branch", "add", "commit", "switch", "checkout", "merge", "rebase", "stash"]], decision: "allow", justification: "GIT_STATUS / GIT_COMMIT routine git", ruleId: "GIT_COMMIT" },
    { pattern: ["gh", "pr", "create"], decision: "allow", justification: "GH_PR_CREATE", ruleId: "GH_PR_CREATE" },
    { pattern: ["gh", "pr", ["view", "list", "checks", "diff", "comment", "edit", "review"]], decision: "allow", justification: "GH_READ / GH_PR_UPDATE", ruleId: "GH_PR_UPDATE" },
    { pattern: ["gh", "auth", "status"], decision: "allow", justification: "GH_READ", ruleId: "GH_READ" },
    // sandbox escalation (คู่กับ excluded_commands ของ Claude): CLI กลุ่มนี้อ่าน ~/.config/gh, docker socket หรือ runtime ของตัวเอง
    // ซึ่ง permission profile deny ไว้ จึงต้องรัน require_escalated; allow rule ทำให้ escalation ไม่ prompt
    // forbidden/prompt rule ที่เจาะจงกว่าด้านบน (gh pr merge, docker prune, git push --force, protected branch) ยังชนะเพราะ strictest wins
    { pattern: ["gh"], decision: "allow", justification: "GH_READ: gh must run outside the sandbox to read ~/.config/gh; stricter gh rules still win", ruleId: "GH_READ" },
    { pattern: ["git", ["push", "pull", "ls-remote", "clone"]], decision: "allow", justification: "GIT_PUSH_FEATURE: git network ops call gh auth git-credential outside the sandbox; protected/force push rules still win", ruleId: "GIT_PUSH_FEATURE" },
    { pattern: ["docker"], decision: "allow", justification: "BUILD: docker needs its socket outside the sandbox; prune/volume/push rules still win", ruleId: "BUILD" },
    { pattern: ["dotnet", "test"], decision: "allow", justification: "TEST: dotnet test hosts need their runtime outside the sandbox", ruleId: "TEST" },
  ];
  for (const b of config.protected_branches) {
    rules.push({ pattern: ["git", "push", "origin", b], decision: "forbidden", justification: `GIT_PUSH_PROTECTED: ${b} is protected`, ruleId: "GIT_PUSH_PROTECTED" });
    rules.push({ pattern: ["git", "push", "origin", `HEAD:${b}`], decision: "forbidden", justification: `GIT_PUSH_PROTECTED: ${b} is protected`, ruleId: "GIT_PUSH_PROTECTED" });
    rules.push({ pattern: ["git", "push", "origin", `refs/heads/${b}`], decision: "forbidden", justification: `GIT_PUSH_PROTECTED: ${b} is protected`, ruleId: "GIT_PUSH_PROTECTED" });
  }
  return rules;
}

function starlarkList(items: Array<string | string[]>): string {
  return "[" + items.map((i) => (Array.isArray(i) ? "[" + i.map(q).join(", ") + "]" : q(i))).join(", ") + "]";
}

function q(s: string): string {
  return JSON.stringify(s);
}

export function renderRulesBlock(rules: PrefixRule[]): string {
  return rules
    .map(
      (r) =>
        `prefix_rule(\n    pattern = ${starlarkList(r.pattern)},\n    decision = ${q(r.decision)},\n    justification = ${q(`agents-adapter ${r.justification}`)},\n)`,
    )
    .join("\n\n");
}

/** ประเมิน prefix rule แบบเดียวกับ Codex (strictest wins) สำหรับ parity test */
export function evaluateRules(words: string[], rules: PrefixRule[]): { decision: "allow" | "prompt" | "forbidden"; ruleId: string } | null {
  const rank = { allow: 0, prompt: 1, forbidden: 2 };
  let best: { decision: "allow" | "prompt" | "forbidden"; ruleId: string } | null = null;
  for (const r of rules) {
    if (r.pattern.length > words.length) continue;
    let ok = true;
    for (let i = 0; i < r.pattern.length; i++) {
      const p = r.pattern[i];
      const w = words[i];
      if (Array.isArray(p) ? !p.includes(w) : p !== w) {
        ok = false;
        break;
      }
    }
    if (ok && (best === null || rank[r.decision] > rank[best.decision])) best = { decision: r.decision, ruleId: r.ruleId };
  }
  return best;
}
