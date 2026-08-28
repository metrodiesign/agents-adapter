# Architecture

## ภาพรวม

agents-adapter แยกเป็น 6 ชั้นที่ไม่ปนกัน: policy, adapter, runtime enforcement, installer, tests และ documentation

```mermaid
flowchart TB
  subgraph Policy
    R[reference/claude<br/>sanitized Claude policy] --> CP[policy/core-policy.yaml]
    CP --> PM[policy/permission-matrix.yaml]
    PP[policy/protected-paths.yaml] --> CTX
    TD[policy/trusted-defaults.yaml] --> CTX
    UC[user config<br/>~/.config/agents-adapter/config.yaml] --> CTX[PolicyContext]
  end
  subgraph Core
    CTX --> CL[src/core/classifier.ts]
    SH[src/core/shell.ts] --> CL
    PA[src/core/paths.ts] --> CL
    PY[runtime/codex/hooks/agents_adapter_policy.py<br/>Python mirror] -. parity .- CL
  end
  subgraph Adapters
    CL --> CA[claude/generate + evaluate]
    CL --> CO[codex/generate + evaluate]
    CL --> PI[pi/generate + evaluate]
  end
  subgraph Runtime
    CO --> H[~/.codex/hooks/agents-adapter/*.py]
    CO --> RU[~/.codex/rules/default.rules]
    PI --> EX[~/.pi/agent/extensions/*.ts]
    PI --> ISO[isolation profile]
  end
  subgraph Installer
    CA --> IN[plan / apply / rollback / doctor]
    CO --> IN
    PI --> IN
  end
  subgraph Tests
    F[tests/fixtures/actions.json] --> PH[parity harness]
    CA --> PH
    CO --> PH
    PI --> PH
  end
```

## Policy layer

| ไฟล์ | บทบาท |
|---|---|
| `reference/claude/*` | behavioral authority ที่ sanitize แล้ว |
| `policy/core-policy.yaml` | กฎ provider-neutral: language, trust zone, approval, git/github workflow, CI gates, destructive, staging/production boundary, retry, completion |
| `policy/permission-matrix.yaml` | rule id + decision + category; contract ที่ adapter และ test ใช้ร่วมกัน |
| `policy/protected-paths.yaml` | credential path, basename, extension, system config path, credential env var |
| `policy/trusted-defaults.yaml` | temp/cache ที่เขียนได้, agent config dir, excluded commands, public registries |
| `policy/provenance.yaml` | rule -> section/JSON path ของ Claude reference |
| `policy/schema/*.json` | JSON schema ที่ loader บังคับใช้ |

## Core classifier

`classifyCommand(command, ctx)` ทำงานเป็นขั้น:

1. parse shell เป็น simple command (quoting, `;`/`&&`/`||`/`|`, redirection, `$(...)`, backtick, `sh -c`/`bash -lc`, wrapper `env`/`command`/`exec`/`nice`/`time`/`nohup`, `VAR=value` prefix)
2. ตรวจ bypass flag ทุก segment (DENY ก่อนอย่างอื่น)
3. per-command classification (git, gh, docker, package manager, rm, database, deploy, remote, artisan, build/test/lint, read-only)
4. path ใน argument และ redirection ผ่าน `classifyPath` (credential > prod env > trust zone > dev env > outside)
5. substitution ทำให้ ALLOW กลายเป็น ASK
6. รวมด้วย `strictest()` (DENY > ASK > ALLOW; tie เลือก verdict แรก = ของคำสั่ง)

`classifyTool(call, ctx)` ครอบ file tool, shell tool, `apply_patch` และ GitHub connector tool (`github.*`, `mcp__github__*`)

Python mirror มีโครงสร้างฟังก์ชันเดียวกันทีละตัว parity test รัน fixture เดียวกันผ่านทั้งสอง

## Normalized matrix ถึง adapter

```mermaid
sequenceDiagram
  participant M as permission-matrix.yaml
  participant C as PolicyContext
  participant A as Adapter.render()
  participant I as Installer.apply()
  participant D as ~/.claude ~/.codex ~/.pi
  M->>A: rule ids + decisions
  C->>A: roots, branches, env patterns, credential paths
  A->>A: read existing file, merge managed keys/blocks
  A-->>I: AdapterPlan (FileChange[], managedKeys, preserved, conflicts, unsupported)
  I->>I: validate every change
  I->>D: backup -> temp write -> validate -> fsync -> rename
  I->>I: save state (managed entries, hashes, backup id)
```

## Runtime enforcement

| CLI | ALLOW | ASK | DENY |
|---|---|---|---|
| Claude | native allow + autoMode | `permissions.ask` + autoMode soft_deny | `permissions.deny` + sandbox deny paths + `disableBypassPermissionsMode` |
| Codex | permission profile | rules `prompt` + approvals reviewer policy + hook additionalContext | PreToolUse hook exit 2 + rules `forbidden` + filesystem deny + requirements |
| Pi | extension pass-through | extension `ctx.ui.confirm()` + session cache | extension block + `user_bash` result replacement + `/share` handled; isolation สำหรับ credential |

## Parity tests

```mermaid
flowchart LR
  F[fixture] --> W[fixture world<br/>temp home + symlink]
  W --> CE[Claude evaluator<br/>pattern rules + classifier]
  W --> XE[Codex evaluator<br/>python policy_gate.py subprocess + rules]
  W --> PE[Pi evaluator<br/>real extension handlers]
  CE --> CMP{decision == expected<br/>and all equal?}
  XE --> CMP
  PE --> CMP
  CMP -->|no| FAIL[CI fail]
```

## Installation flow

```mermaid
flowchart TD
  A[scripts/install.sh] --> B[init: create config from example]
  B --> C[plan: render all adapters, no writes]
  C --> D{user confirms?}
  D -->|no| E[exit, nothing changed]
  D -->|yes| F[apply: backup + atomic write]
  F --> G[doctor]
  G --> H{FAIL?}
  H -->|yes| I[rollback available]
  H -->|no| J[done]
```
