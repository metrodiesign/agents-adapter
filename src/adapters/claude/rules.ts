/**
 * Claude Code permission patterns ที่สกัดจาก permission matrix
 * pattern semantics ของ Claude: Bash(prefix *) = prefix match, Bash(exact) = exact, * = wildcard
 */
import type { PolicyContext } from "../../core/context.ts";
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
    "Bash(*--sandbox danger-full-access*)",
    "Bash(*--sandbox=danger-full-access*)",
    "Bash(codex -s danger-full-access*)",
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
    deny.push(`Read(${tilde}${tilde.endsWith(".json") || tilde.endsWith("credentials") || tilde.endsWith("rc") ? "" : "/**"})`, `Edit(${tilde}${tilde.endsWith(".json") || tilde.endsWith("credentials") || tilde.endsWith("rc") ? "" : "/**"})`);
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

export const AUTO_MODE_PREFIX = "[agents-adapter] ";

export function autoModeEntries(config: UserConfig, ctx: PolicyContext): { allow: string[]; soft_deny: string[]; hard_deny: string[]; environment: string[] } {
  const p = AUTO_MODE_PREFIX;
  const roots = ctx.developmentRoots.join(", ");
  const branches = config.protected_branches.join(", ");
  return {
    allow: [
      `${p}อนุญาตงานพัฒนา routine ภายใน Development Trust Zone (${roots}): อ่าน/เขียน source, build, test, lint, formatter, code generation, static analysis`,
      `${p}อนุญาตอ่านและแก้ development env (${ctx.devEnvPatterns.join(", ")}) ภายใน trusted repo เพื่อ build/test/debug แต่ห้ามแสดงหรือ commit secret`,
      `${p}อนุญาตติดตั้งและอัปเดต dependency แบบ project-local พร้อม lock file`,
      `${p}อนุญาต local Docker build/pull/up/start/stop/restart/logs/exec/run เมื่อไม่มี destructive volume removal`,
      `${p}อนุญาต commit และ push เฉพาะ feature branch ที่ระบุชื่อชัดเจน รวมถึงสร้างหรืออัปเดต PR, issue, comment และตรวจ CI`,
    ],
    soft_deny: [
      `${p}ต้องมี user intent ที่ระบุ action และ target ก่อน rm -rf, git reset --hard, git clean, ลบ branch/tag แบบบังคับ, ลบ remote branch, destructive database, Docker prune หรือ volume removal`,
      `${p}ต้องมี user intent ชัดเจนก่อนติดตั้ง package แบบ global, แก้ shell startup file, system-wide configuration หรือ path นอก Development Trust Zone`,
      `${p}ต้องมี user intent ชัดเจนก่อนเพิ่ม เปลี่ยน หรือลบ Git remote และก่อนเปลี่ยน GitHub authentication`,
      `${p}ต้องมี user intent ชัดเจนก่อน deploy staging หรือแก้ shared CI/CD; production ต้องระบุ target, impact, backup และ rollback plan`,
    ],
    hard_deny: [
      `${p}ห้าม push ตรงเข้า ${branches}; ห้าม bare git push หรือ push ด้วย HEAD; ต้องระบุ remote และ feature branch`,
      `${p}ห้าม force push ทุกแบบ รวม --force-with-lease และ +refspec`,
      `${p}ห้าม merge pull request, ลบ repository หรือสร้าง gist แทน user`,
      `${p}ห้ามใช้ dangerous permission, sandbox หรือ hook bypass flag และห้าม sudo`,
      `${p}ห้ามอ่าน แสดง คัดลอก หรือแก้ credential store และ production env; ห้ามพิมพ์ค่า secret จาก development env`,
      `${p}ห้าม commit, log, paste หรือ upload secret, token, password, private key หรือ connection string`,
    ],
    environment: [
      `${p}Trusted repo: current repository และทุก Git repository ภายใต้ ${roots} เป็น Development Trust Zone`,
      `${p}Protected branches: ${branches}; PR merge เป็นการตัดสินใจของ user`,
      `${p}Sensitive data: ${ctx.prodEnvPatterns.join(", ")}, credential store และ keychain ใช้ได้เฉพาะผ่าน CLI เจ้าของ credential`,
    ],
  };
}
