# Changelog

รูปแบบตาม Keep a Changelog; เวอร์ชันตาม Semantic Versioning

## [Unreleased]

### Added

- rule `SECURITY_AGENT_PROVIDER` (DENY) และ `AGENT_SPAWN` (ALLOW): ห้าม spawn security agent (`auditor`, `skeptic`, `security-review`, ...) เมื่อ `ANTHROPIC_BASE_URL` ชี้ provider ที่ไม่ใช่ Anthropic เพราะ content filter แฟล็ก context ถาวร; Claude ใช้ hook ใหม่ `hooks/agents-adapter/provider_guard.py` (PreToolUse `^(Agent|Task)$`, entry ใน `settings.json.hooks` เป็น managed), Codex/Pi ใช้ classifier เดิมที่อ่าน env; fixture 11 กรณี

- `docs/usage-guide.md` คู่มือใช้งานต่อสถานการณ์และต่อ CLI; troubleshooting เพิ่มอาการ sandbox/rtk/classifier ที่พบจากการใช้งานจริง

### Changed

- Claude `sandbox.excludedCommands` เพิ่ม `git push *`, `git fetch *`, `git pull *`, `git ls-remote *`, `git clone *` (และ `rtk git fetch *`, `rtk git pull *`, `rtk gh *`, `rtk docker *` สำหรับคำสั่งที่ rtk hook rewrite) เพราะ git เรียก `gh auth git-credential` เป็น subprocess ที่อ่าน `~/.config/gh` ไม่ได้ใน sandbox ทำให้ private repo ใน Development Trust Zone fetch/pull/push ไม่ได้; deny ของ push main/develop, bare/force push ยังบังคับผ่าน `permissions.deny`
- ไฟล์ที่ agents-adapter จัดการเอง (Claude `settings.json`/hooks, Codex `config.toml`/`requirements.toml`/`hooks.json`/hooks/rules, Pi extensions/isolation) ย้ายเป็น `system_config_paths`: อ่านได้ แต่แก้ต้อง ASK แทน ALLOW เพื่อกัน agent แก้ gate ของตัวเอง
- `~/.config/agents-adapter/config.yaml` ไม่ใช่ credential แล้ว (อ่านได้, แก้ต้อง ASK) ทำให้รัน `plan`/`diff`/`doctor` จากใน agent session ได้
- `SHELL_SUBSTITUTION` ผ่อนให้ `$(git <query>)` ที่ query อยู่ใน `rev-parse`, `merge-base`, `show-ref`, `rev-list` และ flag อยู่ใน allowlist (ไม่มี `--format`/`--sq-quote` ที่คุม output ได้) ไม่ต้อง ASK เมื่อ segment นั้นไม่มี substitution อื่น, redirect ไม่มี substitution และ command นอกไม่ใช่ print/write/delete หรือ `git push` (เช่น `python3 scripts/x.py --base $(git merge-base develop HEAD)` เป็น ALLOW; `cat $(git rev-parse --show-toplevel)/x` และ `git push origin $(git branch --show-current)` ยัง ASK); fixture 7 กรณี

### Fixed

