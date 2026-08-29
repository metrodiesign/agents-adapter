# Codex Adapter

## ไฟล์ที่ generate

| ไฟล์ | วิธี merge |
|---|---|
| `~/.codex/config.toml` | parse TOML -> แก้ managed keys -> stringify (comment ในไฟล์เดิมหาย; backup เก็บต้นฉบับ) |
| `~/.codex/requirements.toml` | managed keys `allowed_permission_profiles`, `allowed_sandbox_modes`, `allowed_approval_policies`, `allowed_approvals_reviewers` |
| `~/.codex/hooks.json` | เติม entries ที่ command ชี้ `hooks/agents-adapter/`; entries ของ user คงอยู่ |
| `~/.codex/hooks/agents-adapter/*.py` + `~/.codex/hooks/agents-adapter.config.json` | copy จาก `runtime/codex/hooks` + serialized PolicyContext |
| `~/.codex/rules/default.rules` | managed block ระหว่าง `# agents-adapter:start/end` |
| `~/.codex/AGENTS.md` | managed block (behavioral policy เท่านั้น) |

## การแก้ conflict

| conflict | การจัดการ |
|---|---|
| `default_permissions` + `sandbox_mode` | ลบ `sandbox_mode`; Codex ปฏิเสธเมื่อทั้งสองถูกตั้งพร้อมกัน |
| `sandbox_mode = "danger-full-access"` | ลบ และ `requirements.toml` ตั้ง `":danger-full-access" = false` |
| `filesystem."/" = "read"` | ลบ; ใช้ development roots, toolchain read paths, cache paths แทน |
| `filesystem."~/.config/gh"` | คง `read` (เขียนทับเป็น read ถ้า user ตั้ง deny): deny entry ใน managed profile เป็น escalatable=false จึงไม่มีทางให้ `gh`/`gh auth git-credential` รันนอก sandbox แบบ `excludedCommands` ของ Claude; agent ห้ามอ่านเองผ่าน hook `CREDENTIAL_READ` DENY และ rule `gh auth token` forbidden |
| `workspace_roots."**/.env*" = "deny"` | ลบ (development env ต้องอ่านและแก้ได้) เหลือ deny เฉพาะ production env, key/pem, auth/credentials file |
| `[apps.<connector>.tools."github.*"]` | ตรวจจับ connector แบบ dynamic (key ใด ๆ ใน `[apps]` ที่มี tool ขึ้นต้น `github.`) แล้วตั้ง `merge_pull_request`, `enable_auto_merge`, `delete_file`, `update_ref` เป็น `approval_mode = "prompt"`; ไม่ hardcode connector id |

ค่าที่คง: `approval_policy = "on-request"`, `approvals_reviewer = "auto_review"`, `default_permissions = "Auto mode"`

## Hooks

| event | matcher | script | ผล |
|---|---|---|---|
| PreToolUse | `.*` | `policy_gate.py` | DENY -> exit 2 + เหตุผลบน stderr; ASK -> `additionalContext` บอก rule/target; ALLOW -> เงียบ |
| PreToolUse | `Read|Write|Edit|MultiEdit|apply_patch|read_file|write_file` | `protected_paths.py` | ชั้นที่สอง: credential/prod env DENY แม้ gate หลักถูกปิด |
| SessionStart | `startup|resume` | `startup_preflight.py` | additionalContext: trust zone, protected branches, ภาษา |
| Stop | - | `lang_guard.py` | เตือนเมื่อคำตอบไม่มีภาษาไทย |

`policy_gate.py` ตรวจ: shell command (ทุก tool ที่มี `command`), git refspec, protected branch, force flag, credential path, production env path, destructive DB command, public share/gist, bypass flag, GitHub connector tool name (`github.*`, `mcp__github__*`) และ `apply_patch` file headers

hook ทำงานหลังจาก user trust ใน Codex (hooks.state trusted_hash); doctor รายงาน WARN จนกว่าจะ trust

## ASK บน Codex

PreToolUse hook ของ Codex รองรับ `permissionDecision` เฉพาะ `allow`/`deny` จึง:

