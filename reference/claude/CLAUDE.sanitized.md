<!-- sanitized reference copy of the Claude Code global policy; machine-specific values replaced by placeholders -->


# กฎส่วนกลางสำหรับ Claude Code

ไฟล์นี้เป็น behavioral policy สำหรับ Claude Code, subagent และ agent team ทุกตัว ส่วนสิทธิ์ที่บังคับใช้จริงอยู่ใน `~/.claude/settings.json`, sandbox, macOS และสิทธิ์ของบริการภายนอก

เมื่อกฎชนกัน ให้ใช้ลำดับความสำคัญต่อไปนี้:

1. ความปลอดภัยของข้อมูล, credential และ production
2. คำสั่งล่าสุดที่ชัดเจนของ user ภายในขอบเขตที่อนุญาต
3. กฎเฉพาะ repository
4. กฎในไฟล์นี้
5. ค่าเริ่มต้นของ tool, plugin หรือ skill

ห้ามใช้ความระมัดระวังเป็นเหตุให้หยุดงาน routine โดยไม่จำเป็น หากทำต่อได้อย่างปลอดภัยภายใน Development Trust Zone ให้ทำต่อ ตรวจผล และรายงานตามหลักฐาน

## กฎภาษา

- คุยกับ user เป็นภาษาไทยเท่านั้นในทุก reply, คำอธิบาย, สรุป, คำถาม, plan และ progress line
- แทรกอังกฤษได้เฉพาะ code, identifier, command, path, flag, error/log เดิม และ technical term ที่แปลแล้วเสียความหมาย
- เมื่อ quote error/log/เอกสารภาษาอังกฤษ ต้องตามด้วยคำอธิบายภาษาไทยสั้น ๆ เสมอ
- commit message, PR title/body และ code comment ให้ตาม convention ของ repository; ค่าเริ่มต้นเป็นอังกฤษ
- ห้ามสร้าง prose ด้วยภาษาที่สาม ข้อยกเว้นมีเฉพาะการ quote ต้นฉบับตามจริง
- ก่อนส่งทุกข้อความต้อง self-check ภาษา รวมถึง progress line ระหว่างงานยาว
- ไฟล์ `.md` ที่สร้างหรือแก้ต้องเป็นภาษาไทยเป็นหลัก ยกเว้น code, identifier, command, path, flag และ technical term
- ตอน spawn subagent หรือ teammate ต้องระบุให้ตอบเป็นภาษาไทย และต้อง relay ผลกลับเป็นภาษาไทย
- template ภาษาอังกฤษกำหนดโครงสร้างเท่านั้น ไม่ได้เปลี่ยนกฎภาษา
- Stop hook `hooks/lang-guard.py` เป็น backstop เท่านั้น ห้ามพึ่ง hook แทนการ self-check

## กฎ Markdown

- ห้ามใช้ emoji ในไฟล์ `.md`
- เอกสารต้องมี heading ชัดเจนและกวาดตาประมาณ 10 วินาทีแล้วเห็นโครงสร้างหลัก
- หลีกเลี่ยงย่อหน้ายาวเกินจำเป็น ใช้ตารางหรือรายการเมื่อช่วยให้ตรวจสอบง่ายขึ้น
- code block ต้องระบุภาษาเมื่อทราบชนิด

## ลำดับการตัดสิน Permission

การบังคับใช้จริงเป็นลำดับดังนี้:

```text
permissions.deny
  → permissions.ask
  → permissions.allow
  → Auto classifier
  → Bash sandbox
  → macOS / credential store / external service
```

- `CLAUDE.md` กำหนดสิ่งที่ Agent ควรพยายามทำ แต่ไม่ grant สิทธิ์จริง
- `deny` เป็น hard block และชนะ `ask`/`allow`
- `ask` ต้องขออนุมัติก่อน แม้จะมี `allow` ที่เจาะจงกว่า
- Auto classifier ใช้หลัง permission rules และไม่สามารถข้าม hard deny ได้
- เมื่อวิเคราะห์ปัญหา ต้องแยกให้ได้ว่าเกิดจาก prompt policy, permission rule, hook, sandbox, macOS, authentication หรือ authorization

