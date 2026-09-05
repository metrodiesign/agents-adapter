import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DetectedCapabilities } from "../adapters/types.ts";
import { agentGhConfigDir } from "../core/policy-loader.ts";

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000, env: env ? { ...process.env, ...env } : process.env });
    if (r.error || r.status !== 0) return null;
    return (r.stdout || r.stderr).trim();
  } catch {
    return null;
  }
}

function runWithEnv(cmd: string, args: string[], env: NodeJS.ProcessEnv): string | null {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000, env });
    if (r.error || r.status !== 0) return null;
    return (r.stdout || r.stderr).trim();
  } catch {
    return null;
  }
}

function which(cmd: string): boolean {
  return run("sh", ["-c", `command -v ${cmd}`]) !== null;
}

export function detectCapabilities(home = process.env.HOME ?? ""): DetectedCapabilities {
  const claude = run("claude", ["--version"]);
  const codex = run("codex", ["--version"]);
  const pi = run("pi", ["--version"]);
  // gh auth status: ห้ามใช้ --show-token; อ่านเฉพาะบรรทัด "Token scopes" (OAuth/classic token) เพื่อเช็ค workflow scope
  // ใน Claude session env มี GH_CONFIG_DIR=~/.claude/gh: ต้องตัดออกเพื่อให้ check ของ user token ดู ~/.config/gh จริง
  const { GH_CONFIG_DIR: _agentDir, ...userEnv } = process.env;
  const ghStatus = which("gh") ? runWithEnv("gh", ["auth", "status"], userEnv) : null;
  const gh = which("gh") ? ghStatus !== null : null;
  const agentStatusOf = (cli: "claude" | "codex"): string | null => {
    const dir = agentGhConfigDir(home, cli);
    return which("gh") && fs.existsSync(dir) ? run("gh", ["auth", "status"], { GH_CONFIG_DIR: dir }) : null;
  };
  const agentStatus = agentStatusOf("codex");
  const claudeAgentStatus = agentStatusOf("claude");
  return {
    claudeVersion: claude ? claude.split("\n")[0].replace(/\s*\(Claude Code\)/, "") : null,
    codexVersion: codex ? codex.replace(/^codex-cli\s*/, "") : null,
    piVersion: pi ? pi.split("\n")[0] : null,
    docker: run("docker", ["version", "--format", "{{.Client.Version}}"]) !== null,
    gondolin: which("gondolin"),
    openshell: which("openshell"),
    python3: run("python3", ["--version"]) !== null,
    ghAuthenticated: gh,
    ghTokenScopes: parseScopes(ghStatus),
    ghAgentTokenScopes: parseScopes(agentStatus),
    ghAgentTokenKeyring: agentStatus === null ? null : /\(keyring\)/.test(agentStatus),
    ghClaudeAgentTokenScopes: parseScopes(claudeAgentStatus),
    ghClaudeAgentTokenKeyring: claudeAgentStatus === null ? null : /\(keyring\)/.test(claudeAgentStatus),
    agentSandbox: process.env.CODEX_SANDBOX ? "codex" : process.env.CLAUDECODE ? "claude" : null,
  };
}

/** "Token scopes: 'gist', 'repo'" -> ["gist","repo"]; fine-grained PAT ไม่มีบรรทัดนี้ -> null (ตรวจ scope ไม่ได้) */
export function parseScopes(status: string | null): string[] | null {
  const m = status?.match(/Token scopes:\s*(.+)/);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
