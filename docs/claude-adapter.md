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
| `sandbox.network.allowUnixSockets` | เติม `/var/run/docker.sock` และ `~/.docker/run/docker.sock` (symlink target) เพราะ docker ทุก process (รวมที่ script/compose เรียก) รันใน sandbox จึงต้องต่อ daemon ผ่าน socket โดยตรง; `/tmp`, `/private/tmp` สำหรับ AF_UNIX ของ MSBuild worker |
| `sandbox.network.allowMachLookup` | เติม `com.apple.trustd.agent` (Go crypto/x509 ประเมิน certificate ผ่าน trustd; ไม่มี = `gh`/`docker buildx` ตอบ `tls: failed to verify certificate: x509: OSStatus -26276`) และ `com.apple.sysmond` (`pgrep`/`pkill` ขอ process list; ไม่มี = `sysmond service not found` + `Cannot get process list`); entry ของ user เช่น `com.apple.coresimulator.*` คงอยู่; ไม่ใช้ `enableWeakerNetworkIsolation` เพราะเป็น flag เหมาเข่งที่เพิ่ม rule เดียวกันแต่ไม่ระบุชื่อ service |
| `env` | เติม `GH_CONFIG_DIR=~/.claude/gh` (absolute path; gh และ `gh auth git-credential` ที่ git เรียกอ่าน agent token จากที่นี่แทน `~/.config/gh` + keychain), `GH_NO_UPDATE_NOTIFIER=1` และ `DOTNET_SYSTEM_NET_DISABLEIPV6=1` (seatbelt ปฏิเสธ v4-mapped IPv6 loopback ที่ VSTest testhost ใช้); ค่า env อื่นของ user คงอยู่ |
| `sandbox.filesystem.denyRead`, `denyWrite`, `allowWrite` | เติม credential path, system config ใต้ home ทั้งชุด (shell rc, `settings.json`, `config.toml`, hooks/rules/extensions ของทุก CLI, `~/.config/agents-adapter/config.yaml`; `denyWrite` เท่านั้น อ่านได้), development roots และ `always_writable` (temp + cache ของ toolchain + `~/.docker/buildx`); ข้อยกเว้นเดียว: `~/.claude/gh` ไม่อยู่ใน `denyRead` เพราะ gh subprocess ของ Claude เองต้องอ่าน (ยัง `denyWrite`, ยัง `Read(~/.claude/gh/**)`/`Edit(...)` deny และ `Bash(*/.claude/gh*)`/`Bash(*/.codex/gh*)` deny); `~/.codex/gh` ยัง `denyRead` |
| `sandbox.filesystem.allowRead` | `~/.claude/gh` เท่านั้น: Claude Code merge `permissions.deny` `Read(...)` เข้า `denyRead` ของ sandbox (schema: `Merged with paths from Read(...) deny permission rules`) การตัดออกจาก `denyRead` จึงไม่พอ; `allowRead` `takes precedence over denyRead` ทำให้ gh ใน sandbox อ่าน token ได้ ส่วน `Read`/`Edit` tool และ Bash pattern ยัง deny ตามเดิม (วัด: ไม่มี = `gh auth status` ตอบ `open ~/.claude/gh/config.yml: operation not permitted`) |
| `sandbox.credentials.files`, `sandbox.credentials.envVars` | เติม credential path/env var แบบ `mode: deny` (ยกเว้น `~/.claude/gh` ตามข้อบน) |
| `sandbox.excludedCommands` | เหลือ `codex *` (Codex CLI อ่าน `~/.codex/auth.json` ซึ่ง deny โดยตั้งใจ) และ `~/.claude/hooks/agents-adapter/agents-free-port.sh *` (wrapper ที่ต้องส่ง signal ข้าม sandbox); `gh *`, `docker *`, git network ops และรูป `rtk ...` ถูกถอดเพราะมี capability ทดแทนใน sandbox (`GH_CONFIG_DIR`, `allowMachLookup`, `allowUnixSockets`, `~/.docker/buildx`); permission rules ยังบังคับตามเดิม |
| `hooks/agents-adapter/agents-free-port.sh`, `hooks/agents-adapter/sandbox-probe.sh` | copy จาก `runtime/shared/` (mode 755) ลง dir ที่ Claude กัน sandbox เขียน; wrapper มี `permissions.allow` `Bash(<absolute path> *)` คู่กับ `excludedCommands`; probe ไม่อยู่ใน `excludedCommands` (ต้องวัดจากข้างใน) |
| `sandbox.network.allowedDomains` | เติม trusted domains + public registries |
| `autoMode.allow/soft_deny/hard_deny/environment` | entries ที่ขึ้นต้นด้วย `[agents-adapter] `; `$defaults` และ entries ของ user คงอยู่ |
| `autoMode.classifyAllShell` | `true` |
| `language` | `thai` |