- `rules/default.rules` มี `prefix_rule(... decision = "prompt")` ทุก ASK class ที่เขียนเป็น prefix ได้
- `auto_review.policy` มี managed block ที่อนุญาตเฉพาะ action + target ที่ระบุใน request ปัจจุบัน และห้าม merge/credential/force/production
- hook เติม `additionalContext` ให้ model ขอ approval สำหรับ target นั้น

ข้อจำกัด: Codex ข้ามการประเมิน rules เมื่อ command มี substitution/env prefix; hook จึงเป็นชั้นหลักเสมอ

## Filesystem

profile `Auto mode` extends `:workspace` และกำหนดเฉพาะ: development roots (write), credential paths (deny), `~/.gitconfig`, `~/.config/git`, `~/.codex/{hooks,rules,skills}` (read), `~/.codex/tmp`, `~/.cache`, `~/.npm` (write), `~/.nvm/versions/node`, `/opt/homebrew`, `/usr/local` (read)

## GitHub

- GitHub connector/app เป็นช่องทางหลักถ้ามี; local `gh` เป็น fallback
- block: `gh auth token`, `gh auth status --show-token`, `gh pr merge`, `gh repo delete`, `gh gist`, `gh secret` ทั้งใน hook และ rules (`forbidden`)
- ข้อจำกัด Codex 0.150.1: token ของ `gh` ใน `~/.config/gh` อยู่ใน macOS keychain (`gh auth status` = `(keyring)`) แต่ seatbelt ของ Codex ปฏิเสธ `file-read-metadata ~/Library/Keychains/login.keychain-db` และ `ipc-posix-shm-write-create com.apple.AppleDatabaseChanged` (base policy ไม่มี key ให้เปิด) และ escalation ก็ยังบังคับ deny entry ของ profile ดังนั้น keychain ใช้ไม่ได้ทุกโหมด และไม่เปิด keychain ให้ sandbox เพราะเป็น credential store
- ทางแก้: agent token แยกใน `~/.codex/gh` (permission profile `read`, `shell_environment_policy.set.GH_CONFIG_DIR` ชี้ไปที่นั่น, `GH_NO_UPDATE_NOTIFIER=1` กัน gh เขียน state) ทำให้ `gh` และ `gh auth git-credential` (git push/pull/fetch) ทำงานใน sandbox โดยไม่ต้อง escalation; agent ยังอ่าน dir นี้ไม่ได้ (`credential_paths` -> hook DENY ทั้ง Claude/Codex/Pi) และ `doctor` ตรวจว่า `hosts.yml` มีอยู่และ mode 600 โดยไม่พิมพ์เนื้อหา

### GitHub setup สำหรับ Codex (ทำครั้งเดียว, user รันเอง)

1. สร้าง fine-grained PAT ที่ https://github.com/settings/personal-access-tokens: จำกัด repository ที่ Codex ต้องแตะ, permission `Contents: Read and write`, `Pull requests: Read and write`, `Metadata: Read`, ตั้งวันหมดอายุ (แนะนำ 90 วัน) ไม่ใช้ token ของ user เอง
2. เก็บลง config dir ของ agent (เขียน `hosts.yml` แบบ plaintext เฉพาะ dir นี้ ไม่แตะ keychain):

```bash
mkdir -p ~/.codex/gh && chmod 700 ~/.codex/gh
pbpaste | GH_CONFIG_DIR=~/.codex/gh gh auth login --with-token --insecure-storage
chmod 600 ~/.codex/gh/*.yml
GH_CONFIG_DIR=~/.codex/gh gh auth status
```

3. `agents-adapter apply --target codex` แล้ว `agents-adapter doctor` ต้องได้ `PASS gh agent token (codex)`
4. เมื่อ token หมดอายุหรือต้อง rotate: ลบ token ใน GitHub แล้วรันข้อ 2 ใหม่; `hosts.yml` ไม่อยู่ใน backup ของ agents-adapter

## Evaluator

`src/adapters/codex/evaluate.ts` spawn `python3 policy_gate.py` ด้วย PreToolUse payload จริง แล้วรวมกับ prefix rules ที่ generate (strictest wins) parity test จึงทดสอบทั้ง Python implementation และ rules
