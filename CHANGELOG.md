# Changelog

รูปแบบตาม Keep a Changelog; เวอร์ชันตาม Semantic Versioning

## [Unreleased]

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