key อื่น (`model`, `hooks`, `enabledPlugins`, `extraKnownMarketplaces`, `statusLine`, ...) ไม่ถูกแตะ; ใน `env` แตะเฉพาะ key ที่ระบุในตาราง

## พฤติกรรมที่บังคับใช้

- development env (`.env`, `.env.local`, ...) อ่านและแก้ได้; `cat .env` ถูก classifier (autoMode hard_deny) ปฏิเสธ
- production env และ credential ถูก deny ทั้ง `Read(...)`/`Edit(...)` rules และ sandbox `denyRead`/`denyWrite`/`credentials`
- `gh`, `git push/fetch/pull/clone`, `docker` รันใน sandbox: token จาก `~/.claude/gh`, TLS ผ่าน `allowMachLookup`, daemon ผ่าน `allowUnixSockets`; มีเพียง `codex` และ wrapper ที่รันนอก outer sandbox และยังผ่าน permission rules
- `~/.docker/config.json` ยัง deny: image จาก registry ที่ต้อง login ให้ user `docker pull` เองก่อน (daemon เก็บ image ไว้แล้ว build/compose ใน sandbox ใช้ต่อได้)
- `ps`/`top` เป็น setuid binary ซึ่ง seatbelt ปฏิเสธที่ exec (`operation not permitted: /bin/ps`, exit 127) ไม่มี key แก้; signal ไป process ของ user นอก tree ของ sandbox ถูกปฏิเสธเสมอ (`(allow signal (target same-sandbox))` ใน profile ของ Claude; วัด: `kill -0`/`-URG`/`-TERM` ไป `sleep` ที่เริ่มนอก sandbox ตอบ `kill 58855 failed: operation not permitted` ทุกแบบ) จึงมี wrapper `agents-free-port.sh <port>` ที่รันนอก sandbox และ kill เฉพาะ listener ที่ cwd อยู่ใน git work tree ปัจจุบัน (ไม่ fallback เป็น cwd, ปฏิเสธ `$HOME`/`/`, ปฏิเสธเมื่อถูกเรียกจากใน sandbox ด้วย exit 4)
- token ใน `~/.claude/gh` อ่านได้โดย process ทุกตัวใน sandbox (ข้อแลกเปลี่ยนเดียวกับ `~/.codex/gh` ของ Codex): ชั้น deterministic คือ `Read`/`Edit` deny, `Bash(*/.claude/gh*)`, `Bash(*/.codex/gh*)`, `Bash(*GH_CONFIG_DIR*)`, `Bash(*gh/hosts.yml*)` และ `denyWrite`; รูปที่เลี่ยง pattern ได้ (glob, `find -exec`, script ที่ open ไฟล์) เหลือ autoMode classifier ซึ่ง `environment` ระบุ dir นี้เป็น credential store; ใช้ fine-grained PAT ที่จำกัด repository และมีวันหมดอายุเพื่อจำกัดความเสียหายถ้า token หลุด
- bypass permission mode ถูกปิดผ่าน `disableBypassPermissionsMode`
- provider guard: เมื่อ `ANTHROPIC_BASE_URL` ชี้ host ที่ไม่ใช่ `api.anthropic.com` (เช่น proxy ไป GPT) การ spawn agent ใน `security_agent_types` (`auditor`, `skeptic`, `security-review`, ...) ถูก deny ด้วย `SECURITY_AGENT_PROVIDER` เพราะ content filter ของ provider อื่นตอบ 400 และแฟล็ก context ของ agent นั้นถาวร; hook fail-open เมื่อไม่มี python3 หรือไฟล์หาย

## GitHub setup สำหรับ Claude (ทำครั้งเดียว, user รันเอง)

`env.GH_CONFIG_DIR` ชี้ `~/.claude/gh` ตั้งแต่ apply: ถ้ายังไม่มี token ที่นั่น `gh` ทุกคำสั่ง (ทั้งใน/นอก sandbox) ตอบ `You are not logged into any GitHub hosts` และ `git push` ตาย `could not read Username`; `doctor` รายงาน `FAIL gh agent token (claude)` จนกว่าจะทำขั้นตอนนี้

1. สร้าง fine-grained PAT ที่ https://github.com/settings/personal-access-tokens: จำกัด repository ที่ Claude ต้องแตะ, permission `Contents: Read and write`, `Pull requests: Read and write`, `Workflows: Read and write`, `Metadata: Read`, ตั้งวันหมดอายุ (แนะนำ 90 วัน); ใช้ token คนละตัวกับของ Codex ได้เพื่อ revoke แยกกัน
2. เก็บลง config dir ของ agent (plaintext เฉพาะ dir นี้ ไม่แตะ keychain; copy token ไว้ใน clipboard ก่อน):

```bash
mkdir -p ~/.claude/gh && chmod 700 ~/.claude/gh
pbpaste | GH_CONFIG_DIR=~/.claude/gh gh auth login --with-token --insecure-storage
chmod 600 ~/.claude/gh/*.yml
GH_CONFIG_DIR=~/.claude/gh gh auth status
```

