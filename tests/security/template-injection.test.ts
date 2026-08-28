import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { renderClaude } from "../../src/adapters/claude/generate.ts";
import { renderTemplate, upsertBlock, BLOCK_END, BLOCK_START } from "../../src/config/merger.ts";
import { validateUserConfig } from "../../src/core/policy-loader.ts";
import { makeTestEnv } from "../helpers.ts";

test("template values cannot break managed block markers", () => {
  const out = renderTemplate("a {{x}} b", { x: "<!-- agents-adapter:end --> injected" });
  assert.ok(!out.includes(BLOCK_END));
  const block = upsertBlock("user text\n", out);
  assert.equal(block.split(BLOCK_START).length, 2);
  assert.equal(block.split(BLOCK_END).length, 2);
});

test("unknown template variables fail loudly", () => {
  assert.throws(() => renderTemplate("{{nope}}", {}));
});

test("user config rejects shell metacharacters and unsafe roots", () => {
  assert.throws(() => validateUserConfig({ version: 1, development_roots: ["/"], protected_branches: ["main"] }) && (() => { throw new Error("x"); })());
  assert.throws(() => validateUserConfig({ version: 1, development_roots: ["${HOME}/x"], protected_branches: ["main; rm -rf /"] }));
  assert.throws(() => validateUserConfig({ version: 1, development_roots: ["${HOME}/x"], protected_branches: ["main"], github: { owner: "$(whoami)" } }));
});

test("protected branch names with regex characters are escaped in generated Claude patterns", () => {
  const t = makeTestEnv((home) => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  });
  try {
    t.env.config.protected_branches = ["release/1.0"];
    const plan = renderClaude(t.env, { mode: "apply", previousManaged: {} });
    const settings = plan.changes.find((c) => c.path.endsWith("settings.json"))?.after ?? "";
    assert.ok(settings.includes("Bash(git push * release/1.0)"));
    JSON.parse(settings);
  } finally {
    t.cleanup();
  }
});
