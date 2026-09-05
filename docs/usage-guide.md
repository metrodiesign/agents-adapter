# คู่มือการใช้งาน

วิธีใช้ agents-adapter ในแต่ละสถานการณ์: ติดตั้งครั้งแรก, อัปเดต policy, ใช้งานผ่าน Claude Code, Codex CLI และ Pi CLI รวมถึงข้อจำกัดที่พบจากการใช้งานจริง

## คำสั่งหลัก

รันจาก root ของ repository agents-adapter ทุกคำสั่ง

| คำสั่ง | ทำอะไร | แตะไฟล์ |
|---|---|---|
| `node src/cli.ts init` | สร้าง `~/.config/agents-adapter/config.yaml` จาก example (ไม่ทับถ้ามีแล้ว) | สร้าง config |
| `node src/cli.ts plan --target all` | แสดงไฟล์ที่จะสร้าง/แก้, managed keys, preserved keys | ไม่แตะ |
| `node src/cli.ts diff --target claude` | บรรทัดที่เพิ่ม/ลบต่อไฟล์ | ไม่แตะ |
| `node src/cli.ts apply --target all --yes` | backup แล้วเขียนไฟล์ native ของแต่ละ CLI | เขียน |
| `node src/cli.ts doctor` | PASS/WARN/FAIL/UNSUPPORTED, policy drift, parity | ไม่แตะ |
| `node src/cli.ts verify` | รัน fixture ทุกตัวผ่านทั้งสาม adapter | ไม่แตะ |
| `scripts/rollback.sh` | คืนไฟล์จาก backup ล่าสุด | เขียน |
| `scripts/uninstall.sh` | ถอน managed content (backup ก่อน) | เขียน |

`--target` รับ `claude`, `codex`, `pi` หรือ `all`

## ติดตั้งครั้งแรก

1. `scripts/install.sh` — ตรวจ Node 24+, `npm ci`, `init`, `plan`, ถาม `[y/N]`, `apply`, `doctor`
2. แก้ `~/.config/agents-adapter/config.yaml` อย่างน้อย 3 ค่า แล้วรัน `scripts/install.sh --yes` อีกครั้ง

```yaml
development_roots:
  - ${HOME}/Desktop/Project
github:
  owner: "your-github-user"
trusted_domains:
  - github.com
  - api.github.com
  - registry.npmjs.org
  - localhost
  - 127.0.0.1
```

ถ้าข้ามข้อ 2 ผลลัพธ์จะมีข้อความ `YOUR_GITHUB_USER` ค้างใน autoMode ของ Claude และ context ของ Codex/Pi จนกว่าจะแก้ config แล้ว apply ใหม่ (managed state ลบ entry เก่าให้เอง)

## อัปเดต policy หลัง pull

1. `git pull --ff-only origin main`
2. `node src/cli.ts plan --target all` — อ่านรายการ modify ก่อนทุกครั้ง
3. `node src/cli.ts apply --target all --yes`
4. `node src/cli.ts doctor` — ต้องได้ `policy drift` PASS ครบสาม CLI และ `CLAUDE.md user rules (claude)` PASS: ส่วนที่ user เขียนเองใน `~/.claude/CLAUDE.md` (เหนือ managed block) ที่ยังบอกว่า `gh *`/`docker *` รันนอก sandbox ผ่าน `excludedCommands` หรือให้เพิ่ม binary ที่เจอ `-26276` ใน `excludedCommands` ต้องแก้เองให้ตรง managed block

ไฟล์ที่ apply แก้เป็นประจำเมื่อ policy เปลี่ยน: `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.codex/hooks/agents-adapter/agents-adapter.config.json`, `~/.pi/agent/extensions/agents-adapter-lib/config.json`

## ใช้งานผ่าน Claude Code

ไม่ต้องตั้งค่าเพิ่ม: `permissions`, `sandbox`, `autoMode`, `env` ถูก merge เข้า `~/.claude/settings.json`; `permissions` และ `autoMode` มีผลทันที แต่ `sandbox` (filesystem/network/excludedCommands) และ `env` ถูกอ่านตอนเริ่ม session ต้องเปิด Claude session ใหม่หลัง apply

### รัน apply จากใน Claude session ไม่ได้

Claude Code กันไฟล์ของตัวเอง (`~/.claude/settings.json`, hooks, agents) จาก Bash sandbox และ auto mode classifier จะ block การเขียนนอก sandbox ด้วย ให้ user พิมพ์คำสั่งเองด้วย `!` prefix

