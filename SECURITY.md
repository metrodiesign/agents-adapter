# Security Policy

## Supported versions

| version | supported |
|---|---|
| 0.1.x | yes |

## Responsible disclosure

- รายงานช่องโหว่ผ่าน GitHub Security Advisory ของ repository นี้ (Security -> Report a vulnerability) ห้ามเปิด public issue สำหรับช่องโหว่ที่ยังไม่ได้แก้
- ระบุ CLI และ version, action ที่ใช้ทดสอบ (แทนค่าเฉพาะเครื่องด้วย placeholder), ผลที่ได้และผลที่คาด
- จะตอบรับภายใน 7 วัน และเผยแพร่ fix พร้อม changelog เมื่อพร้อม

## Threat model

agents-adapter ป้องกัน **agent ที่ทำงานอยู่ในเครื่องของ user** ไม่ให้ทำ action นอกขอบเขตที่ policy อนุญาต ทั้งจากความผิดพลาดของ model, prompt injection ใน repository/เอกสาร และ subagent/plugin ที่พยายามข้าม policy

สิ่งที่อยู่ในขอบเขต:

- การรัน shell command ผ่าน tool ของ CLI (รวม `!`/`!!` ของ Pi)
- file tool (read/write/edit/apply_patch) และ GitHub connector tool ของ Codex
- การอ่าน/แก้ credential file, keychain, production env
- git/GitHub operation ที่ทำลายหรือเผยแพร่ข้อมูล (force push, protected branch, merge, gist, repo delete)
- bypass flag ของ CLI

สิ่งที่อยู่นอกขอบเขต:

- user ที่ตั้งใจข้าม policy เอง (เช่นแก้ config, รัน `pi --no-extensions` ด้วยมือ)
- ช่องโหว่ของ CLI แต่ละตัวเอง
- การรั่วไหลผ่าน model provider

## Trust boundaries

```text
user config (~/.config/agents-adapter/config.yaml)   trusted, validated by schema + semantic checks
policy/*.yaml ใน repository                            trusted, validated by schema
Claude: settings.json permissions + sandbox            enforced by Claude Code runtime (OS sandbox)
Codex: permission profile + requirements + hooks       enforced by Codex runtime; hook = DENY, rules = ASK
Pi host-macos: extensions                              enforced in-process; ไม่มี OS sandbox
Pi isolated: extensions + container/VM                 credential/prod env ไม่ถูก mount
```

## Known limitations

| limitation | ผลกระทบ | mitigation |
|---|---|---|
| Pi host mode ไม่มี OS isolation | script ที่ model เขียนแล้วรันเองอ่าน credential ได้ | ใช้ `scripts/pi-isolated.sh docker`; doctor รายงาน best-effort |
| Codex hook บังคับได้เฉพาะ deny | ASK อาศัย rules + approvals reviewer | rules `prompt` ถูก generate ทุก ASK class; auto_review policy ถูกเติม managed block |
| Codex hook ต้องถูก trust | hook ใหม่ไม่ทำงานจนกว่า user จะยอมรับใน Codex | doctor รายงาน WARN "hook trust" |
| `requirements.toml` ที่ `~/.codex` | Codex อ่าน requirements จาก system path/MDM เป็นหลัก | doctor ตรวจ; เอกสาร migration แนะนำ copy ไป `/etc/codex/requirements.toml` เมื่อต้องการบังคับระดับเครื่อง |
| shell parser ไม่ evaluate substitution/glob/heredoc | command ที่มี feature เหล่านั้น | ลดเป็น ASK เสมอ ไม่เดา |
| prefix rules ของ Codex ข้าม command ที่มี env prefix หรือ substitution | rules ชั้นเดียวไม่พอ | hook ชั้นหลักครอบทุก tool call (matcher `.*`) |
| symlink escape ตรวจจาก realpath ของ ancestor ที่มีอยู่ | race condition ระหว่างตรวจกับรันยังเป็นไปได้ในทฤษฎี | OS sandbox ของ Claude/Codex และ isolated Pi ปิดช่องนี้ |

## Secret handling in this repository

- ห้าม commit `.env*`, `auth.json`, `credentials.json`, key/pem, `config.yaml` จริง, backup และ generated file ที่มีค่าเฉพาะเครื่อง
- `scripts/secret-scan.sh` รันใน CI และก่อน push; ตรวจ token pattern, credential file, private path, connector id และ trusted hash
- doctor และ hook ไม่พิมพ์ค่า secret; `gh auth status` ใช้ได้ `gh auth token` ถูก DENY
