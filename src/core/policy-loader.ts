import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { PolicyContext } from "./context.ts";
import type { Decision } from "./decisions.ts";
import { assertValid } from "./policy-validator.ts";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const POLICY_DIR = path.join(REPO_ROOT, "policy");

export interface MatrixRule {
  id: string;
  category: string;
  decision: Decision;
  description: string;
}

export interface PermissionMatrix {
  version: number;
  rules: MatrixRule[];
}

export interface ProtectedPaths {
  version: number;
  credential_paths: string[];
  credential_basenames: string[];
  credential_extensions: string[];
  system_config_paths: string[];
  credential_env_vars: string[];
}

export interface TrustedDefaults {
  version: number;
  always_writable: string[];
  agent_config_dirs: string[];
  excluded_commands: string[];
  public_registries: string[];
}

export interface UserConfig {
  version: number;
  development_roots: string[];
  protected_branches: string[];
  github?: { owner?: string };
  trusted_domains?: string[];
  development_env_patterns?: string[];
  production_env_patterns?: string[];
  pi?: { isolation_mode?: "host-macos" | "docker" | "gondolin" | "openshell" };
  adapters?: { claude?: boolean; codex?: boolean; pi?: boolean };
}

const DEFAULT_DEV_ENV = [".env", ".env.local", ".env.development", ".env.test", ".env.testing", ".env.integration"];
const DEFAULT_PROD_ENV = [".env.production", ".env.production.*", ".env.prod", ".env.prod.*"];

function readYaml<T>(file: string): T {
  return YAML.parse(fs.readFileSync(file, "utf8")) as T;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function loadMatrix(): PermissionMatrix {
  const matrix = readYaml<PermissionMatrix>(path.join(POLICY_DIR, "permission-matrix.yaml"));
  assertValid(matrix, readJson(path.join(POLICY_DIR, "schema", "permission-matrix.schema.json")), "permission-matrix.yaml");
  const ids = new Set<string>();
  for (const r of matrix.rules) {
    if (ids.has(r.id)) throw new Error(`duplicate rule id ${r.id}`);
    ids.add(r.id);
  }
  return matrix;
}

export function loadCorePolicy(): Record<string, unknown> {
  const core = readYaml<Record<string, unknown>>(path.join(POLICY_DIR, "core-policy.yaml"));
  assertValid(core, readJson(path.join(POLICY_DIR, "schema", "core-policy.schema.json")), "core-policy.yaml");
  return core;
}

export function loadProtectedPaths(): ProtectedPaths {
  return readYaml<ProtectedPaths>(path.join(POLICY_DIR, "protected-paths.yaml"));
}

export function loadTrustedDefaults(): TrustedDefaults {
  return readYaml<TrustedDefaults>(path.join(POLICY_DIR, "trusted-defaults.yaml"));
}

export function loadProvenance(): { version: number; rules: Record<string, unknown> } {
  return readYaml(path.join(POLICY_DIR, "provenance.yaml"));
}

export function validateUserConfig(raw: unknown): UserConfig {
  assertValid(raw, readJson(path.join(POLICY_DIR, "schema", "user-config.schema.json")), "user config");
  return raw as UserConfig;
}

export function defaultUserConfigPath(home = os.homedir()): string {
  return path.join(home, ".config", "agents-adapter", "config.yaml");
}

export function loadUserConfig(file: string): UserConfig {
  return validateUserConfig(readYaml<unknown>(file));
}

export function exampleUserConfig(): UserConfig {
  return loadUserConfig(path.join(REPO_ROOT, "config", "config.example.yaml"));
}

export interface ContextOptions {
  home?: string;
  tmpdir?: string;
  cwd?: string;
  realpath?: (p: string) => string;
}

/** สร้าง PolicyContext จาก user config + policy files (แทนค่า ${HOME}) */
export function buildContext(config: UserConfig, opts: ContextOptions = {}): PolicyContext {
  const home = opts.home ?? os.homedir();
  const tmpdir = opts.tmpdir ?? os.tmpdir();
  const cwd = opts.cwd ?? process.cwd();
  const protectedPaths = loadProtectedPaths();
  const defaults = loadTrustedDefaults();
  const expand = (p: string): string => p.replace(/\$\{HOME\}/g, home).replace(/\$\{TMPDIR\}/g, tmpdir);
  const ctx: PolicyContext = {
    home,
    tmpdir,
    cwd,
    developmentRoots: config.development_roots.map(expand),
    protectedBranches: config.protected_branches,
    devEnvPatterns: config.development_env_patterns ?? DEFAULT_DEV_ENV,
    prodEnvPatterns: config.production_env_patterns ?? DEFAULT_PROD_ENV,
    credentialPaths: protectedPaths.credential_paths.map(expand),
    credentialBasenames: protectedPaths.credential_basenames,
    credentialExtensions: protectedPaths.credential_extensions,
    systemConfigPaths: protectedPaths.system_config_paths.map(expand),
    alwaysWritable: defaults.always_writable.map(expand),
    agentConfigDirs: defaults.agent_config_dirs.map(expand),
  };
  if (opts.realpath) ctx.realpath = opts.realpath;
  return ctx;
}

/** รูปแบบ JSON ที่ runtime (Python hook / Pi extension) อ่าน: ไม่มี function */
export function serializableContext(ctx: PolicyContext): Omit<PolicyContext, "realpath" | "cwd"> {
  const { realpath: _r, cwd: _c, ...rest } = ctx;
  return rest;
}