```bash
! cd /path/to/agents-adapter && node src/cli.ts apply --target claude --yes
```

`plan`, `diff`, `doctor`, `verify` รันจากใน session ได้ปกติ

### คำสั่งที่ต้องออกนอก Bash sandbox

`sandbox.excludedCommands` เหลือ 2 pattern; ที่เหลือมี capability ทดแทนใน sandbox (ตารางถัดไป) การออกนอก sandbox ไม่ใช่ bypass permission: permission rules และ classifier ยังบังคับตามเดิม

| pattern | เหตุผล |
|---|---|
| `codex *` | Codex CLI อ่าน `~/.codex/auth.json` (credential path ที่ deny โดยตั้งใจ) และใช้ sandbox ของตัวเอง |
| `${HOME}/.claude/hooks/agents-adapter/agents-free-port.sh *` (absolute path) | ต้องส่ง signal ไป process นอก tree ของ sandbox; ไฟล์อยู่ใน dir ที่ Claude กัน sandbox เขียน (และ `denyWrite` กัน `~/.codex/hooks` ฝั่ง Codex); agent ต้องเรียกด้วย absolute path ตรง ๆ ไม่มี `bash` นำหน้า ไม่ใช้ `~` ไม่งั้นคำสั่งไม่ match แล้ว wrapper ตอบ `refused: running inside the sandbox` exit 4 |

capability ที่แทน entry เดิม (ทุกค่ามาจาก `policy/trusted-defaults.yaml` และ `protected-paths.yaml`):

| entry เดิม | ทดแทนด้วย | หลักฐาน |
|---|---|---|
| `gh *`, `rtk gh *` | `env.GH_CONFIG_DIR=~/.claude/gh` (agent token) + `allowMachLookup: com.apple.trustd.agent` (Go TLS) | token ปลอมใน dir ที่ sandbox อ่านได้: `gh api user` ตอบ `Bad credentials` เมื่อเปิด trustd, `x509: OSStatus -26276` เมื่อไม่เปิด |
| `git push/fetch/pull/ls-remote/clone *`, `rtk git fetch/pull *` | `GH_CONFIG_DIR` เดียวกัน (git เรียก `gh auth git-credential` เป็น process ลูก) | `git ls-remote <private>` ใน sandbox ตอบ `Invalid username or token` (helper ทำงาน) แทน `could not read Username` |
| `docker *`, `rtk docker *` | `allowUnixSockets` (daemon) + `~/.docker/buildx` ใน `allowWrite` + trustd (registry token) | `docker build --pull` ผ่านใน seatbelt profile เดียวกับ Claude เมื่อมีทั้งสอง; ขาด buildx = `failed to update builder last activity time`, ขาด trustd = `failed to fetch anonymous token ... -26276` |
| `dotnet test *` | `env.DOTNET_SYSTEM_NET_DISABLEIPV6=1` + AF_UNIX ใน `/tmp` | PR #43 |

ข้อจำกัดของ pattern matching ที่ยังอยู่:

- match ต่อ segment (`;`, `&&`, `|`): segment เดียวที่ match ยกทั้งบรรทัดออกนอก sandbox; process ลูกของ script ไม่เคยได้รับการยกเว้น
- rtk hook (Rust Token Killer) rewrite `git fetch`, `git pull`, `gh`, `docker` เป็น `rtk ...` ซึ่งตอนนี้ไม่มีผลกับ sandbox แล้วเพราะทุกตัวรันข้างในได้

### ตรวจ sandbox หลัง apply

sandbox profile และ `env` ถูกอ่านตอนเริ่ม session: หลัง `apply --target claude` ให้เปิด Claude session ใหม่แล้วรัน

```bash
bash ~/.claude/hooks/agents-adapter/sandbox-probe.sh   # ติดตั้งโดย apply; หรือ bash scripts/sandbox-probe.sh จาก repo นี้
```

ต้องไม่มี `FAIL`; `DENY(known)` คือข้อจำกัดที่ policy บอก agent ไว้แล้ว (`/bin/ps` setuid, signal ข้าม sandbox, `~/.npmrc`, `::ffff:127.0.0.1`) และ `SKIP` คือ toolchain ที่เครื่องไม่มี รายละเอียดใน `docs/claude-adapter.md`

### Trust Zone ใน Claude

