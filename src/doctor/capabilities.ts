import { spawnSync } from "node:child_process";
import type { DetectedCapabilities } from "../adapters/types.ts";

function run(cmd: string, args: string[]): string | null {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
    if (r.error || r.status !== 0) return null;
    return (r.stdout || r.stderr).trim();
  } catch {
    return null;
  }
}

function which(cmd: string): boolean {
  return run("sh", ["-c", `command -v ${cmd}`]) !== null;
}

export function detectCapabilities(): DetectedCapabilities {
  const claude = run("claude", ["--version"]);
  const codex = run("codex", ["--version"]);
  const pi = run("pi", ["--version"]);
  // gh auth status: อ่าน exit code เท่านั้น ห้ามใช้ --show-token
  const gh = which("gh") ? (run("gh", ["auth", "status"]) !== null ? true : false) : null;
  return {
    claudeVersion: claude ? claude.split("\n")[0].replace(/\s*\(Claude Code\)/, "") : null,
    codexVersion: codex ? codex.replace(/^codex-cli\s*/, "") : null,
    piVersion: pi ? pi.split("\n")[0] : null,
    docker: run("docker", ["version", "--format", "{{.Client.Version}}"]) !== null,
    gondolin: which("gondolin"),
    openshell: which("openshell"),
    python3: run("python3", ["--version"]) !== null,
    ghAuthenticated: gh,
  };
}
