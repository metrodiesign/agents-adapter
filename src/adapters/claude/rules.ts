/**
 * Claude Code permission patterns ที่สกัดจาก permission matrix
 * pattern semantics ของ Claude: Bash(prefix *) = prefix match, Bash(exact) = exact, * = wildcard
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PolicyContext } from "../../core/context.ts";
import { REPO_ROOT } from "../../core/policy-loader.ts";
import type { UserConfig } from "../../core/policy-loader.ts";

export interface ClaudePatterns {
  deny: string[];
  ask: string[];
  allow: string[];
}

export function claudePatterns(config: UserConfig, ctx: PolicyContext): ClaudePatterns {
  const deny: string[] = [
    "Bash(sudo *)",
    "Bash(doas *)",
    "Bash(git push)",
    "Bash(git push origin)",
    "Bash(git push upstream)",
    "Bash(git push -u origin)",
    "Bash(git push * HEAD)",
    "Bash(git push * HEAD:*)",
    "Bash(git push *--force*)",
    "Bash(git push -f *)",
    "Bash(git push * -f *)",
    "Bash(git push *-uf *)",
    "Bash(git push --mirror *)",
    "Bash(git push --all *)",
    "Bash(git push * +*)",
    "Bash(gh auth token*)",
    "Bash(gh auth status --show-token*)",
    "Bash(gh pr merge *)",
    "Bash(gh repo delete *)",
    "Bash(gh gist *)",
    "Bash(gh secret *)",
    "Bash(curl* | sh*)",
    "Bash(curl* | bash*)",
    "Bash(wget* | sh*)",
    "Bash(wget* | bash*)",
    "Bash(*--dangerously-skip-permissions*)",
    "Bash(*--dangerously-bypass-approvals-and-sandbox*)",
    "Bash(*--dangerously-bypass-hook-trust*)",
    "Bash(*--permission-mode bypassPermissions*)",
    "Bash(pi --no-extensions*)",
    "Bash(pi -ne*)",
  ];
  for (const b of config.protected_branches) {
    deny.push(
      `Bash(git push * ${b})`,
      `Bash(git push * ${b} *)`,
      `Bash(git push *:${b})`,
      `Bash(git push *:${b} *)`,
      `Bash(git push *refs/heads/${b}*)`,
      `Bash(git push * --delete ${b})`,
    );
  }
  for (const p of ctx.credentialPaths) {
    const tilde = p.replace(ctx.home, "~");
    const suffix = isFileLike(tilde) ? "" : "/**";
    deny.push(`Read(${tilde}${suffix})`, `Edit(${tilde}${suffix})`);
  }
  for (const pat of ctx.prodEnvPatterns) {
    deny.push(`Read(**/${pat})`, `Edit(**/${pat})`);
  }

  const ask: string[] = [
    "Bash(rm -rf *)",
    "Bash(rm -fr *)",
    "Bash(rm -r -f *)",
    "Bash(rm -Rf *)",
    "Bash(rm --recursive --force *)",
    "Bash(git reset --hard *)",
    "Bash(git clean -f*)",
    "Bash(git clean --force*)",
    "Bash(git branch -D *)",
    "Bash(git tag -d *)",
    "Bash(git stash drop*)",
    "Bash(git stash clear*)",
    "Bash(git push * --delete *)",
    "Bash(git push -d *)",
    "Bash(git push * :*)",
    "Bash(git remote add *)",
    "Bash(git remote set-url *)",
    "Bash(git remote remove *)",
    "Bash(git remote rm *)",
    "Bash(git remote rename *)",
    "Bash(git config --global *)",
    "Bash(git config --system *)",
    "Bash(gh auth login *)",
    "Bash(gh auth logout *)",
    "Bash(gh repo create *)",
    "Bash(gh pr close *)",
    "Bash(gh issue close *)",
    "Bash(gh release create *)",
    "Bash(gh release edit *)",
    "Bash(gh release upload *)",
    "Bash(gh release delete *)",
    "Bash(docker system prune *)",
    "Bash(docker container prune *)",
    "Bash(docker image prune *)",
    "Bash(docker image rm *)",
    "Bash(docker rmi *)",
    "Bash(docker volume prune *)",
    "Bash(docker volume rm *)",
    "Bash(docker compose * down *--volumes*)",
    "Bash(docker compose * down * -v*)",
    "Bash(docker compose down *--volumes*)",
    "Bash(docker compose down * -v*)",
    "Bash(docker compose down -v*)",
    "Bash(docker-compose down -v*)",
    "Bash(docker push *)",
    "Bash(npm install -g *)",
    "Bash(npm i -g *)",
    "Bash(npm install --global *)",
    "Bash(npm i --global *)",
    "Bash(pnpm add -g *)",
    "Bash(yarn global add *)",
    "Bash(pipx install *)",
    "Bash(cargo install *)",
    "Bash(brew install *)",
    "Bash(brew uninstall *)",
    "Bash(brew upgrade *)",
    "Bash(kubectl apply *)",
    "Bash(kubectl delete *)",
    "Bash(terraform apply *)",
    "Bash(terraform destroy *)",
    "Bash(vercel --prod*)",
    "Bash(vercel deploy*)",
    "Bash(firebase deploy *)",
    "Bash(dropdb *)",
    "Bash(prisma migrate reset *)",
    "Bash(npx prisma migrate reset *)",
    "Bash(php artisan migrate:fresh *)",
    "Bash(php artisan migrate:reset *)",
    "Bash(php artisan db:wipe *)",
    "Bash(dotnet ef database drop *)",
    "Bash(codex *--sandbox danger-full-access*)",
  ];

  const allow: string[] = [
    "Bash(gh auth status)",
    "Bash(gh repo view *)",
    "Bash(gh pr list *)",
    "Bash(gh pr view *)",
    "Bash(gh pr checks *)",
    "Bash(gh pr diff *)",
    "Bash(gh pr create *)",
    "Bash(gh pr comment *)",
    "Bash(gh pr edit *)",
    "Bash(gh pr review *)",
    "Bash(gh issue list *)",
    "Bash(gh issue view *)",
    "Bash(gh issue create *)",
    "Bash(gh issue comment *)",
    "Bash(gh run list *)",
    "Bash(gh run view *)",
    "Bash(gh run watch *)",
    "Bash(gh run rerun *)",
    "Bash(gh workflow list *)",
    "Bash(gh workflow view *)",
    "Bash(gh release list *)",
    "Bash(gh release view *)",
    "Bash(codex *)",
  ];
  return { deny, ask, allow };
}

/** path ที่เป็นไฟล์ (ไม่ใช่ directory) ไม่ต้องต่อ /** */
function isFileLike(p: string): boolean {
  return /\.(json|yaml|yml|toml)$/.test(p) || /(credentials|rc|\.netrc|\.git-credentials)$/.test(p);
}

export interface AutoModeSets {
  allow: string[];
  soft_deny: string[];
  hard_deny: string[];
  environment: string[];
}

/**
 * autoMode entries มาจาก Claude reference (reference/claude/settings.sanitized.json) โดยตรง
 * แทน placeholder ด้วยค่าจาก user config เพื่อให้ผลตรงกับไฟล์ต้นทางของ user ที่เป็น reference
 */
export function autoModeEntries(config: UserConfig, ctx: PolicyContext): AutoModeSets {
  const ref = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "reference", "claude", "settings.sanitized.json"), "utf8")) as { autoMode: AutoModeSets };
  const sub = (s: string): string =>
    s
      .replace(/\$\{HOME\}/g, ctx.home)
      .replace(/\{\{github_owner\}\}/g, config.github?.owner ?? "{{github_owner}}")
      .replace(/\{\{trusted_domains\}\}/g, (config.trusted_domains ?? []).filter((d) => !["localhost", "127.0.0.1", "host.docker.internal", "github.com", "api.github.com"].includes(d)).join(", ") || "{{trusted_domains}}");
  const pick = (list: string[]): string[] => list.filter((x) => x !== "$defaults").map(sub);
  return {
    allow: pick(ref.autoMode.allow),
    soft_deny: pick(ref.autoMode.soft_deny),
    hard_deny: pick(ref.autoMode.hard_deny),
    environment: pick(ref.autoMode.environment),
  };
}
