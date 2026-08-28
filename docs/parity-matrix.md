# Parity Matrix

ระดับ enforcement: `native` = permission rule ของ CLI, `runtime` = hook/extension, `isolation` = OS sandbox/container, `best-effort` = runtime เท่านั้นและมี isolation fallback, `unsupported` = ไม่มีทั้ง enforcement และ fallback (parity test fail)

ผลจริงมาจาก `node src/cli.ts verify` และ `tests/parity/parity.test.ts` (259 fixtures) ตารางนี้สรุปเชิงนโยบาย

| rule | decision | Claude | Codex | Pi host-macos | Pi isolated |
|---|---|---|---|---|---|
| FS_READ_SOURCE | ALLOW | native | native | native | native |
| FS_WRITE_SOURCE | ALLOW | native | native | native | native |
| FS_CREATE_PROJECT_FILE | ALLOW | native | native | native | native |
| OUTSIDE_TRUST_ZONE | ASK | native | native | runtime | isolation |
| SYSTEM_CONFIG_CHANGE | ASK | native | native | runtime | runtime |
| DEV_ENV_READ | ALLOW | native | native | native | native |
| DEV_ENV_WRITE | ALLOW | native | native | native | native |
| DEV_ENV_PRINT | DENY | native (autoMode hard_deny) | runtime (hook) | runtime | runtime |
| PROD_ENV_READ | DENY | native (deny + sandbox) | runtime + filesystem deny | best-effort -> isolation | isolation |
| PROD_ENV_WRITE | DENY | native | runtime + filesystem deny | runtime | isolation |
| CREDENTIAL_READ | DENY | native (deny + sandbox.credentials) | runtime + filesystem deny | best-effort -> isolation | isolation |
| CREDENTIAL_WRITE | DENY | native | runtime + filesystem deny | runtime | isolation |
| BUILD / TEST / LINT | ALLOW | native | native | native | native |
| SHELL_READ_ONLY | ALLOW | native | native | native | native |
| UNKNOWN_COMMAND | ASK | native (classifier) | native (approval) | runtime | runtime |
| LOCAL_DEP_INSTALL | ALLOW | native | native | native | native |
| GLOBAL_DEP_INSTALL | ASK | native | native (rules prompt) | runtime | runtime |
| LOCAL_DOCKER_BUILD / LOCAL_DOCKER_UP | ALLOW | native | native | native | native |
| DOCKER_PRUNE / DOCKER_DELETE_VOLUME | ASK | native | native (rules prompt) | runtime | runtime |
| GIT_STATUS / GIT_COMMIT | ALLOW | native | native | native | native |
| GIT_PUSH_FEATURE | ALLOW | native | native (rules allow) | native | native |
| GIT_PUSH_BARE | DENY | native | runtime (hook) | runtime | runtime |
| GIT_PUSH_HEAD | DENY | native | runtime | runtime | runtime |
| GIT_PUSH_PROTECTED | DENY | native | runtime + rules forbidden | runtime | runtime |
| GIT_FORCE_PUSH | DENY | native | runtime + rules forbidden | runtime | runtime |
| GIT_REMOTE_DELETE / GIT_REMOTE_CHANGE / GIT_RESET_HARD / GIT_CLEAN / GIT_BRANCH_FORCE_DELETE | ASK | native | native (rules prompt) | runtime | runtime |
| GH_READ / GH_PR_CREATE / GH_PR_UPDATE | ALLOW | native | native | native | native |
| GH_PR_MERGE | DENY | native | runtime + rules forbidden + connector prompt | runtime | runtime |
| GH_REPO_CREATE / GH_AUTH_CHANGE | ASK | native | native (rules prompt) | runtime | runtime |
| GH_REPO_DELETE / GH_SECRET_MANAGE / PUBLIC_GIST | DENY | native | runtime + rules forbidden | runtime | runtime |
| GH_DELETE_FILE | ASK | native (n/a: connector เป็น Codex-only) | connector approval prompt | runtime | runtime |
| PIPE_TO_SHELL | DENY | native | runtime | runtime | runtime |
| PI_SHARE | DENY | native (ไม่มี share command) | native (ไม่มี share command) | runtime (input + tool_call) | runtime |
| STAGING_DEPLOY / PROD_DEPLOY / PROD_DB_WRITE / PROD_DESTRUCTIVE_DB / LOCAL_DESTRUCTIVE_DB | ASK | native | native (rules prompt) + hook context | runtime | runtime |
| DESTRUCTIVE_DELETE | ASK | native | native (rules prompt) | runtime | runtime |
| SAFETY_BYPASS | DENY | native (`disableBypassPermissionsMode`) | runtime + requirements (`:danger-full-access = false`) | best-effort (`pi -ne` ที่ user พิมพ์เองบังคับไม่ได้) | isolation |
| PRIVILEGE_ESCALATION | DENY | native | runtime + rules forbidden | runtime | runtime |
| SHELL_SUBSTITUTION | ASK | native (classifier) | native (rules skip -> approval) | runtime | runtime |

## Unsupported cases

- Pi `host-macos` โดยไม่มี docker/gondolin/openshell: `CREDENTIAL_READ`, `PROD_ENV_READ`, `SAFETY_BYPASS` เป็น UNSUPPORTED และ `agents-adapter verify` รายงาน; parity test (`tests/parity/parity.test.ts`) มีกรณีนี้เป็น negative test
- CLI ที่ไม่ได้ติดตั้ง: adapter นั้นรายงาน UNSUPPORTED ทุก rule ใน doctor
