import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { classifyPath } from "../../src/core/paths.ts";
import { makeTestEnv } from "../helpers.ts";

test("path traversal and symlink escape resolve to credential paths", () => {
  const t = makeTestEnv();
  try {
    const ctx = t.env.ctx;
    assert.equal(classifyPath("read", "../../../.ssh/config", ctx).ruleId, "CREDENTIAL_READ");
    assert.equal(classifyPath("read", "link-to-ssh/config", ctx).ruleId, "CREDENTIAL_READ");
    assert.equal(classifyPath("read", "link-to-ssh/not-yet-created", ctx).ruleId, "CREDENTIAL_READ");
    assert.equal(classifyPath("write", path.join(t.world.cwd, "src", "..", "..", "..", "..", ".aws", "credentials"), ctx).ruleId, "CREDENTIAL_WRITE");
  } finally {
    t.cleanup();
  }
});

test("symlink inside zone pointing outside zone is outside", () => {
  const t = makeTestEnv();
  try {
    fs.symlinkSync(path.join(t.world.home, "Documents"), path.join(t.world.cwd, "docs-link"));
    assert.equal(classifyPath("write", "docs-link/notes.md", t.env.ctx).ruleId, "OUTSIDE_TRUST_ZONE");
  } finally {
    t.cleanup();
  }
});

test("env pattern matching is basename based and case sensitive like the filesystem", () => {
  const t = makeTestEnv();
  try {
    const ctx = t.env.ctx;
    assert.equal(classifyPath("read", "deep/nested/.env.production", ctx).ruleId, "PROD_ENV_READ");
    assert.equal(classifyPath("read", ".env.production.local", ctx).ruleId, "PROD_ENV_READ");
    assert.equal(classifyPath("read", ".env.prod.eu", ctx).ruleId, "PROD_ENV_READ");
    assert.equal(classifyPath("read", ".env", ctx).ruleId, "DEV_ENV_READ");
    assert.equal(classifyPath("read", ".env.integration", ctx).ruleId, "DEV_ENV_READ");
    assert.equal(classifyPath("read", ".environment.md", ctx).ruleId, "FS_READ_SOURCE");
    assert.equal(classifyPath("read", "production.env.example", ctx).ruleId, "FS_READ_SOURCE");
  } finally {
    t.cleanup();
  }
});

test("temp and cache directories are writable, system dirs read-only", () => {
  const t = makeTestEnv();
  try {
    const ctx = t.env.ctx;
    assert.equal(classifyPath("write", path.join(ctx.tmpdir, "x.txt"), ctx).decision, "ALLOW");
    assert.equal(classifyPath("read", "/usr/lib/node_modules/x/index.js", ctx).decision, "ALLOW");
    assert.equal(classifyPath("write", "/usr/local/bin/x", ctx).decision, "ASK");
    assert.equal(classifyPath("write", path.join(ctx.home, ".zshrc"), ctx).ruleId, "SYSTEM_CONFIG_CHANGE");
  } finally {
    t.cleanup();
  }
});