- `doctor`: รันจากใน Bash sandbox ของ Claude (`CLAUDECODE`) หรือ Codex (`CODEX_SANDBOX`) แล้ว `Docker availability`/`GitHub auth status` ขึ้น WARN ปลอมเพราะ socket และ `~/.config/gh` ถูก sandbox ปิด ตอนนี้รายงาน UNSUPPORTED พร้อมบอกให้รันจาก terminal; `generated hash drift` ที่ไฟล์ merge (`config.toml`, `hooks.json`, `settings.json`) ถูก Codex/Claude เขียน key ของตัวเอง (`trusted_hash` ฯลฯ) แต่ render ใหม่ยังเท่าไฟล์จริง เปลี่ยนจาก WARN เป็น PASS `edited outside managed keys only`
- Codex: `gh`/`git push` ยังตายหลัง `~/.config/gh` เป็น read (`HTTP 401: Requires authentication`, `could not read Username ... Device not configured`) เพราะ token อยู่ใน macOS keychain ซึ่ง seatbelt ของ Codex 0.150.1 ปิดทั้งใน sandbox และ escalated (denial: `file-read-metadata ~/Library/Keychains/login.keychain-db`, `ipc-posix-shm-write-create com.apple.AppleDatabaseChanged`); ไม่เปิด keychain ให้ sandbox แต่ AGENTS.md managed block เปลี่ยนเป็นสั่งให้ Codex หยุดที่ commit แล้ว handoff การ push/เปิด PR ให้ user หรือ Claude Code และห้ามวน retry/`unset GH_TOKEN`/escalation/`--insecure-storage`; troubleshooting เพิ่มอาการนี้
- Codex: `~/.config/gh` กลับเป็น `read` ใน permission profile (เคยถูกแปลงเป็น `deny` ตอน migrate): พิสูจน์จาก session จริงว่า deny entry ของ managed profile เป็น `escalatable="false"` ใน Codex 0.150 ทำให้ `sandbox_permissions: "require_escalated"` + allow rule ก็ยังอ่านไม่ได้ `gh` และ `gh auth git-credential` (git push) จึงตายเสมอ (`could not read Username`); agent ยังห้ามอ่านไฟล์เองผ่าน hook `CREDENTIAL_READ` DENY และ rule `gh auth token` forbidden; AGENTS.md managed block เลิกแนะนำ escalation สำหรับ gh
- Codex: `gh` (และ `git push/pull/ls-remote/clone`, `docker`, `dotnet test`) ตายใน sandbox ด้วย `open ~/.config/gh/config.yml: operation not permitted` เพราะ permission profile deny path นั้น (ตั้งใจ) แต่ไม่มีทางออกนอก sandbox เทียบเท่า `excludedCommands` ของ Claude; เพิ่ม allow prefix rule ให้ command กลุ่มนี้ (escalation ไม่ prompt; forbidden/prompt rule ที่เจาะจงกว่ายังชนะตาม strictest-wins) และ AGENTS.md managed block สั่งให้เรียกด้วย `sandbox_permissions: "require_escalated"` ตั้งแต่ครั้งแรก; แก้ docs ที่เคยสมมติว่า gh ใช้ keychain อย่างเดียว
- classifier: ลด false positive ของ `SHELL_SUBSTITUTION` — `$?`, `$$`, `$!`, `$#` ขยายเป็นตัวเลขเสมอจึงไม่นับเป็น substitution (`echo $?` = ALLOW); `echo`/`printf` ที่มี substitution ใน argument ไม่ ASK อีก เพราะแค่พิมพ์ค่าและ command ใน `$(...)` ถูก classify แยกอยู่แล้ว (`echo $(cat ~/.ssh/id_rsa)` ยัง DENY, `echo x > $(mktemp)` ยัง ASK); target ของ subshell ว่างเปลี่ยนเป็น `subshell`; word ที่มี `(` หรือ `|` เช่น `--filter '/(testA|testB)/'` ไม่ถูกมองเป็น path (เคย ASK `OUTSIDE_TRUST_ZONE`); fixture 8 กรณี
- classifier/Codex hook: `apply_patch` แบบ freeform (Codex ส่ง `tool_input` เป็น patch string ล้วน ไม่ใช่ object) ถูก `policy_gate.py` ห่อเป็น `{"command": ...}` แล้ว classifier อ่านเฉพาะ `patch`/`input` จึง ASK `UNKNOWN_COMMAND: apply_patch without file headers` ทุกครั้ง และ patch ที่แตะ `.env.production`/credential ได้แค่ ASK ไม่ใช่ DENY; ตอนนี้อ่าน `command` ด้วย และ shell form `apply_patch '*** Begin Patch ...'` ตัดสินจาก file header เหมือนกัน (heredoc form ยัง ASK); fixture 4 กรณี + gate test
- classifier: `for VAR in <literal...>; do ... done` และ `VAR=<literal>; ...` ถูกขยายเป็นค่าจริงทุก combination (สูงสุด 32) ก่อน classify แทน ASK `SHELL_SUBSTITUTION`; command ใน `$(...)`/backtick ถูก classify แยกและ DENY ชนะ (`echo $(cat ~/.ssh/id_rsa)` = DENY); shell keyword นำหน้า segment ถูกตัดก่อนตรวจ print/path (`for f in .env; do cat $f` = DENY `DEV_ENV_PRINT`); `${HOME}/.agents` เพิ่มใน `agent_config_dirs`
- classifier: ไฟล์ env ที่ลงท้าย `.example`, `.sample`, `.dist`, `.template` ไม่นับเป็น dev/prod env; native glob ของ Claude (`permissions.deny`) และ Codex (sandbox `:workspace_roots`) เปลี่ยนจาก `.env.prod.*` เป็นชุด suffix เจาะจง (`nativeProdEnvGlobs`) เพราะ glob ไม่มี negation; ชื่อนอกชุดยังถูก classifier/hook DENY ผ่าน wildcard; `SHELL_SUBSTITUTION` ใส่ target เป็น segment ที่มี substitution
- classifier: shell keyword (`for`, `while`, `until`, `if`, `then`, `else`, `elif`, `do`, `case`, `!`, `{`, `}`, `fi`, `done`, `esac`) ไม่ใช่ command แล้ว: ตัดสินจาก command ที่ตามหลังใน segment เดียวกัน; `for f in *.log; do rm -rf ...` ยังได้ DESTRUCTIVE_DELETE และ `if ...; then git push origin main` ยัง DENY
- classifier: `bash|sh <script>` (ไม่ใช่ `-c`) ตัดสินจาก path ของ script แทน ASK `unknown command: bash`; Codex collaboration tools (`collaborationwait_agent`, `send_message`, `list_agents`, `followup_task`, `interrupt_agent`) และ `update_plan` เป็น ALLOW; `spawn_agent` ผ่าน provider guard เหมือนเดิม; `pgrep`, `pidof` เป็น read-only
- `doctor`/`apply`: temp dir ใช้ `getconf DARWIN_USER_TEMP_DIR` บน macOS แทน `os.tmpdir()` ที่อ่าน `$TMPDIR` ทำให้ generated config ต่างกันระหว่าง terminal กับ Claude sandbox (`/tmp/claude-<uid>`) และ doctor รายงาน drift ปลอม
- `doctor`: hash drift รายงานเฉพาะไฟล์ของ target นั้น ไม่เอา drift ของ Claude ไปโผล่ใต้ codex/pi

