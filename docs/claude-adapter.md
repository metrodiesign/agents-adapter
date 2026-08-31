# Claude Adapter

Claude Code เป็น reference adapter: policy ถูกสกัดจาก `reference/claude/*` และ generate กลับเป็น configuration native

## ไฟล์ที่ generate

| ไฟล์ | วิธี merge |
|---|---|
| `~/.claude/settings.json` | managed keys (ดูด้านล่าง); user-owned และ unknown keys preserve |
| `~/.claude/CLAUDE.md` | managed block ระหว่าง `<!-- agents-adapter:start -->` และ `<!-- agents-adapter:end -->` |
| `~/.claude/hooks/agents-adapter/provider_guard.py` + `agents-adapter.config.json` | copy จาก `runtime/claude/hooks` + serialized PolicyContext; entry ใน `settings.json` `hooks.PreToolUse` (matcher `^(Agent\|Task)$`) เป็น managed, entry ของ user คงอยู่ |

## Managed keys ใน settings.json

| key | ownership |
|---|---|
| `permissions.deny`, `permissions.ask`, `permissions.allow` | entries ที่ generate จาก matrix (state จำรายการเดิมเพื่อลบ stale entry); entries ของ user คงอยู่ |
| `permissions.additionalDirectories` | เติม development roots |
| `permissions.disableBypassPermissionsMode` | บังคับ `"disable"`; `defaultMode = bypassPermissions` ถูก reset |
| `sandbox.enabled`, `sandbox.autoAllowBashIfSandboxed`, `sandbox.allowUnsandboxedCommands`, `sandbox.failIfUnavailable`, `sandbox.network.allowLocalBinding` | บังคับ `true`; ถ้า `allowUnsandboxedCommands` เป็น false ทั้ง `excludedCommands` จะไร้ผลโดยไม่มีสัญญาณเตือน |
| `sandbox.network.allowUnixSockets` | เติม `/var/run/docker.sock` และ `~/.docker/run/docker.sock` (symlink target) เพราะ `docker` ที่ถูกเรียกจาก script เป็น process ลูก จึงไม่ได้รับการยกเว้นจาก `excludedCommands` |
| `env` | เติม `DOTNET_SYSTEM_NET_DISABLEIPV6=1` (seatbelt ปฏิเสธ v4-mapped IPv6 loopback ที่ VSTest testhost ใช้); ค่า env อื่นของ user คงอยู่ |
| `sandbox.filesystem.denyRead`, `denyWrite`, `allowWrite` | เติม credential path, shell startup file, development roots และ `always_writable` (temp + cache ของ toolchain) |
| `sandbox.credentials.files`, `sandbox.credentials.envVars` | เติม credential path/env var แบบ `mode: deny` |
| `sandbox.excludedCommands` | เติม `gh *`, `docker *` (buildx เขียน `~/.docker/buildx` และ registry auth อ่าน `~/.docker/config.json`), `codex *` และ git network ops (`git push *`, `git fetch *`, `git pull *`, `git ls-remote *`, `git clone *`, รวมรูป `rtk git fetch *`, `rtk git pull *`, `rtk gh *`, `rtk docker *` ที่ rtk hook rewrite) เพราะ git เรียก `gh auth git-credential` ที่ต้องอ่าน `~/.config/gh`; permission rules ยังบังคับตามเดิม |
| `sandbox.network.allowedDomains` | เติม trusted domains + public registries |
| `autoMode.allow/soft_deny/hard_deny/environment` | entries ที่ขึ้นต้นด้วย `[agents-adapter] `; `$defaults` และ entries ของ user คงอยู่ |
| `autoMode.classifyAllShell` | `true` |
| `language` | `thai` |

key อื่น (`model`, `hooks`, `enabledPlugins`, `extraKnownMarketplaces`, `statusLine`, ...) ไม่ถูกแตะ; ใน `env` แตะเฉพาะ key ที่ระบุในตาราง

## พฤติกรรมที่บังคับใช้

- development env (`.env`, `.env.local`, ...) อ่านและแก้ได้; `cat .env` ถูก classifier (autoMode hard_deny) ปฏิเสธ
- production env และ credential ถูก deny ทั้ง `Read(...)`/`Edit(...)` rules และ sandbox `denyRead`/`denyWrite`/`credentials`
- `gh`, `docker`, `codex` รันนอก outer sandbox เพื่อใช้ keychain/socket ของตัวเอง แต่ยังผ่าน permission rules
- bypass permission mode ถูกปิดผ่าน `disableBypassPermissionsMode`
- provider guard: เมื่อ `ANTHROPIC_BASE_URL` ชี้ host ที่ไม่ใช่ `api.anthropic.com` (เช่น proxy ไป GPT) การ spawn agent ใน `security_agent_types` (`auditor`, `skeptic`, `security-review`, ...) ถูก deny ด้วย `SECURITY_AGENT_PROVIDER` เพราะ content filter ของ provider อื่นตอบ 400 และแฟล็ก context ของ agent นั้นถาวร; hook fail-open เมื่อไม่มี python3 หรือไฟล์หาย

## Evaluator

`src/adapters/claude/evaluate.ts` จำลองลำดับ deny -> ask -> allow ของ pattern ที่ generate (`Bash(prefix *)`, `Read(glob)`, `Edit(glob)`) แล้ว fallback เป็น classifier กลางเหมือน autoMode ทำให้ parity test จับได้ถ้า pattern กว้างเกินไปจน ALLOW case กลายเป็น DENY

## Idempotency

รัน `apply --target claude` ซ้ำโดยไม่มี policy change ได้ `no changes`; managed block ไม่ถูกสร้างซ้ำ (`tests/adapters/claude.test.ts`)
