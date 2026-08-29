<!-- agents-adapter:start -->
# agents-adapter managed policy (Codex CLI)

block นี้ถูกสร้างโดย agents-adapter 0.1.0 จาก policy กลาง; behavioral policy เท่านั้น
hard boundary ถูกบังคับใช้ผ่าน hooks (`policy_gate.py`), `rules/default.rules`, permission profile และ `requirements.toml`

## กฎภาษา

- ตอบ user เป็นภาษาไทยทุกข้อความ; code, identifier, command, path, flag, error/log และ technical term คงภาษาอังกฤษ
- ไฟล์ `.md` ที่สร้างหรือแก้เป็นภาษาไทยเป็นหลัก ห้าม emoji

## Development Trust Zone

```text
${HOME}/Desktop/Project
```

ในเขตนี้ทำงาน routine ได้โดยไม่ขอ approval: อ่าน/แก้ source, build, test, lint, formatter, code generation, dependency แบบ project-local, local Docker, `git status/diff/add/commit/fetch`, `git pull --ff-only`, push feature branch ที่ระบุชื่อ, สร้าง/อัปเดต PR, issue, comment และดู CI

development env (.env, .env.local, .env.development, .env.test, .env.testing, .env.integration) อ่านและแก้ได้ แต่ห้ามพิมพ์ค่า secret และห้าม commit

## ต้องขอ approval หนึ่งครั้งต่อ action + target

`rm -rf` ที่ target เป็น zone root, repository root, `.git`, glob หรือ path นอก Trust Zone (ลบไฟล์/directory ภายใน workspace ไม่ต้องถาม), `git reset --hard`, `git clean -f`, ลบ branch/tag แบบบังคับ, ลบ remote branch, สร้าง/push tag, สร้างหรือแก้ GitHub release, `gh pr merge` (merge เป็น user decision ต้องยืนยันทุกครั้ง), destructive database, Docker prune/volume removal, global package install, shell startup file, git remote change, GitHub auth change, path นอก Trust Zone, staging deploy และ production operation ทุกชนิด (production ต้องมี target, impact, backup, rollback, verification plan)

approval ที่ได้รับใช้กับขั้นตอนต่อเนื่องของงานย่อยเดียวกันได้ ห้ามขยายไป target อื่น

## Hard boundary (DENY) ที่ hook บังคับใช้

- push ตรงเข้า main, develop, bare `git push`, push ด้วย `HEAD`, force push ทุกแบบ
- `gh repo delete`, `gh gist`, `gh secret`, `gh auth token`, `gh auth status --show-token`
- GitHub connector: protected-ref update; `merge_pull_request`, `enable_auto_merge`, `delete_file` ต้องมี approval
- อ่าน/แก้ credential file, keychain และ production env (.env.production, .env.production.*, .env.prod, .env.prod.*)
- production database ทุกชนิด (client ที่ชี้ host/db ที่มี prod/production ในชื่อ, destructive migration ด้วย `--env=production`)
- เขียน/ลบใต้ OS system path (`/System`, `/Library`, `/etc`, `/usr`, `/opt`, `/bin`, `/sbin`)
- `--dangerously-bypass-approvals-and-sandbox`, `--sandbox danger-full-access`, bypass flag อื่น
- `sudo`, pipe จาก curl/wget เข้า shell
- spawn security agent (auditor, skeptic, security-review) เมื่อ `ANTHROPIC_BASE_URL` ชี้ provider ที่ไม่ใช่ Anthropic (`SECURITY_AGENT_PROVIDER`); agent ที่โดน content filter 400 แล้วต้อง kill และ spawn ใหม่ ห้าม resume

## Sandbox และ credential CLI

- deny entry ของ permission profile เป็น escalatable=false: `sandbox_permissions: "require_escalated"` ไม่ช่วยให้อ่าน path ที่ deny ได้ ห้ามใช้เป็นทางแก้
- `~/.config/gh` เปิด read ให้ sandbox เฉพาะเพื่อให้ `gh` อ่าน config ของตัวเองได้; agent ห้ามอ่าน แสดง หรือคัดลอกไฟล์ในนั้นเอง (hook DENY `CREDENTIAL_READ`)
- token ของ user ใน `~/.config/gh` อยู่ใน macOS keychain ซึ่ง seatbelt ของ Codex ปิดทุกโหมด (แม้ escalated) จึงใช้ agent token แยก: `GH_CONFIG_DIR=~/.codex/gh` (ค่าจริงเป็น absolute path) ถูกตั้งให้ทุก shell command แล้ว `gh`, `git push <feature>`, `git pull/fetch/clone` ทำงานใน sandbox ได้เลย ไม่ต้อง escalation ไม่ต้อง `unset GH_TOKEN`
- agent ห้ามอ่าน แสดง คัดลอก หรือแก้ `~/.codex/gh` (hook DENY `CREDENTIAL_READ`); ห้าม `gh auth token`; ห้ามใส่ token ใน env หรือ command
- ถ้า `gh` ตอบ `HTTP 401` / `Bad credentials` / `gh auth login` หรือ `git push` ตาย `could not read Username` แปลว่า agent token ยังไม่ได้ตั้งหรือหมดอายุ: ห้ามวน retry ห้าม `gh auth login` เอง ให้ commit บน feature branch แล้วรายงาน user ให้รัน setup ใน docs/codex-adapter.md (GitHub) หรือ push จาก Claude Code/terminal
- `docker`, `dotnet test` และ command ที่ติด sandbox ด้วยเหตุอื่น (socket, loopback) ยังใช้ `sandbox_permissions: "require_escalated"` ได้ตาม rule

## GitHub

- ใช้ GitHub connector หรือ GitHub app เป็นช่องทางหลักเมื่อมี; local `gh` เป็น fallback
- ห้ามพิมพ์ token; ห้ามอ่าน `~/.config/gh` เอง ให้ `gh` อ่านภายในตัวเอง
- merge, auto-merge, delete-file, release/tag และ protected-ref เป็นการตัดสินใจของ user: hook ให้ ASK ต้องรอ user ยืนยันก่อนเสมอ

## หลัง agents-adapter apply

- Codex อ่าน `config.toml`, `rules/*.rules` และ `auto_review.policy` ตอนเริ่ม process เท่านั้น: session ที่เปิดอยู่ (รวม subagent thread) ยังใช้ policy เก่า ถ้าเจอ deny/prompt ที่ไม่ตรง policy ปัจจุบัน ให้ user ปิดแล้วเปิด `codex` ใหม่ก่อน ห้ามวน retry

## Retry และ completion

- failure เดิมซ้ำสองครั้งให้เปลี่ยน hypothesis หรือ tool
- action ถูก block ให้ทำส่วนที่ไม่ขึ้นต่อกันให้ครบ แล้วรายงาน blocker ที่แคบที่สุด
- ก่อนประกาศสำเร็จต้องมี test/build/lint evidence และระบุสิ่งที่ยังไม่ได้ verify
<!-- agents-adapter:end -->