| path | อ่าน | แก้ |
|---|---|---|
| repository ใต้ `development_roots` และ cwd | ALLOW | ALLOW |
| `~/.claude`, `~/.codex`, `~/.pi` (ไฟล์ทั่วไป เช่น agents, skills) | ALLOW | ALLOW |
| ไฟล์ที่ adapter จัดการ (`settings.json`, `config.toml`, hooks, rules, extensions) และ `~/.config/agents-adapter/config.yaml` | ALLOW | ASK |
| นอก zone | ASK | ASK |
| credential path, `.env.production*` | DENY | DENY |

### Security agent บน profile ที่ใช้ proxy

profile ที่ตั้ง `ANTHROPIC_BASE_URL` ไป provider อื่น (เช่น `claudex` ผ่าน cliproxyapi ไป GPT) ห้ามรัน `auditor`, `skeptic`, `security-review`: hook `provider_guard.py` จะ deny ทันทีพร้อมเหตุผล ให้ย้ายงาน audit ไปรันใน session `claude` ปกติแทน ถ้า agent ตัวเดิมโดน `400 ... flagged for possible cybersecurity risk` แล้ว ให้ kill และ spawn ใหม่เท่านั้น การ retry หรือ resume ไม่มีทางผ่าน

## ใช้งานผ่าน Codex CLI

รัน `codex` ตรง ๆ ได้ทันที profile default คือ `Auto mode`

| profile | ใช้เมื่อ | วิธีเรียก |
|---|---|---|
| `Auto mode` | งานพัฒนาปกติใน Development Trust Zone | `codex` |
| `:workspace` | workspace-write โดยไม่มี network/path พิเศษ | `codex --sandbox workspace-write` |
| `:read-only` | review หรือวิเคราะห์ | `codex --sandbox read-only` |
| `:danger-full-access` | ปิดถาวรใน `requirements.toml` | ใช้ไม่ได้ |

สิ่งที่ต้องทำครั้งแรกหลัง apply:

1. เปิด `codex` หนึ่งครั้งแล้วยอมรับ hook ใหม่ (Codex เก็บ trusted hash ใน `hooks.state`)
2. `node src/cli.ts doctor` ต้องได้ `hook trust (codex)` PASS
3. `codex doctor` ยืนยันว่า `requirements.toml` ถูกโหลด

ชั้นบังคับใช้: DENY มาจาก PreToolUse hook `policy_gate.py`, ASK มาจาก `rules/default.rules` และ `auto_review.policy`, GitHub connector tools ที่ merge/delete/update ref ตั้ง `approval_mode = "prompt"`

## ใช้งานผ่าน Pi CLI

extension ถูกโหลดอัตโนมัติจาก `~/.pi/agent/extensions` ห้ามรันด้วย `--no-extensions` หรือ `-ne` (policy gate หาย)

| mode | คำสั่ง | credential boundary |
|---|---|---|
| host-macos (default) | `pi` | best-effort: extension ตรวจได้เฉพาะ argument ของ tool call |
| docker | `scripts/pi-isolated.sh docker` จาก root ของ repository | hard: mount เฉพาะ cwd + extension แบบ read-only |
| gondolin, openshell | `scripts/pi-isolated.sh gondolin` หรือ `openshell` | hard เมื่อเครื่องมี runtime |

ASK บน Pi ใช้ `ctx.ui.confirm()` ถ้ารันแบบ print/rpc mode ที่ไม่มี UI จะกลายเป็น block (fail closed)

## แก้ policy กลาง

1. แก้ `policy/*.yaml` หรือ `src/core/classifier.ts` (mirror ใน `runtime/codex/hooks/agents_adapter_policy.py` เมื่อแตะ logic)
2. เพิ่ม fixture ใน `tests/fixtures/actions.json`
3. `node src/cli.ts generate-check` เพื่อ regenerate `tests/fixtures/generated`
4. `npm run check` ต้องผ่าน
5. เปิด PR เข้า `main` แล้ว apply บนเครื่องหลัง merge

## Rollback

```bash
scripts/rollback.sh --check          # รายการ backup
scripts/rollback.sh                  # คืนจาก backup ล่าสุดแบบ transaction
scripts/rollback.sh --backup <id>    # คืนจาก backup ที่ระบุ
```

backup อยู่ที่ `~/.local/state/agents-adapter/backups/<timestamp>/` และไม่ถูกลบหลัง rollback
