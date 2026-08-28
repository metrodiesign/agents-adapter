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
4. `node src/cli.ts doctor` — ต้องได้ `policy drift` PASS ครบสาม CLI

ไฟล์ที่ apply แก้เป็นประจำเมื่อ policy เปลี่ยน: `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.codex/hooks/agents-adapter/agents-adapter.config.json`, `~/.pi/agent/extensions/agents-adapter-lib/config.json`

## ใช้งานผ่าน Claude Code

ไม่ต้องตั้งค่าเพิ่ม: `permissions`, `sandbox`, `autoMode` ถูก merge เข้า `~/.claude/settings.json` และ Claude โหลดใหม่ทันทีหลัง apply โดยไม่ต้องเปิด session ใหม่

### รัน apply จากใน Claude session ไม่ได้

Claude Code กันไฟล์ของตัวเอง (`~/.claude/settings.json`, hooks, agents) จาก Bash sandbox และ auto mode classifier จะ block การเขียนนอก sandbox ด้วย ให้ user พิมพ์คำสั่งเองด้วย `!` prefix

```bash
! cd /path/to/agents-adapter && node src/cli.ts apply --target claude --yes
```

`plan`, `diff`, `doctor`, `verify` รันจากใน session ได้ปกติ

### คำสั่งที่ต้องออกนอก Bash sandbox

`sandbox.excludedCommands` รัน CLI ที่ต้องใช้ keychain หรือ credential helper นอก outer sandbox แต่ permission rules และ classifier ยังบังคับตามเดิม

| pattern | เหตุผล |
|---|---|
| `gh *`, `rtk gh *` | อ่าน `~/.config/gh` ซึ่ง sandbox deny |
| `git push *`, `git fetch *`, `git pull *`, `git ls-remote *`, `git clone *` | git เรียก `gh auth git-credential` เป็น subprocess |
| `rtk git fetch *`, `rtk git pull *` | rtk hook rewrite คำสั่ง git ก่อนถึง sandbox |
| `docker *`, `rtk docker *` | ใช้ Docker socket |
| `codex *`, `dotnet test *` | runtime ของตัวเอง |

ข้อจำกัดของ pattern matching:

- match ทั้งบรรทัด: `cd repo && gh pr view 1` หรือ `gh pr checks 1 | tail` ไม่ match `gh *` ต้องรัน `gh` เป็นคำสั่งเดี่ยว
- rtk hook (Rust Token Killer) rewrite `git fetch`, `git pull`, `gh`, `docker` เป็น `rtk ...` แต่ไม่ rewrite `git push`, `git clone`, `git ls-remote`, `docker compose`, `codex`
- อาการเมื่อไม่ match: `failed to read configuration: open ~/.config/gh/config.yml: operation not permitted` ตามด้วย `fatal: could not read Password` (gh อ่าน config ตัวเองไม่ได้ จึงให้รหัสผ่าน git ไม่ได้)

### Trust Zone ใน Claude

| path | อ่าน | แก้ |
|---|---|---|
| repository ใต้ `development_roots` และ cwd | ALLOW | ALLOW |
| `~/.claude`, `~/.codex`, `~/.pi` (ไฟล์ทั่วไป เช่น agents, skills) | ALLOW | ALLOW |
| ไฟล์ที่ adapter จัดการ (`settings.json`, `config.toml`, hooks, rules, extensions) และ `~/.config/agents-adapter/config.yaml` | ALLOW | ASK |
| นอก zone | ASK | ASK |
| credential path, `.env.production*` | DENY | DENY |

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
