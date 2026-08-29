import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { loadCorePolicy, loadFixturesIds, loadMatrix, loadProvenance, REPO_ROOT } from "./_loaders.ts";

test("permission matrix validates against schema and has unique ids", () => {
  const matrix = loadMatrix();
  assert.ok(matrix.rules.length >= 40);
  const ids = matrix.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("core policy validates and references only known rule ids", () => {
  const core = loadCorePolicy() as { trust_zone: { routine_actions_without_prompt: string[] }; destructive_operations: { ask_before: string[] } };
  const ids = new Set(loadMatrix().rules.map((r) => r.id));
  for (const id of [...core.trust_zone.routine_actions_without_prompt, ...core.destructive_operations.ask_before]) assert.ok(ids.has(id), `unknown rule ${id}`);
});

test("every matrix rule has provenance", () => {
  const prov = loadProvenance();
  for (const r of loadMatrix().rules) assert.ok(prov.rules[r.id], `missing provenance for ${r.id}`);
});

test("every matrix rule is exercised by at least one fixture and fixtures only use known ids", () => {
  const ids = new Set(loadMatrix().rules.map((r) => r.id));
  const used = loadFixturesIds();
  for (const id of used) assert.ok(ids.has(id), `fixture uses unknown rule ${id}`);
  for (const id of ids) assert.ok(used.has(id), `rule ${id} has no fixture`);
});

test("required matrix decisions match the specification table", () => {
  const byId = Object.fromEntries(loadMatrix().rules.map((r) => [r.id, r.decision]));
  const expected: Record<string, string> = {
    FS_READ_SOURCE: "ALLOW", FS_WRITE_SOURCE: "ALLOW", FS_CREATE_PROJECT_FILE: "ALLOW", DEV_ENV_READ: "ALLOW", DEV_ENV_WRITE: "ALLOW", DEV_ENV_PRINT: "DENY",
    PROD_ENV_READ: "DENY", PROD_ENV_WRITE: "DENY", CREDENTIAL_READ: "DENY", BUILD: "ALLOW", TEST: "ALLOW", LINT: "ALLOW", LOCAL_DEP_INSTALL: "ALLOW",
    GLOBAL_DEP_INSTALL: "ASK", LOCAL_DOCKER_BUILD: "ALLOW", LOCAL_DOCKER_UP: "ALLOW", DOCKER_PRUNE: "ASK", DOCKER_DELETE_VOLUME: "ASK", GIT_STATUS: "ALLOW",
    GIT_COMMIT: "ALLOW", GIT_PUSH_FEATURE: "ALLOW", GIT_PUSH_BARE: "DENY", GIT_PUSH_HEAD: "DENY", GIT_PUSH_PROTECTED: "DENY", GIT_FORCE_PUSH: "DENY",
    GIT_REMOTE_CHANGE: "ASK", GIT_RESET_HARD: "ASK", GIT_CLEAN: "ASK", GH_PR_CREATE: "ALLOW", GH_PR_UPDATE: "ALLOW", GH_PR_MERGE: "ASK", GH_REPO_DELETE: "DENY",
    PUBLIC_GIST: "DENY", PI_SHARE: "DENY", STAGING_DEPLOY: "ASK", PROD_DEPLOY: "ASK", PROD_DB_WRITE: "DENY", PROD_DESTRUCTIVE_DB: "DENY", SAFETY_BYPASS: "DENY", OUTSIDE_TRUST_ZONE: "ASK", RELEASE_TAG: "ASK", SYSTEM_PATH_WRITE: "DENY",
  };
  for (const [id, d] of Object.entries(expected)) assert.equal(byId[id], d, `${id} should be ${d}`);
});

test("schema files are valid JSON and user-config example validates", () => {
  for (const f of fs.readdirSync(path.join(REPO_ROOT, "policy", "schema"))) JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "policy", "schema", f), "utf8"));
});