## Development Trust Zone

Development Trust Zone คือ current repository และ development root ต่อไปนี้:

```text
${HOME}/Desktop/Project
```

รวมถึงไฟล์ตั้งค่า Agent ภายใต้ `~/.claude` และ `~/.codex` เมื่อ task ปัจจุบันระบุชัดว่าเป็นการตั้งค่า Agent/tool โดย credential file ยังคงเป็นเขตห้ามอ่านและห้ามแก้

ภายใน Zone นี้ ให้ทำงาน routine ต่อไปนี้อัตโนมัติโดยไม่ถามซ้ำ:

- อ่าน สร้าง แก้ ย้าย และลบไฟล์ project ทั่วไปที่อยู่ใน scope ของงาน
- อ่านและแก้ development configuration
- อ่านและแก้ `.env`, `.env.local`, `.env.development`, `.env.test`, `.env.testing` โดยไม่แสดงหรือ commit secret
- build, test, lint, static analysis, formatter, code generation และ local migration ที่ไม่ทำลายข้อมูล
- ติดตั้งหรืออัปเดต dependency แบบ project-local พร้อมอัปเดต lock file
- ใช้ localhost, local service, local database และ local Docker
- `git status`, `git diff`, `git add`, `git commit`, `git fetch`, `git pull --ff-only` และ rebase ของ unpushed feature branch
- push feature branch โดยระบุ remote และชื่อ branch อย่างชัดเจน
- `gh` สำหรับดู repository/issue/PR/check, สร้างหรืออัปเดต issue/PR/comment และติดตาม CI
- เรียก Codex เพื่อ review, วิเคราะห์ หรือ delegate งานใน workspace ปัจจุบัน

กฎ Auto ไม่ได้อนุญาตให้ข้าม review, CI, branch policy, secret policy หรือ production boundary

## Approval boundary

ต้องขออนุมัติหนึ่งครั้งต่อ action และ target ที่ชัดเจนในกรณีต่อไปนี้:

- `rm -rf`, `git reset --hard`, `git clean`, ลบ local branch แบบบังคับ หรือ rewrite history ที่ยังไม่ push
- ลบ remote branch, tag, release, issue หรือ PR
- destructive migration, database reset หรือการล้างข้อมูล แม้เป็น local/dev
- ติดตั้ง package แบบ global, แก้ shell startup file หรือแก้ system-wide configuration
- เพิ่ม/เปลี่ยน/ลบ Git remote หรือเปลี่ยน GitHub authentication
- แก้ repository/path ที่อยู่นอก Development Trust Zone
- deploy staging, เปลี่ยน shared environment หรือแก้ shared CI/CD configuration
- production operation ทุกชนิด ต้องระบุ target, impact, backup และ rollback plan

เมื่อ user อนุมัติ action และ target ชัดเจนแล้ว ให้ใช้ approval นั้นตลอดงานย่อยเดียวกัน ห้ามถามซ้ำทุก command ที่เป็นขั้นตอนต่อเนื่องของ action เดิม

## Hard boundary

ห้ามทำสิ่งต่อไปนี้:

- push ตรงเข้า `main` หรือ `develop`
- ใช้ bare `git push` หรือ `git push ... HEAD`; ต้องระบุ feature branch ชัดเจน
- force push ทุกแบบ รวม `--force-with-lease`
- merge PR แทน user
- ลบ GitHub repository หรือเผยแพร่ข้อมูลผ่าน gist
- ข้าม permission, sandbox หรือ hook ด้วย dangerous bypass flag
- อ่าน แสดง คัดลอก หรือแก้ credential store โดยตรง
- commit, log, paste, upload หรือส่ง secret, token, password, private key, connection string หรือ credential file
- deploy หรือทำลายข้อมูล production โดยไม่มีคำสั่งจาก user ที่ระบุ target ชัดเจน

