import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import type { PolicyContext } from "../core/context.ts";
import { buildContext, defaultUserConfigPath, exampleUserConfig, loadTrustedDefaults, loadUserConfig, REPO_ROOT, type UserConfig } from "../core/policy-loader.ts";
import { validateConfigSemantics } from "./validator.ts";

export interface Environment {
  home: string;
  tmpdir: string;
  cwd: string;
  configPath: string;
  config: UserConfig;
  ctx: PolicyContext;
  repoRoot: string;
  stateDir: string;
  /** ค่าคงที่สำหรับ generated fixtures: ไม่ใช้เวลาจริง */
  deterministic: boolean;
}

export interface EnvOptions {
  home?: string;
  cwd?: string;
  configPath?: string;
  useExampleIfMissing?: boolean;
  deterministic?: boolean;
}

export function resolveEnvironment(opts: EnvOptions = {}): Environment {
  const home = opts.home ?? process.env.AGENTS_ADAPTER_HOME ?? os.homedir();
  const configPath = opts.configPath ?? process.env.AGENTS_ADAPTER_CONFIG_FILE ?? defaultUserConfigPath(home);
  let config: UserConfig;
  if (fs.existsSync(configPath)) {
    config = loadUserConfig(configPath);
  } else if (opts.useExampleIfMissing) {
    config = exampleUserConfig();
  } else {
    throw new Error(`config not found: ${configPath} (run \`agents-adapter init\` first)`);
  }
  validateConfigSemantics(config);
  const tmpdir = opts.deterministic ? "/tmp" : os.tmpdir();
  const cwd = opts.cwd ?? process.cwd();
  const ctx = buildContext(config, { home, tmpdir, cwd });
  return {
    home,
    tmpdir,
    cwd,
    configPath,
    config,
    ctx,
    repoRoot: REPO_ROOT,
    stateDir: path.join(home, ".local", "state", "agents-adapter"),
    deterministic: opts.deterministic ?? false,
  };
}

export function writeInitialConfig(configPath: string, home: string): boolean {
  if (fs.existsSync(configPath)) return false;
  const example = fs.readFileSync(path.join(REPO_ROOT, "config", "config.example.yaml"), "utf8");
  const doc = YAML.parseDocument(example);
  doc.setIn(["development_roots"], [path.join(home, "Desktop", "Project").replace(home, "${HOME}")]);
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, doc.toString(), { mode: 0o600 });
  return true;
}

export function trustedDomains(config: UserConfig): string[] {
  const defaults = loadTrustedDefaults().public_registries;
  return Array.from(new Set([...(config.trusted_domains ?? []), ...defaults]));
}
