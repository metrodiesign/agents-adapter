<!-- agents-adapter:start -->
# agents-adapter managed policy (Pi CLI)

block นี้ถูกสร้างโดย agents-adapter 0.1.0 จาก policy กลาง
`settings.json` ของ Pi ไม่ใช่ permission layer; การบังคับใช้อยู่ที่ extension ใน `~/.pi/agent/extensions/` และ OS isolation profile `host-macos`

## กฎภาษา

- ตอบ user เป็นภาษาไทยทุกข้อความ; code, identifier, command, path, flag, error/log และ technical term คงภาษาอังกฤษ
- ไฟล์ `.md` เป็นภาษาไทยเป็นหลัก ห้าม emoji

## Development Trust Zone

```text
${HOME}/Desktop/Project
```

งาน routine ในเขตนี้ (อ่าน/แก้ source, build, test, lint, dependency แบบ project-local, local Docker, git status/commit/fetch, push feature branch ที่ระบุชื่อ, PR/issue/comment) ทำได้โดยไม่ถาม

development env (.env, .env.local, .env.development, .env.test, .env.testing, .env.integration) อ่านและแก้ได้ ห้ามพิมพ์ค่า secret

## ASK: extension จะถามผ่าน dialog หนึ่งครั้งต่อ action + target

`rm -rf` ที่ target เป็น zone root, repository root, `.git`, glob หรือ path นอก Trust Zone (ลบภายใน workspace ไม่ต้องถาม), `git reset --hard`, `git clean -f`, ลบ branch/tag แบบบังคับ, ลบ remote branch, สร้าง/push tag, สร้างหรือแก้ GitHub release, `gh pr merge` (merge เป็น user decision ต้องยืนยันทุกครั้ง), destructive database, Docker prune/volume, global package install, shell startup file, git remote change, auth change, path นอก Trust Zone, staging/production deploy และ production database

approval ถูก cache ใน session สำหรับ target เดิมเท่านั้น

## DENY: extension block ทันทีพร้อม rule id

- push เข้า main, develop, bare push, `HEAD` push, force push ทุกแบบ
- `gh repo delete`, `gh gist`, `gh secret`, `gh auth token`
- credential file, keychain, production env (.env.production, .env.production.*, .env.prod, .env.prod.*), production database, OS system path (`/System`, `/Library`, `/etc`, `/usr`, `/opt`)
- `/share`, public gist, session export ไปบริการภายนอก
- bypass flag รวม `pi --no-extensions`, `sudo`, curl/wget pipe เข้า shell
- spawn security agent (auditor, skeptic, security-review) เมื่อ `ANTHROPIC_BASE_URL` ชี้ provider ที่ไม่ใช่ Anthropic (`SECURITY_AGENT_PROVIDER`); agent ที่โดน content filter 400 แล้วต้อง kill และ spawn ใหม่ ห้าม resume

`!command` และ `!!command` ของ user ผ่าน gate เดียวกัน

## Isolation

- host-macos: ใช้กับงานที่ต้องการ Xcode, Simulator, Keychain ผ่าน CLI เจ้าของ credential, Docker Desktop, GUI, gh; credential rule เป็น best-effort บน host
- isolated (docker/gondolin/openshell): ใช้กับ Node.js, PHP, .NET, Python, backend, database, test และ repository analysis; credential และ production env ถูกป้องกันด้วย OS isolation
- งานที่ต้อง hard boundary ระดับ credential ให้รันด้วย `scripts/pi-isolated.sh`
<!-- agents-adapter:end -->
