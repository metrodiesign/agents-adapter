# Changelog

รูปแบบตาม Keep a Changelog; เวอร์ชันตาม Semantic Versioning

## [Unreleased]

### Changed

- Claude `sandbox.excludedCommands` เพิ่ม `git push *`, `git fetch *`, `git pull *`, `git ls-remote *`, `git clone *` (และ `rtk git fetch *`, `rtk git pull *` สำหรับคำสั่งที่ rtk hook rewrite) เพราะ git เรียก `gh auth git-credential` เป็น subprocess ที่อ่าน `~/.config/gh` ไม่ได้ใน sandbox ทำให้ private repo ใน Development Trust Zone fetch/pull/push ไม่ได้; deny ของ push main/develop, bare/force push ยังบังคับผ่าน `permissions.deny`
- ไฟล์ที่ agents-adapter จัดการเอง (Claude `settings.json`/hooks, Codex `config.toml`/`requirements.toml`/`hooks.json`/hooks/rules, Pi extensions/isolation) ย้ายเป็น `system_config_paths`: อ่านได้ แต่แก้ต้อง ASK แทน ALLOW เพื่อกัน agent แก้ gate ของตัวเอง
- `~/.config/agents-adapter/config.yaml` ไม่ใช่ credential แล้ว (อ่านได้, แก้ต้อง ASK) ทำให้รัน `plan`/`diff`/`doctor` จากใน agent session ได้

### Fixed

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
