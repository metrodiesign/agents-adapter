import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEnvironment, type Environment } from "../src/config/loader.ts";
import { makeFixtureWorld, type FixtureWorld } from "../src/parity/harness.ts";

export interface TestEnv {
  world: FixtureWorld;
  env: Environment;
  cleanup: () => void;
}

/** environment ที่ชี้ home จำลอง พร้อม config ที่ development_roots = {ZONE} */
export function makeTestEnv(seed?: (home: string) => void): TestEnv {
  const world = makeFixtureWorld();
  const configPath = path.join(world.home, ".config", "agents-adapter", "config.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    [
      "version: 1",
      "development_roots:",
      `  - "\${HOME}/Desktop/Project"`,
      "protected_branches: [main, develop]",
      "github: { owner: example-owner }",
      "trusted_domains: [github.com, localhost]",
      "pi: { isolation_mode: host-macos }",
      "adapters: { claude: true, codex: true, pi: true }",
      "",
    ].join("\n"),
  );
  if (seed) seed(world.home);
  const env = resolveEnvironment({ home: world.home, configPath, cwd: world.cwd, deterministic: true });
  env.ctx.tmpdir = path.join(world.home, "tmp");
  env.ctx.alwaysWritable = [env.ctx.tmpdir];
  return { world, env, cleanup: world.cleanup };
}

export function tmpFile(content: string, name = "file"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-adapter-test-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}
