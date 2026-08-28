# Implementation Plan

แผนนี้เขียนก่อนลงมือและอัปเดตสถานะเมื่อแต่ละ phase ผ่าน gate

## Phase 0 - Preflight

| งาน | ผล |
|---|---|
| ตรวจ CLI versions | Claude Code 2.1.x, Codex CLI 0.150.x, Pi 0.84.x, Node 26, Python 3.14 |
| ตรวจ official schema/docs | Codex hooks (PreToolUse exit 2 / permissionDecision deny), requirements.toml (`allowed_permission_profiles`), execpolicy prefix_rule; Pi extension API (`tool_call`, `user_bash`, `input`, `ctx.ui.confirm`) จาก type definitions ของ package ที่ติดตั้ง |
| ตรวจ local configuration แบบ read-only | Codex มี `default_permissions` + `sandbox_mode = "danger-full-access"`, `"/" = "read"`, `~/.config/gh = read`, dev env deny ทั้งหมด; Pi ไม่มี extension |
| GitHub account / repository | repository ยังไม่มี -> สร้าง public + MIT |
| sanitization report | `reference/claude/*` แทนค่า user path, owner, internal domain, provider ด้วย placeholder |
| capability gaps | Pi ไม่มี permission layer; Codex hook ไม่มี ask; gondolin/openshell ไม่ได้ติดตั้ง (docker มี) |

Gate: ไม่มี credential หรือ private value ใน planned repository -> ผ่าน (secret-scan)

## Phase 1 - Repository Bootstrap

- public repository, feature branch `feature/bootstrap-agents-adapter`, LICENSE MIT, README, SECURITY, CONTRIBUTING, CHANGELOG
- โครงสร้าง policy / src / runtime / templates / scripts / tests / docs / .github
- base CI: test, parity, generate-check, secret-scan

Gate: CI ขั้นพื้นฐานผ่าน -> ตรวจหลัง push

## Phase 2 - Claude Reference Extraction

- sanitize Claude policy -> `reference/claude`
- provenance map -> `policy/provenance.yaml`
- normalized matrix 57 rules -> `policy/permission-matrix.yaml`
- schema + validation -> `policy/schema`, `src/core/policy-validator.ts`

Gate: ทุก rule มี provenance และ fixture (`tests/policy/matrix.test.ts`) -> ผ่าน

## Phase 3 - Claude Adapter

- generator + managed merge (`src/adapters/claude/generate.ts`)
- pattern extraction (`rules.ts`) และ evaluator (`evaluate.ts`)
- idempotency, backup/rollback ผ่าน installer tests

Gate: generated Claude behavior ตรง matrix -> parity ผ่าน

## Phase 4 - Codex Adapter

- ลบ danger-full-access conflict, permission profile, requirements, AGENTS.md, hooks (Python), rules, connector tool control
- Codex parity ผ่าน subprocess ของ `policy_gate.py` จริง

Gate: Codex ผ่าน ALLOW/ASK/DENY matrix -> ผ่าน

## Phase 5 - Pi Adapter

- extensions 4 ตัว + shared lib + config, AGENTS.md, isolation profiles, launcher
- evaluator เรียก handler จริงของ extension

Gate: Pi ผ่าน matrix; credential rules บน host เป็น best-effort พร้อม isolation fallback (docker) -> ผ่าน; ถ้าไม่มี isolation runtime doctor รายงาน UNSUPPORTED

## Phase 6 - Installer และ Doctor

- plan/apply/diff/rollback/uninstall/migrate, atomic write, backup transaction, capability detection, drift report, version gate

Gate: ติดตั้งซ้ำไม่เกิด duplicate หรือ config loss (`tests/integration/install.test.ts`) -> ผ่าน

## Phase 7 - Cross-adapter Parity

- fixture 259 กรณี รวม adversarial (spacing, quoting, chaining, substitution, traversal, symlink, refspec variants, `--force-with-lease`, `HEAD:main`, `refs/heads/main`, nested `.env.production`, `../` credential, `sh -c`, `bash -lc`, `env VAR=value`, case, compose destructive, Pi `!`/`!!`, connector tool names)

Gate: ทุก rule ให้ผลเหมือนกันทั้งสาม CLI -> ผ่าน (`npm run test:parity`)

## Phase 8 - Public Release Preparation

- secret scan, dependency audit, generated fixtures, staged diff review, push feature branch, เปิด PR พร้อม test evidence
- ห้าม merge PR (user decision)