CLI เจ้าของ credential เช่น `gh`, `codex` และ `docker` สามารถใช้ credential ภายในของตัวเองได้ แต่ Agent ห้ามอ่านหรือพิมพ์เนื้อหา credential ออกมา รวมถึงห้ามใช้ `gh auth token`

## กฎ Environment และ Secret

- development env อ่านและแก้ได้ภายใน Development Trust Zone เพื่อให้ build/test/debug ทำงานจริง
- production env ต่อไปนี้เป็น restricted: `.env.production`, `.env.production.*`, `.env.prod`, `.env.prod.*`
- `.env` และ `.env.*` ต้องอยู่ใน `.gitignore`; commit ได้เฉพาะ `.env.example` ที่ใช้ค่าปลอม
- ก่อน commit ต้องตรวจ staged filenames และ staged diff เพื่อยืนยันว่าไม่มี env/credential หลุด
- ห้าม hardcode credential ลงโค้ด ให้ใช้ environment variable หรือ secret manager
- ห้าม log token, password, PII หรือ authorization header
- หาก secret หลุด ต้อง rotate/revoke ทันที การลบ commit อย่างเดียวไม่พอ
- ห้ามเก็บ `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, third-party provider key, GitHub token หรือ cloud key ลงใน Markdown, source code หรือ repository settings
- ห้ามตั้ง `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` ใน shared settings เพราะจะตัด environment ของ subprocess ทั้งหมด; ใช้ `sandbox.credentials` ป้องกันเฉพาะ credential แทน

## Model, advisor และ provider routing

กฎส่วนนี้ใช้เฉพาะ Claude Code ห้ามนำ alias, advisor, effort หรือ CLI flag ไปใช้กับ Codex

- main model ตั้งผ่าน top-level key `model` ใน `settings.json`; ค่าเริ่มต้นคือ `opus[1m]`
- fallback ใช้ `sonnet` แล้ว `haiku`
- persisted effort ใช้ `high`; ระดับที่สูงกว่านี้ใช้เฉพาะ session/turn ที่มีเหตุผลด้านคุณภาพ
- advisor ใช้ `advisorModel: "opus"`; ห้ามตั้ง Fable เป็น advisor
- Fable ใช้เป็น main model เมื่อ provider/session รองรับและ user เลือก ไม่ใช่ advisor
- ห้ามตั้ง `ANTHROPIC_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` หรือ `CLAUDE_CODE_EFFORT_LEVEL` แบบ global เพราะอาจทับ routing/frontmatter ของ agent
- agent ใน `agents/` ต้อง pin `model` และ `effort` ใน frontmatter ตามบทบาทเมื่อ repository กำหนดไว้
- เปิด named agent ผ่าน `scripts/claude-agent.sh <name>` เมื่อ wrapper ของ project มีอยู่
- advisor เป็นความสามารถของ main session; subagent/teammate ต้องรายงานกลับผู้เรียกแทนการสมมติว่ามี advisor
- อย่าสลับ model/effort กลาง session โดยไม่มีเหตุผล เพราะทำให้ context/cache ใช้ซ้ำได้น้อยลง

แนวทาง tier เมื่อไม่มี pin เฉพาะ project:

- orchestrator, architect, auditor, reviewer, skeptic: `opus` + `high`/`xhigh`
- coder งานทั่วไป: `sonnet` + `high`
- coder งานซับซ้อนหรือ rework สำคัญ: `opus` + `high`
- verifier, researcher, gitops: `sonnet` + `high`
- file-scanner, doc-fetcher, log-parser และงาน mechanical: `haiku` + `high`

### GLM profile

`settings.json` ส่วนกลางต้อง provider-neutral ห้ามฝัง third-party provider token ลงไฟล์นี้

เมื่อใช้ GLM ผ่าน Claude Code ให้ launcher หรือ shell profile เฉพาะ session ตั้งค่าอย่างน้อย:

```text
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_DEFAULT_HAIKU_MODEL
```

ห้ามเปิด GLM profile ค้างใน shell ที่ต้องใช้ Claude subscription โดยตรง และห้าม commit token

### Codex routing

- Codex ใช้ `~/.codex/config.toml` และ `~/.codex/AGENTS.md` ของตัวเอง
- Claude เรียก Codex ผ่าน plugin/CLI ได้ แต่ Codex ต้องคง sandbox, approval และ authentication policy ของ Codex เอง
- ห้ามให้ Claude อ่าน `~/.codex/auth.json`; ให้ `codex` CLI ใช้ไฟล์นั้นภายในเอง

## Sandbox และ CLI rules

- Bash sandbox เปิดเป็นค่าเริ่มต้น และ sandboxed command ที่ผ่าน policy ให้ auto-approve
- `gh *`, `docker *`, `codex *` และ `dotnet test *` รันนอก outer Claude sandbox ผ่าน `excludedCommands` เพราะต้องใช้ keychain/socket/runtime ของตัวเอง
- การออกนอก outer sandbox ไม่เท่ากับ bypass permission; ยังต้องผ่าน permission rules และ Auto classifier
- ห้ามเปิด Docker socket ให้ sandboxed subprocess เมื่อ `docker *` ถูก exclude อยู่แล้ว
- หาก Go binary พบ `tls: failed to verify certificate: x509: OSStatus -26276` ให้เพิ่ม binary นั้นใน `excludedCommands` แบบเจาะจง แทนการลด network isolation ทั้งระบบ
- ห้ามใช้วิธีอ่าน token แล้วต่อเข้า `curl`; ให้ CLI เจ้าของ credential ทำงานเอง
- hook ทุกตัวต้อง fail-open เมื่อ executable/script ไม่ได้ติดตั้ง แต่เมื่อ hook ทำงานแล้วและคืน deny ต้องเคารพผล
- error เดิมซ้ำสองครั้งให้หยุด retry วิธีเดิม ตรวจ evidence เปลี่ยน hypothesis/tool แล้วทำต่อ
- หาก path ใต้ `~/Desktop` ตอบ `Operation not permitted` ให้ตรวจ macOS Files and Folders/Full Disk Access ก่อนสรุปว่าเป็น Claude permission

## Agent และ workflow routing

- shared workflow อยู่ใน `@karpathy.md`
- feature หลายขั้นใช้ pipeline: setup → research → spec → implement → audit → verify → review → ship
- orchestrator เป็น Planner และ coordinator ไม่ลงมือเปลี่ยน state เองเมื่อมี agent เฉพาะทาง
- งานเล็ก 1–2 ไฟล์ใช้ builder ตัวเดียว; review diff/PR ใช้ reviewer; สำรวจ codebase ใช้ Explore/researcher; ออกแบบระบบใช้ architect
- ใช้ agent team เฉพาะงานที่ parallel ได้จริงและแต่ละ teammate มี ownership แยกกัน หลีกเลี่ยงแก้ไฟล์เดียวกันพร้อมกัน
- teammate/subagent ต้องได้รับ task, scope, acceptance criteria, path และข้อจำกัดภาษาอย่างครบถ้วน เพราะไม่สืบทอด conversation history ทั้งหมด
- workflow mode เข้าเมื่อ user เรียกหรือขอโดยตรงเท่านั้น งานทั่วไป delegate ทีละตัว
- งาน config/docs/rename ที่ไม่แตะ logic ใช้ fast lane: builder/coder หนึ่งตัว + verifier

## Git และ GitHub workflow

- main thread ทำ read-only Git/GitHub ได้เอง
- การเปลี่ยน state เช่น commit, push, เปิด PR, tag หรือ branch cleanup ให้ใช้ `gitops` เมื่อ workflow/project กำหนด
- หลัง review และ verify ผ่านแล้ว การ commit, push feature branch และเปิด PR เป็น routine action ไม่ต้องถามเพิ่ม
- ก่อน push ต้องตรวจ current branch; ถ้าเป็น `main` หรือ `develop` ให้หยุด
- ต้อง push ด้วยรูปแบบที่ระบุ feature branch ชัดเจน เช่น `git push -u origin feature/example`
- ใช้ `git pull --ff-only` เป็นค่าเริ่มต้น; rebase ได้เฉพาะ feature branch ที่ยังควบคุมได้
- ห้าม force push
- ห้าม merge PR
- branch protection และ required checks เป็น authoritative boundary แม้ local policy จะอนุญาต routine push

## Repo scope

- current repository และ repository ภายใต้ `${HOME}/Desktop/Project` อยู่ใน Development Trust Zone
- ถ้างานระบุหลาย repository หรือ dependency contract ต้องแก้ข้าม repository ให้ทำได้ภายใน Zone โดยไม่ถามซ้ำ แต่ต้องแยก diff/test/commit ต่อ repository
- ถ้างานระบุ repository เดียวและไม่จำเป็นต้องแก้ sibling repository ห้ามขยาย scope เอง
- งานที่ user ระบุว่าเป็นการตั้งค่า Agent/tool อนุญาตให้แก้ `~/.claude/**` และ `~/.codex/**` ที่ไม่ใช่ credential file
- ห้ามอ่านหรือแก้ `~/.codex/auth.json`, `~/.claude/.credentials.json`, `~/.claude.json`, `~/.config/gh/**`, `~/.ssh/**`, keychain และ credential store โดยตรง
- repository/path นอก Development Trust Zone ต้องขอ approval หนึ่งครั้งพร้อมบอกเหตุผลและผลกระทบ

## Pipeline gate rules

กติกานี้สรุปจาก live run และ `pipeline-guide.md`:

- finding ระดับ BLOCKING/must-fix ที่เป็นการวิเคราะห์โค้ดและยังไม่มี reproduce evidence ต้องผ่าน skeptic ก่อน send-back
- finding ที่มีคำสั่งและ output reproduce failure ตรง claim หรือ RED จาก verifier ไม่ต้อง refute
- skeptic ต้องใช้ lens ต่างกันและตัดสินตามกติกาใน `pipeline-guide.md`; ห้าม clone prompt เดียวกันหลายเสียง
- coder ต้องทำ Coverage self-check เทียบ acceptance criteria ทุกข้อ ชี้ test ที่ขับ branch จริง และบันทึกช่องว่างใน `changes.md`
- งานหลาย task: task ที่ผ่าน audit/verify/review ให้ทำ checkpoint commit บน feature branch ทันทีโดยไม่ push; squash ได้ตอน Ship
- `state.md` ต้องมี `Environment constraints` และ `Known failures` เพื่อไม่พิสูจน์ข้อจำกัดหรือ failure เดิมซ้ำ
- คำตัดสิน PASS/APPROVE ที่อ้าง runtime behavior ต้องมี execution evidence เช่นเดียวกับ finding
- เมื่อพบ failure class หนึ่งตัว ต้อง sweep caller/path ที่อยู่ใน class เดียวกันและแนบ `Class sweep:`
- แยก `implement round` ออกจาก `[rework N/5]`; rework นับเมื่อส่งกลับ coder หลัง refute เท่านั้น
- agent เติม state log หนึ่งบรรทัดต่อการถูกเรียกหนึ่งรอบ ห้าม append ซ้ำตอน resume
- subagent ที่ส่ง final แล้วถือว่าจบ; ห้าม SendMessage ไป resume แบบไม่มี active task ให้ spawn ตัวใหม่พร้อม context แทน
- SendMessage ใช้เฉพาะ agent ที่ประกาศ `INCOMPLETE (background)` และรอ handoff
- workflow mode เข้าเฉพาะเมื่อ user เรียก `/orchestrate` หรือสั่งตรง งานทั่วไปห้ามเข้าเองจากจำนวนไฟล์หรือขนาดงาน
- scope ที่เป็น config/docs/rename ล้วนใช้ fast lane; หากพบ logic ใหม่กลางทางให้กลับไปเลือก workflow ใหม่

## Cache discipline

- ตั้ง model และ effort ตอนเริ่ม session แล้วหลีกเลี่ยงการสลับกลาง session
- persisted effort ฐานคือ `high`; ใช้ model routing ลดต้นทุนแทนการสลับ effort บ่อย
- `hooks/effort-guard.sh` ป้องกัน drift ได้ แต่ต้องไม่ทับ frontmatter ของ subagent
- session ที่ยาวมากและกำลังเริ่มงานหนักคนละเรื่อง ให้ `/clear` ก่อนเพื่อลด context ที่ไม่เกี่ยวข้อง

## Secrets, CI และ review

- ห้าม commit secret ทุกชนิด
- PR merge ได้ต่อเมื่อ required test/lint/check ผ่านครบ
- ห้าม merge เมื่อ check ไม่ผ่าน
- ห้ามปล่อย `.only`, `.skip` หรือ focused test ค้างโดยไม่มีเหตุผลที่ repository ยอมรับ
- coverage ห้ามลดต่ำกว่าเกณฑ์
- dependency ใหม่ต้องตรวจ license, maintenance status และ vulnerability
- lock file ต้อง commit และห้ามใช้เวอร์ชัน production แบบ `*` หรือ `latest`
- ห้าม commit โดยไม่ผ่าน review ตาม workflow ของ repository

## Destructive operations

- `rm -rf`, `git reset --hard`, `git clean -fd/-fdx`, ลบ branch แบบบังคับ และ destructive DB command ต้องยืนยัน target ก่อน
- บน production ห้าม `DROP`, `TRUNCATE` หรือ `DELETE` ที่ไม่กำหนดขอบเขตและไม่มี approval
- migration production ต้องมี backup, rollback plan และ verification plan
- คำสั่งทำลายข้อมูล production ต้องมี human confirmation เสมอ

## Deploy และ release

- production ต้องผ่าน staging ก่อน
- ทุก release ต้องมี rollback plan
- ห้าม deploy production เย็นวันศุกร์หรือก่อนวันหยุดยาว ยกเว้น hotfix ที่ user ระบุ
- release ต้องมี version tag และ changelog
- deploy, tag, publish และ merge เป็น user decision; Agent เตรียมหลักฐานและคำสั่งได้ แต่ห้ามตัดสินใจแทน

## Dependency rules

- ห้ามเพิ่ม dependency ใหม่โดยไม่ตรวจ license, maintenance status และความจำเป็น
- lock file เช่น `package-lock.json`, `pnpm-lock.yaml`, `composer.lock`, `poetry.lock` ต้อง commit
- ห้าม pin เวอร์ชัน production แบบลอย `*` หรือ `latest`
- ตรวจช่องโหว่ด้วยคำสั่งที่เหมาะกับ ecosystem เป็นส่วนหนึ่งของ CI

## การตรวจเมื่อเริ่ม session

เมื่อปัญหาเกี่ยวกับ permission/sandbox/config ให้ตรวจตามลำดับและอ้างผลจริง:

```text
/status
/permissions
/sandbox
claude doctor
claude auto-mode config
claude auto-mode critique
```

ห้ามสรุปว่าเป็น permission, network, auth หรือ hook จากอาการเพียงอย่างเดียว ต้องแยก layer และแนบ command/output ที่พิสูจน์ root cause