## [0.1.0] - 2026-08-28

### Added

- policy กลาง: `core-policy.yaml`, `permission-matrix.yaml` (57 rules), `protected-paths.yaml`, `trusted-defaults.yaml`, `provenance.yaml` และ JSON schema
- classifier provider-neutral (TypeScript) พร้อม mirror ภาษา Python สำหรับ Codex hooks: shell parser (quoting, operator, redirection, nested shell, wrapper), path classifier (traversal, symlink escape, env pattern), git refspec parser, gh/docker/package manager/deploy/database classification, GitHub connector tool classification
- Claude adapter: managed merge ของ `settings.json` (permissions, sandbox, credentials, autoMode) และ managed block ใน `CLAUDE.md`
- Codex adapter: ลบ `sandbox_mode = "danger-full-access"`, permission profile ไม่มี `"/" = "read"`, `requirements.toml`, `hooks.json` + Python hooks, `rules/default.rules` managed block, `AGENTS.md`, GitHub connector tool control แบบ dynamic
- Pi adapter: extensions `policy-gate`, `protected-paths`, `user-bash-gate`, `share-guard`, shared lib, `AGENTS.md`, isolation profiles `host-macos`, `docker`, `gondolin`, `openshell` และ `scripts/pi-isolated.sh`
- installer: `init`, `plan`, `diff`, `apply` (backup + atomic write + validation), `rollback` (transaction), `uninstall`, `migrate`, `doctor`, `verify`, `generate-check`
- parity harness และ fixture 259 กรณี รวม adversarial cases; Python unit tests; security tests (parsing, paths, template injection); integration tests (idempotency, rollback, doctor)
- CI: test, parity, generate-check, secret-scan; dependabot; issue/PR templates