3. `node src/cli.ts apply --target claude --yes` (จาก terminal; รันจากใน Claude session ไม่ได้) แล้ว `node src/cli.ts doctor` ต้องได้ `PASS gh agent token (claude)`
4. เปิด Claude session ใหม่ (sandbox profile และ `env` อ่านตอนเริ่ม session) แล้วรัน `bash scripts/sandbox-probe.sh` ต้องไม่มี `FAIL`
5. ห้ามใช้ `gh auth refresh` กับ agent token (ย้าย token เข้า keyring ซึ่ง seatbelt อ่านไม่ได้; `doctor` จับเป็น `FAIL gh agent token storage (claude)`): rotate ด้วย logout แล้ว login ใหม่เหมือนข้อ 2

## Sandbox probe

`bash scripts/sandbox-probe.sh` วัด primitive ที่ policy พึ่งจริง (ไม่ผูกกับโปรเจกต์) จากใน Bash sandbox: เขียน/อ่าน repo, `$TMPDIR`, cache dir ของ toolchain ที่ติดตั้ง, `~/.docker/buildx`; bind/connect `127.0.0.1`, `::1`, `::ffff:127.0.0.1`; AF_UNIX ใน `$TMPDIR`/`/tmp`; docker daemon จาก process ลูก; `docker build --pull`; `gh auth status`; `pgrep`/`ps`/`lsof`/signal; wrapper; egress ไป registry ของแต่ละ ecosystem ที่มี toolchain

| ผล | ความหมาย |
|---|---|
| `PASS` | ทำงานได้ใน sandbox |
| `DENY(known)` | sandbox ปฏิเสธโดยตั้งใจหรือไม่มี key แก้ (`~/.npmrc`, `::ffff:127.0.0.1`, `/bin/ps`, signal ข้าม sandbox) พร้อมทางเดินต่อที่ managed block บอก agent ไว้ |
| `FAIL` | ต้องแก้: ยังไม่ apply, session เก่า, token ยังไม่ตั้ง หรือ regression; บรรทัด error จริงอยู่ท้ายบรรทัด |
| `SKIP` | toolchain นั้นไม่มีในเครื่อง ไม่นับเป็น pass |

## Evaluator

`src/adapters/claude/evaluate.ts` จำลองลำดับ deny -> ask -> allow ของ pattern ที่ generate (`Bash(prefix *)`, `Read(glob)`, `Edit(glob)`) แล้ว fallback เป็น classifier กลางเหมือน autoMode ทำให้ parity test จับได้ถ้า pattern กว้างเกินไปจน ALLOW case กลายเป็น DENY

## Idempotency

รัน `apply --target claude` ซ้ำโดยไม่มี policy change ได้ `no changes`; managed block ไม่ถูกสร้างซ้ำ (`tests/adapters/claude.test.ts`)

### ข้อจำกัดที่ไม่มี key แก้: `.git/config` ของ repo ปัจจุบัน

Claude ใส่ `<repo>/.git/config` และ `.git/hooks` ของ repo ที่ session เปิดอยู่ใน mandatory write-deny ของทุกคำสั่งใน sandbox (function `HRr` ใน binary 2.1.261) `allowWrite` ทับไม่ได้ และ option `allowGitConfig` ของ sandbox runtime ไม่ถูกอ่านจาก settings.json (Claude Code ส่งเฉพาะ `filesystem.{denyRead,allowRead,allowWrite,denyWrite,disabled}` เข้า runtime; ตั้งแล้ววัดใน session ใหม่ยัง `Operation not permitted`) ผลที่วัดได้:

| คำสั่ง | ผล |
|---|---|
| `git push -u origin <branch>` | push สำเร็จ exit 0 แต่พิมพ์ `could not lock config file .git/config: Operation not permitted` และไม่บันทึก upstream |
| `git branch -d <branch>` | ลบสำเร็จ พิมพ์ `update of config-file failed` (ล้าง upstream entry ไม่ได้) |
| `git remote add`, `git config --local`, `git switch --track` ใน repo ปัจจุบัน | ล้มเหลว exit 255 |
| `git init`, `git clone`, `--track` ใน repo อื่น (`$TMPDIR`, sibling ใน zone) | เขียนได้ปกติ |

แนวปฏิบัติ: push ด้วย `git push -u origin <branch>` ต่อไปได้ (ผลสำเร็จ) แต่คำสั่งถัดไปต้องระบุ remote/branch เอง เช่น `git pull --ff-only origin <branch>`; การตั้ง upstream หรือแก้ config ของ repo ปัจจุบันให้ user รันจาก terminal เอง; ข้อความ `fatal: failed to store: -60008` ที่ตามมาเป็น credential helper `osxkeychain` เก็บ token ลง keychain ไม่ได้ใน sandbox ไม่กระทบผล
