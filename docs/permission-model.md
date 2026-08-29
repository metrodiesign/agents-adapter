# Permission Model

## Decision

| decision | semantics | ตัวอย่าง |
|---|---|---|
| `ALLOW` | ดำเนินการได้โดยไม่ถาม user ซ้ำ ภายใน Development Trust Zone | `npm test`, `git push -u origin feature/x`, `gh pr create` |
| `ASK` | ขออนุมัติหนึ่งครั้งต่อ action + target + environment + account | `rm -rf ~/Documents/old` (นอก zone; `rm -rf dist` ใน workspace เป็น ALLOW), `git reset --hard`, `npm install -g x`, `kubectl apply` |
| `DENY` | hard block; ห้ามข้ามด้วย prompt, subagent, plugin, project config, CLI flag, dangerous bypass flag, auto-review, tool alias หรือ shell wrapper | `git push origin main`, `gh pr merge`, `cat ~/.ssh/id_rsa`, `--dangerously-skip-permissions` |

## Development Trust Zone

repository ปัจจุบัน (cwd) และทุก repository ใต้ `development_roots` ใน user config รวม temp/cache ใน `trusted-defaults.yaml` และ config dir ของ agent (`~/.claude`, `~/.codex`, `~/.pi`) ยกเว้น credential file ที่ deny ทับเสมอ และไฟล์ที่ agents-adapter จัดการเอง (`settings.json`, `config.toml`, hooks, rules, Pi extensions และ `~/.config/agents-adapter/config.yaml`) ที่อ่านได้แต่แก้ต้อง `SYSTEM_CONFIG_CHANGE` (ASK) เพื่อไม่ให้ agent แก้ gate ของตัวเองโดยไม่ถาม

path นอก zone -> `OUTSIDE_TRUST_ZONE` (ASK) ยกเว้น system path (`/usr`, `/opt`, `/etc`, ...) ที่อ่านได้

## Approval scope

- key ของ approval = rule id + target + environment (development/production ตรวจจาก marker `prod`/`production` ใน target)
- Pi cache approval ในหน่วยความจำของ session; Claude และ Codex ใช้กลไก approval ของตัวเอง แต่ prompt (autoMode soft_deny / approvals reviewer policy) บอกให้ใช้ approval เดิมกับขั้นตอนต่อเนื่องของงานย่อยเดียวกัน
- approval หนึ่งรายการห้ามครอบ target อื่นโดยอัตโนมัติ

## Provider routing สำหรับ security agent

| เงื่อนไข | decision |
|---|---|
| spawn agent ทั่วไป (coder, researcher, ...) ทุก provider | `AGENT_SPAWN` ALLOW |
| spawn `auditor`, `skeptic`, `security-review`, `security-reviewer`, `security-auditor` เมื่อไม่ตั้ง `ANTHROPIC_BASE_URL` หรือชี้ `api.anthropic.com` | `AGENT_SPAWN` ALLOW |
| spawn agent กลุ่มเดียวกันเมื่อ `ANTHROPIC_BASE_URL` ชี้ host อื่น | `SECURITY_AGENT_PROVIDER` DENY |

เหตุผล: content filter ของ provider อื่น (เช่น OpenAI cyber filter) ตอบ `400 This content was flagged for possible cybersecurity risk` กับ context ของงาน audit (symlink, race, TOCTOU) และข้อความที่โดนแฟล็กอยู่ใน history แล้ว ทุก request ถัดไปของ agent ตัวนั้นล้มหมด กู้ไม่ได้ ต้อง kill แล้ว spawn ใหม่บน Anthropic รายชื่อ agent และ host อยู่ใน `trusted-defaults.yaml` (`security_agent_types`, `anthropic_hosts`)

## Production requirements

action ที่เป็น `PROD_DEPLOY`, `PROD_DB_WRITE`, `PROD_DESTRUCTIVE_DB` ต้องมีข้อมูลก่อนอนุมัติ:

```text
target
impact
backup
rollback plan
verification plan
```

ถ้าข้อมูลไม่ครบ ผลต้องเป็น `ASK` หรือ `DENY` ห้าม `ALLOW`; classifier ไม่มีทางให้ ALLOW กับ class นี้

## ลำดับความสำคัญในการรวมผล

```text
DENY > ASK > ALLOW
```

- bypass flag และ credential/production path ถูกตรวจในทุก segment ของ command และชนะ verdict อื่นเสมอ
- command substitution, subshell, variable ที่ขยายไม่ได้ (`$FOO`) ทำให้ ALLOW กลายเป็น ASK แต่ไม่ลด DENY
- ใน tie ระดับเดียวกัน rule ของคำสั่งหลักถูกรายงาน (เช่น `npm test && git push origin feature/x` รายงาน TEST หรือ GIT_PUSH_FEATURE ได้ทั้งคู่ ทั้งสองเป็น ALLOW)

## Rule catalog

ดู `policy/permission-matrix.yaml` (57 rules) แบ่ง category: filesystem, env, credential, build, dependency, docker, git, github, share, deploy, destructive, security

rule ที่เพิ่มจากตารางขั้นต่ำของ specification เพื่อปิดช่องว่างของ CLI อื่น (มี provenance = derived):

| rule | เหตุผล |
|---|---|
| `CREDENTIAL_WRITE` | แยกการเขียน/ลบ credential ออกจากการอ่าน |
| `SHELL_READ_ONLY`, `UNKNOWN_COMMAND` | Claude มี classifier ตัดสินเอง; Codex/Pi ต้องมีคำตอบชัดเจน |
| `GIT_REMOTE_DELETE`, `GIT_BRANCH_FORCE_DELETE` | สกัดจาก `permissions.ask` ของ Claude reference |
| `GH_READ`, `GH_REPO_CREATE`, `GH_AUTH_CHANGE`, `GH_SECRET_MANAGE`, `GH_DELETE_FILE` | สกัดจาก allow/ask/deny ของ reference และ connector tools |
| `PIPE_TO_SHELL`, `PRIVILEGE_ESCALATION`, `SHELL_SUBSTITUTION`, `SYSTEM_CONFIG_CHANGE`, `LOCAL_DESTRUCTIVE_DB` | hard/soft boundary ใน reference ที่ตารางขั้นต่ำไม่ได้ตั้งชื่อ |
