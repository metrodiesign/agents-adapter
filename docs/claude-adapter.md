# Claude Adapter

Claude Code เป็น reference adapter: policy ถูกสกัดจาก `reference/claude/*` และ generate กลับเป็น configuration native

## ไฟล์ที่ generate

| ไฟล์ | วิธี merge |
|---|---|
| `~/.claude/settings.json` | managed keys (ดูด้านล่าง); user-owned และ unknown keys preserve |
| `~/.claude/CLAUDE.md` | managed block ระหว่าง `<!-- agents-adapter:start -->` และ `<!-- agents-adapter:end -->` |

## Managed keys ใน settings.json

| key | ownership |
|---|---|
| `permissions.deny`, `permissions.ask`, `permissions.allow` | entries ที่ generate จาก matrix (state จำรายการเดิมเพื่อลบ stale entry); entries ของ user คงอยู่ |
| `permissions.additionalDirectories` | เติม development roots |
| `permissions.disableBypassPermissionsMode` | บังคับ `"disable"`; `defaultMode = bypassPermissions` ถูก reset |
| `sandbox.enabled`, `sandbox.autoAllowBashIfSandboxed` | บังคับ `true` |
| `sandbox.filesystem.denyRead`, `denyWrite`, `allowWrite` | เติม credential path, shell startup file, development roots |
| `sandbox.credentials.files`, `sandbox.credentials.envVars` | เติม credential path/env var แบบ `mode: deny` |
| `sandbox.excludedCommands` | เติม `gh *`, `docker *`, `codex *`, `dotnet test *` และ git network ops (`git push *`, `git fetch *`, `git pull *`, `git ls-remote *`, `git clone *`, รวมรูป `rtk git fetch *`, `rtk git pull *`, `rtk gh *`, `rtk docker *` ที่ rtk hook rewrite) เพราะ git เรียก `gh auth git-credential` ที่ต้องอ่าน `~/.config/gh`; permission rules ยังบังคับตามเดิม |
| `sandbox.network.allowedDomains` | เติม trusted domains + public registries |
| `autoMode.allow/soft_deny/hard_deny/environment` | entries ที่ขึ้นต้นด้วย `[agents-adapter] `; `$defaults` และ entries ของ user คงอยู่ |
| `autoMode.classifyAllShell` | `true` |
| `language` | `thai` |

key อื่น (`model`, `hooks`, `enabledPlugins`, `extraKnownMarketplaces`, `statusLine`, `env`, ...) ไม่ถูกแตะ

## พฤติกรรมที่บังคับใช้

- development env (`.env`, `.env.local`, ...) อ่านและแก้ได้; `cat .env` ถูก classifier (autoMode hard_deny) ปฏิเสธ
- production env และ credential ถูก deny ทั้ง `Read(...)`/`Edit(...)` rules และ sandbox `denyRead`/`denyWrite`/`credentials`
- `gh`, `docker`, `codex` รันนอก outer sandbox เพื่อใช้ keychain/socket ของตัวเอง แต่ยังผ่าน permission rules
- bypass permission mode ถูกปิดผ่าน `disableBypassPermissionsMode`

## Evaluator

`src/adapters/claude/evaluate.ts` จำลองลำดับ deny -> ask -> allow ของ pattern ที่ generate (`Bash(prefix *)`, `Read(glob)`, `Edit(glob)`) แล้ว fallback เป็น classifier กลางเหมือน autoMode ทำให้ parity test จับได้ถ้า pattern กว้างเกินไปจน ALLOW case กลายเป็น DENY

## Idempotency

รัน `apply --target claude` ซ้ำโดยไม่มี policy change ได้ `no changes`; managed block ไม่ถูกสร้างซ้ำ (`tests/adapters/claude.test.ts`)
