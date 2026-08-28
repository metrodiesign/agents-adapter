/**
 * Provider-neutral classifier: input action -> Verdict (ALLOW/ASK/DENY + rule id)
 * ตรรกะนี้ถูก mirror ใน runtime/codex/hooks/agents_adapter_policy.py (Python)
 * parity test เทียบทั้งสอง implementation กับ fixture เดียวกัน
 */
import type { PolicyContext } from "./context.ts";
import { type Verdict, strictest, verdict } from "./decisions.ts";
import { classifyPath, looksLikePath, type PathOp } from "./paths.ts";
import { commandName, commandSubstitutions, expandLiteralBindings, parseCommand, type SimpleCommand } from "./shell.ts";

const BYPASS_FLAGS = [
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
  "--no-sandbox",
];
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SHELL_KEYWORDS = new Set(["for", "select", "case", "while", "until", "if", "then", "else", "elif", "fi", "do", "done", "esac", "!", "{", "}"]);
const PRINT_CMDS = new Set(["cat", "less", "more", "head", "tail", "grep", "rg", "egrep", "fgrep", "awk", "cut", "strings", "base64", "xxd", "od", "hexdump", "jq", "yq", "sed", "bat", "nl", "tac", "pbcopy", "open"]);
const READ_ONLY_CMDS = new Set([
  "ls", "pwd", "echo", "printf", "cat", "head", "tail", "less", "more", "grep", "rg", "egrep", "fgrep", "find", "fd", "wc", "sort", "uniq", "cut",
  "awk", "sed", "diff", "file", "stat", "du", "df", "which", "whereis", "type", "tree", "date", "whoami", "uname", "env", "printenv", "true",
  "false", "test", "[", "jq", "yq", "xargs", "tr", "basename", "dirname", "realpath", "readlink", "ps", "sleep", "cd", "export", "source", ".",
  "alias", "man", "bat", "nl", "tac", "hostname", "id", "kill", "pkill", "killall", "pgrep", "pidof", "lsof", "netstat", "ping", "curl", "wget", "tee", "mkdir",
  "touch", "cp", "mv", "ln", "chmod", "chown", "truncate", "install", "rmdir", "patch", "unzip", "zip", "tar", "gzip", "gunzip", "rm", "column",
  "seq", "expr", "bc", "md5", "md5sum", "shasum", "sha256sum", "openssl", "ssh-keygen", "cmp", "comm", "join", "paste", "split", "rev", "fold",
  "watch", "time", "wait", "clear", "tput", "stty", "read", "set", "unset", "shift", "exit", "return", "trap", "ulimit", "umask", "declare", "local", "eval",
]);
const WRITE_CMDS = new Set(["tee", "mkdir", "touch", "cp", "mv", "ln", "chmod", "chown", "truncate", "install", "rmdir", "patch", "unzip", "tar", "rm", "sed"]);
const BUILD_CMDS = new Set([
  "make", "cmake", "ninja", "tsc", "vite", "webpack", "esbuild", "rollup", "next", "nuxt", "gradle", "gradlew", "mvn", "mvnw", "xcodebuild", "swift",
  "node", "python", "python3", "ruby", "bundle", "npx", "pnpx", "bunx", "php", "deno", "tsx", "ts-node", "dotnet", "cargo", "go", "javac", "java",
  "rustc", "gcc", "clang", "g++", "zig", "elixir", "mix", "artisan", "rake", "rails", "flutter", "pod", "fastlane", "turbo", "nx", "lerna", "bun",
]);
const TEST_CMDS = new Set(["pytest", "jest", "vitest", "mocha", "phpunit", "playwright", "cypress", "karma", "ava", "tap", "rspec", "minitest", "nunit", "xunit", "codecept", "pest", "behat"]);
const LINT_CMDS = new Set([
  "eslint", "prettier", "ruff", "black", "flake8", "mypy", "pylint", "isort", "phpstan", "psalm", "php-cs-fixer", "pint", "golangci-lint", "gofmt", "goimports",
  "clippy", "rustfmt", "rubocop", "stylelint", "biome", "markdownlint", "markdownlint-cli2", "shellcheck", "hadolint", "swiftlint", "swiftformat", "ktlint", "detekt", "tflint", "yamllint", "actionlint", "oxlint", "dprint",
]);
const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx", "composer", "gem", "brew", "poetry", "uv", "cargo", "go", "conda", "apt", "apt-get", "yum", "dnf", "pacman", "port", "choco", "winget", "snap"]);
const DEPLOY_CMDS = new Set(["vercel", "netlify", "firebase", "fly", "flyctl", "heroku", "serverless", "sls", "sam", "cdk", "pulumi", "terraform", "tofu", "kubectl", "helm", "aws", "gcloud", "az", "cap", "ansible-playbook", "wrangler", "railway", "render", "doctl", "eb", "copilot"]);
const REMOTE_CMDS = new Set(["ssh", "scp", "rsync", "sftp"]);
const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlcmd", "mongosh", "mongo", "redis-cli", "sqlite3", "clickhouse-client", "cqlsh"]);
const DB_DESTRUCTIVE_SQL = /\b(drop\s+(database|table|schema)|truncate|flushall|flushdb|dropdatabase|deleteMany\(\s*\{?\s*\}?\s*\))/i;
const PROD_MARKER = /(^|[^a-z])(prod|production)([^a-z]|$)/i;

interface Ctx {
  ctx: PolicyContext;
}

export function classifyCommand(command: string, ctx: PolicyContext, depth = 0): Verdict {
  // for VAR in <literal>; VAR=<literal>: ตัดสินจากค่าจริงทุก combination แทน ASK
  const variants = depth < 4 ? expandLiteralBindings(command) : [];
  if (variants.length > 0) return strictest(variants.map((v) => classifyCommandOnce(v, ctx, depth + 1)));
  return classifyCommandOnce(command, ctx, depth);
}

function classifyCommandOnce(command: string, ctx: PolicyContext, depth: number): Verdict {
  const segments = parseCommand(command);
  if (segments.length === 0) return verdict("ALLOW", "SHELL_READ_ONLY", "empty command");
  const verdicts: Verdict[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const next = segments[i + 1];
    verdicts.push(...classifySegment(seg, next, { ctx }));
  }
  // command ภายใน $(...) / `...` ยังถูก classify แยก: ASK ของ segment นอกคงอยู่ แต่ inner ที่ DENY ต้องชนะ
  if (depth < 4) for (const inner of commandSubstitutions(command)) verdicts.push(classifyCommand(inner, ctx, depth + 1));
  return strictest(verdicts);
}

function classifySegment(seg: SimpleCommand, next: SimpleCommand | undefined, c: Ctx): Verdict[] {
  const out: Verdict[] = [];
  let words = seg.words;
  // shell keyword นำหน้า (do/then/else/if/while/!/{ ...) ไม่ใช่ command: ตัดออกก่อนให้ name/path/print ตรวจจาก command จริง
  while (words.length > 0 && SHELL_KEYWORDS.has(words[0]) && words[0] !== "for" && words[0] !== "select" && words[0] !== "case") words = words.slice(1);
  const name = commandName(words);

  // 1. bypass flag: DENY ก่อนอย่างอื่น
  const bypass = findBypass(words);
  if (bypass) out.push(verdict("DENY", "SAFETY_BYPASS", `bypass flag: ${bypass}`, bypass));

  // 2. per-command (มาก่อน path เพื่อให้ tie ที่ระดับเดียวกันรายงาน rule ของคำสั่ง)
  if (words.length > 0) out.push(...classifyByCommand(name, words, seg, next, c));

  // 3. path ใน argument และ redirection (credential/prod env DENY ชนะทุกอย่างผ่าน strictest)
  out.push(...classifyWordPaths(words === seg.words ? seg : { ...seg, words }, name, c));

  // 4. substitution: ทำให้ ALLOW กลายเป็น ASK ยกเว้น $(git <read-only query>) ล้วนที่ส่งให้ command ที่ไม่ใช่ print/write/delete
  if (seg.hasSubstitution && !verifiedGitQuerySubstitution(seg, name) && !outputSinkSubstitution(seg, name)) {
    out.push(verdict("ASK", "SHELL_SUBSTITUTION", "command substitution cannot be verified", seg.words.length > 0 ? seg.words.join(" ") : "subshell"));
  }
  return out;
}

/** git query ที่ output เป็น SHA/ref/path เท่านั้น (ไม่มี --format/--pretty/--sq-quote ให้คุม output); flag ที่รับได้เป็น allowlist */
const GIT_QUERY_SUBS = new Set(["rev-parse", "merge-base", "show-ref", "rev-list"]);
const GIT_QUERY_FLAGS = new Set(["--show-toplevel", "--git-dir", "--git-common-dir", "--abbrev-ref", "--verify", "--short", "--quiet", "-q", "--is-inside-work-tree", "--count", "--max-count", "--hash", "--heads", "--tags", "--all", "--octopus", "--is-ancestor"]);
const GIT_QUERY_SUB_RE = /\$\(\s*git\s+(\S+)([^$`()]*)\)/g;

/** echo/printf แค่พิมพ์ argument: ค่าที่ขยายมาทำอะไรไม่ได้ ส่วน command ใน $(...) ถูก classify แยกอยู่แล้ว (DENY ชนะ) */
const OUTPUT_SINKS = new Set(["echo", "printf"]);

function outputSinkSubstitution(seg: SimpleCommand, name: string): boolean {
  if (!OUTPUT_SINKS.has(name)) return false;
  return ![...seg.redirectWrites, ...seg.redirectReads].some((w) => /[$`(]/.test(w));
}

function verifiedGitQuerySubstitution(seg: SimpleCommand, name: string): boolean {
  if (PRINT_CMDS.has(name) || WRITE_CMDS.has(name) || name === "rm" || name === "rmdir") return false;
  // git push <remote> $(git branch --show-current): branch ปลายทางตรวจไม่ได้ ต้องคง ASK
  if (name === "git" && gitSubcommand(seg.words).sub === "push") return false;
  if ([...seg.redirectWrites, ...seg.redirectReads].some((w) => /[$`(]/.test(w))) return false;
  let sawQuery = false;
  const rest = seg.words.join(" ").replace(GIT_QUERY_SUB_RE, (_m, sub: string, args: string) => {
    if (!GIT_QUERY_SUBS.has(sub)) return "$";
    // flag นอก allowlist (เช่น --format, --sq-quote) อาจทำให้ output กลายเป็น flag ของ command นอก
    if (args.split(/\s+/).some((a) => a.startsWith("-") && !GIT_QUERY_FLAGS.has(a.split("=")[0]))) return "$";
    sawQuery = true;
    return "";
  });
  return sawQuery && !/[$`(]/.test(rest);
}

function findBypass(words: string[]): string | null {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lw = w.toLowerCase();
    if (BYPASS_FLAGS.some((f) => lw === f || lw.startsWith(f + "="))) return w;
    if (lw.startsWith("--permission-mode")) {
      const val = lw.includes("=") ? lw.split("=")[1] : (words[i + 1] ?? "").toLowerCase();
      if (val === "bypasspermissions") return `${w} bypassPermissions`;
    }
    if (lw === "--sandbox" || lw === "-s" || lw.startsWith("--sandbox=")) {
      const val = lw.includes("=") ? lw.split("=")[1] : (words[i + 1] ?? "").toLowerCase();
      if (val === "danger-full-access") return `${w} danger-full-access`;
    }
    if (lw === "-a" && words[i + 1]?.toLowerCase() === "never") return "-a never";
    if (lw.startsWith("--ask-for-approval") && ((lw.includes("=") ? lw.split("=")[1] : words[i + 1]) ?? "").toLowerCase() === "never" && words.some((x) => x.toLowerCase().includes("danger"))) return "approval never + danger";
    if (lw === "-ne" || lw === "--no-extensions") return w;
  }
  return null;
}

function classifyWordPaths(seg: SimpleCommand, name: string, c: Ctx): Verdict[] {
  const out: Verdict[] = [];
  const isPrint = PRINT_CMDS.has(name) && !(name === "sed" && seg.words.some((w) => w === "-i" || w.startsWith("-i")));
  const isWrite = WRITE_CMDS.has(name) && !(name === "sed" && !seg.words.some((w) => w === "-i" || w.startsWith("-i")));
  const isDelete = name === "rm" || name === "rmdir";
  const args = seg.words.slice(1).filter((w) => !w.startsWith("-") || w.includes("/"));

  for (const w of args) {
    if (!looksLikePath(w, c.ctx)) continue;
    const op: PathOp = isDelete ? "delete" : isWrite && isWriteTarget(name, w, args) ? "write" : "read";
    const v = classifyPath(op, w, c.ctx);
    if (v.ruleId === "DEV_ENV_READ" && isPrint) {
      out.push(verdict("DENY", "DEV_ENV_PRINT", `printing development env: ${w}`, v.target));
      continue;
    }
    out.push(v);
  }
  for (const w of seg.redirectWrites) {
    if (w === "/dev/null" || w === "/dev/stdout" || w === "/dev/stderr") continue;
    out.push(classifyPath("write", w, c.ctx));
  }
  for (const w of seg.redirectReads) {
    const v = classifyPath("read", w, c.ctx);
    if (v.ruleId === "DEV_ENV_READ" && (isPrint || name === "" )) out.push(verdict("DENY", "DEV_ENV_PRINT", `printing development env: ${w}`, v.target));
    else out.push(v);
  }
  return out;
}

function isWriteTarget(name: string, word: string, args: string[]): boolean {
  if (name === "cp" || name === "mv" || name === "ln" || name === "install") {
    const positional = args.filter((a) => !a.startsWith("-"));
    return positional.length >= 2 ? word === positional[positional.length - 1] : true;
  }
  if (name === "tar" || name === "unzip" || name === "patch") return false;
  return true;
}

function classifyByCommand(name: string, words: string[], seg: SimpleCommand, next: SimpleCommand | undefined, c: Ctx): Verdict[] {
  const ctx = c.ctx;
  const lower = words.map((w) => w.toLowerCase());
  const joined = words.join(" ");

  if (SHELL_KEYWORDS.has(name)) {
    // for/while/if ... เป็น shell keyword ไม่ใช่ command: ตัดสินจาก command ที่ตามหลัง (ถ้ามี)
    if (name === "for" || name === "select" || name === "case") return [verdict("ALLOW", "SHELL_READ_ONLY", `shell keyword: ${name}`)];
    const rest = words.slice(1);
    if (rest.length === 0) return [verdict("ALLOW", "SHELL_READ_ONLY", `shell keyword: ${name}`)];
    return classifyByCommand(commandName(rest), rest, seg, next, c);
  }
  if (name === "sudo" || name === "doas" || name === "su") return [verdict("DENY", "PRIVILEGE_ESCALATION", `privileged execution: ${name}`, name)];
  if (SHELL_NAMES.has(name) && seg.pipedFromPrevious) return [verdict("DENY", "PIPE_TO_SHELL", "piping remote content into shell")];
  if ((name === "curl" || name === "wget") && next && SHELL_NAMES.has(commandName(next.words)) && next.pipedFromPrevious) {
    return [verdict("DENY", "PIPE_TO_SHELL", `${name} piped into shell`)];
  }
  if (name === "git") return [classifyGit(words, ctx)];
  if (name === "gh") return [classifyGh(words)];
  if (name === "docker" || name === "docker-compose" || name === "podman") return [classifyDocker(name, words)];
  if (PKG_MANAGERS.has(name)) return [classifyPackageManager(name, lower)];
  if (name === "rm") {
    const flags = words.slice(1).filter((w) => w.startsWith("-") && !w.startsWith("--")).join("");
    const long = words.slice(1).filter((w) => w.startsWith("--"));
    const recursive = /r/i.test(flags) || long.includes("--recursive");
    const force = flags.includes("f") || long.includes("--force");
    if (recursive && force) return [verdict("ASK", "DESTRUCTIVE_DELETE", `recursive force delete: ${joined}`, words.slice(1).filter((w) => !w.startsWith("-")).join(" "))];
    return [verdict("ALLOW", "FS_WRITE_SOURCE", "delete file")];
  }
  if (name === "pi" || name === "claude" || name === "codex") return [verdict("ALLOW", "BUILD", `agent CLI: ${name}`)];
  if (DB_CLIENTS.has(name) || name === "dropdb" || name === "prisma" || name === "sequelize" || name === "knex" || name === "alembic" || name === "typeorm") {
    return [classifyDatabase(name, words, joined)];
  }
  if (DEPLOY_CMDS.has(name)) return [classifyDeploy(name, lower, joined)];
  if (REMOTE_CMDS.has(name)) {
    const remote = words.slice(1).find((w) => !w.startsWith("-") && (w.includes("@") || /^[^/]+:/.test(w)));
    if (remote) return [verdict("ASK", "OUTSIDE_TRUST_ZONE", `remote host operation: ${name} ${remote}`, remote)];
    return [verdict("ALLOW", "SHELL_READ_ONLY", `${name} local`)];
  }
  if (name === "php" && lower[1] === "artisan") return [classifyArtisan(lower, joined)];
  if (name === "rails" || name === "rake" || name === "bin/rails") {
    if (lower.some((w) => /^db:(reset|drop|schema:load|purge)/.test(w))) return [prodOrLocalDestructive(joined)];
  }
  if (name === "dotnet") {
    if (lower[1] === "ef" && lower[2] === "database" && lower[3] === "drop") return [prodOrLocalDestructive(joined)];
    if (lower[1] === "test") return [verdict("ALLOW", "TEST", "dotnet test")];
    if (lower[1] === "tool" && lower.includes("-g")) return [verdict("ASK", "GLOBAL_DEP_INSTALL", joined)];
    return [verdict("ALLOW", "BUILD", joined)];
  }
  if (name === "go" && lower[1] === "test") return [verdict("ALLOW", "TEST", "go test")];
  if (name === "cargo" && lower[1] === "test") return [verdict("ALLOW", "TEST", "cargo test")];
  if (name === "cargo" && lower[1] === "clippy") return [verdict("ALLOW", "LINT", "cargo clippy")];
  if (TEST_CMDS.has(name)) return [verdict("ALLOW", "TEST", name)];
  if (LINT_CMDS.has(name)) return [verdict("ALLOW", "LINT", name)];
  if (BUILD_CMDS.has(name)) {
    if ((name === "npx" || name === "pnpx" || name === "bunx") && words[1]) {
      const inner = commandName([words[1]]);
      if (TEST_CMDS.has(inner)) return [verdict("ALLOW", "TEST", joined)];
      if (LINT_CMDS.has(inner)) return [verdict("ALLOW", "LINT", joined)];
      if (["prisma", "sequelize", "knex", "typeorm"].includes(inner)) return [classifyDatabase(inner, words.slice(1), words.slice(1).join(" "))];
    }
    return [verdict("ALLOW", "BUILD", name)];
  }
  if (READ_ONLY_CMDS.has(name)) {
    if (name === "chmod" || name === "chown") {
      const target = words.slice(1).filter((w) => !w.startsWith("-"));
      if (target.length === 0) return [verdict("ALLOW", "SHELL_READ_ONLY", name)];
    }
    return [verdict("ALLOW", "SHELL_READ_ONLY", name)];
  }
  if (SHELL_NAMES.has(name)) {
    // `bash scripts/x.sh args` (ไม่ใช่ -c ซึ่ง parser unwrap ไปแล้ว): ตัดสินจาก path ของ script
    const script = words.slice(1).find((w) => !w.startsWith("-"));
    if (script === undefined) return [verdict("ASK", "UNKNOWN_COMMAND", `interactive shell: ${name}`, name)];
    const v = classifyPath("read", script, ctx);
    if (v.decision !== "ALLOW") return [v];
    return [verdict("ALLOW", "BUILD", `shell script: ${script}`)];
  }
  if (name.endsWith(".sh") || name.endsWith(".py") || name.endsWith(".js") || name.endsWith(".ts")) {
    const v = classifyPath("read", words[0], ctx);
    if (v.decision !== "ALLOW") return [v];
    return [verdict("ALLOW", "BUILD", `project script: ${words[0]}`)];
  }
  return [verdict("ASK", "UNKNOWN_COMMAND", `unknown command: ${name}`, name)];
}

/** ตัด global option ของ git (-C dir, -c k=v, --git-dir=...) */
function gitSubcommand(words: string[]): { sub: string; args: string[] } {
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (w === "-C" || w === "-c") {
      i += 2;
      continue;
    }
    if (w.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  return { sub: (words[i] ?? "").toLowerCase(), args: words.slice(i + 1) };
}

const GIT_READ = new Set(["status", "diff", "log", "show", "blame", "fetch", "ls-files", "ls-remote", "rev-parse", "describe", "shortlog", "reflog", "grep", "cat-file", "show-ref", "for-each-ref", "worktree", "config", "help", "version", "--version", "remote", "branch", "tag", "stash", "name-rev", "merge-base", "cherry", "bisect", "count-objects", "fsck", "gc", "notes"]);
const GIT_LOCAL_WRITE = new Set(["add", "commit", "switch", "checkout", "merge", "rebase", "cherry-pick", "revert", "restore", "mv", "rm", "apply", "am", "init", "pull", "submodule", "sparse-checkout", "mergetool", "format-patch", "clone", "reset"]);

export function classifyGit(words: string[], ctx: PolicyContext): Verdict {
  const { sub, args } = gitSubcommand(words);
  const lower = args.map((a) => a.toLowerCase());
  if (sub === "push") return classifyGitPush(args, ctx);
  if (sub === "remote") {
    if (["add", "set-url", "remove", "rm", "rename", "set-head", "prune"].includes(lower[0] ?? "")) return verdict("ASK", "GIT_REMOTE_CHANGE", `git remote ${lower[0]}`, lower.slice(0, 2).join(" "));
    return verdict("ALLOW", "GIT_STATUS", "git remote (read)");
  }
  if (sub === "reset") {
    if (lower.includes("--hard") || lower.includes("--merge")) return verdict("ASK", "GIT_RESET_HARD", "git reset --hard", args.join(" "));
    return verdict("ALLOW", "GIT_COMMIT", "git reset (soft/mixed)");
  }
  if (sub === "clean") {
    if (lower.some((a) => a === "--force" || (/^-[a-z]*f/i.test(a) && !a.startsWith("--")))) return verdict("ASK", "GIT_CLEAN", "git clean force", args.join(" "));
    return verdict("ALLOW", "GIT_STATUS", "git clean dry-run");
  }
  if (sub === "branch") {
    const targets = args.filter((a) => !a.startsWith("-")).join(" ");
    if (args.some((a) => a === "-D" || (/^-[a-zA-Z]*D/.test(a) && !a.startsWith("--")) || a === "--delete --force" )) return verdict("ASK", "GIT_BRANCH_FORCE_DELETE", "force delete local branch", targets);
    if (lower.includes("--delete") && (lower.includes("--force") || lower.includes("-f"))) return verdict("ASK", "GIT_BRANCH_FORCE_DELETE", "force delete local branch", targets);
    if (lower.includes("-d") || lower.includes("--delete")) return verdict("ALLOW", "GIT_COMMIT", "delete merged local branch");
    return verdict("ALLOW", "GIT_STATUS", "git branch");
  }
  if (sub === "tag") {
    if (lower.includes("-d") || lower.includes("--delete")) return verdict("ASK", "GIT_BRANCH_FORCE_DELETE", "delete tag", args.filter((a) => !a.startsWith("-")).join(" "));
    return verdict("ALLOW", "GIT_COMMIT", "git tag");
  }
  if (sub === "config") {
    if (lower.includes("--global") || lower.includes("--system")) return verdict("ASK", "SYSTEM_CONFIG_CHANGE", "git config --global", args.join(" "));
    return verdict("ALLOW", "GIT_COMMIT", "git config local");
  }
  if (sub === "stash") {
    if (["drop", "clear"].includes(lower[0] ?? "")) return verdict("ASK", "GIT_BRANCH_FORCE_DELETE", `git stash ${lower[0]}`, `stash ${lower[0]}`);
    return verdict("ALLOW", "GIT_COMMIT", "git stash");
  }
  if (sub === "filter-branch" || sub === "filter-repo" || sub === "replace") return verdict("ASK", "GIT_RESET_HARD", `history rewrite: git ${sub}`, sub);
  if (GIT_READ.has(sub)) return verdict("ALLOW", "GIT_STATUS", `git ${sub}`);
  if (GIT_LOCAL_WRITE.has(sub)) return verdict("ALLOW", "GIT_COMMIT", `git ${sub}`);
  return verdict("ASK", "UNKNOWN_COMMAND", `unknown git subcommand: ${sub}`, `git ${sub}`);
}

const PUSH_FLAGS_WITH_VALUE = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo", "--recurse-submodules", "--signed"]);

export function classifyGitPush(args: string[], ctx: PolicyContext): Verdict {
  const protectedSet = new Set(ctx.protectedBranches.map((b) => b.toLowerCase()));
  let force = false;
  let del = false;
  let all = false;
  let mirror = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const la = a.toLowerCase();
    if (la === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = la.split("=")[0];
      if (key === "--force" || key === "--force-with-lease" || key === "--force-if-includes") force = true;
      else if (key === "--delete") del = true;
      else if (key === "--all" || key === "--branches") all = true;
      else if (key === "--mirror") mirror = true;
      else if (PUSH_FLAGS_WITH_VALUE.has(key) && !la.includes("=")) i++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const letters = a.slice(1);
      if (letters.includes("f")) force = true;
      if (letters.includes("d")) del = true;
      if (PUSH_FLAGS_WITH_VALUE.has(a)) i++;
      continue;
    }
    positional.push(a);
  }
  const remote = positional[0];
  const refspecs = positional.slice(1);
  if (refspecs.some((r) => r.startsWith("+"))) force = true;
  if (force || mirror) return verdict("DENY", "GIT_FORCE_PUSH", "force push is never allowed", positional.join(" "));
  if (all) return verdict("DENY", "GIT_PUSH_PROTECTED", "--all pushes protected branches", "--all");
  if (!remote || refspecs.length === 0) return verdict("DENY", "GIT_PUSH_BARE", "push must name remote and branch", remote ?? "");

  const results: Verdict[] = [];
  for (const spec of refspecs) {
    const colon = spec.indexOf(":");
    const src = colon === -1 ? spec : spec.slice(0, colon);
    const dst = colon === -1 ? spec : spec.slice(colon + 1);
    const normDst = normalizeRef(dst);
    const normSrc = normalizeRef(src);
    if (protectedSet.has(normDst) || (src !== "" && protectedSet.has(normSrc) && colon === -1)) {
      results.push(verdict("DENY", "GIT_PUSH_PROTECTED", `protected branch: ${normDst || normSrc}`, `${remote}:${normDst || normSrc}`));
      continue;
    }
    if (/^head([~^@]|$)/i.test(src)) {
      results.push(verdict("DENY", "GIT_PUSH_HEAD", "HEAD as source ref is ambiguous", `${remote}:${spec}`));
      continue;
    }
    if (del || src === "") {
      results.push(verdict("ASK", "GIT_REMOTE_DELETE", `delete remote ref ${normDst}`, `${remote}:${normDst}`));
      continue;
    }
    results.push(verdict("ALLOW", "GIT_PUSH_FEATURE", `push ${normSrc} to ${remote}/${normDst}`, `${remote}:${normDst}`));
  }
  return strictest(results);
}

function normalizeRef(ref: string): string {
  let r = ref.trim().toLowerCase();
  if (r.startsWith("+")) r = r.slice(1);
  if (r.startsWith("refs/heads/")) r = r.slice("refs/heads/".length);
  else if (r.startsWith("refs/remotes/")) {
    const parts = r.split("/");
    r = parts.slice(3).join("/");
  } else if (r.startsWith("refs/tags/")) r = "tags/" + r.slice("refs/tags/".length);
  return r;
}

const GH_READ_SUBS = new Set(["view", "list", "status", "checks", "diff", "download", "watch", "search", "browse", "ls", "logs"]);

export function classifyGh(words: string[]): Verdict {
  const lower = words.map((w) => w.toLowerCase());
  const [, group, sub] = lower;
  if (group === "auth") {
    if (sub === "token" || lower.includes("--show-token") || lower.includes("-t")) return verdict("DENY", "CREDENTIAL_READ", "gh auth token exposes credential", "gh auth token");
    if (sub === "status") return verdict("ALLOW", "GH_READ", "gh auth status");
    if (sub === "login" || sub === "logout" || sub === "refresh" || sub === "switch" || sub === "setup-git") return verdict("ASK", "GH_AUTH_CHANGE", `gh auth ${sub}`, `gh auth ${sub}`);
    return verdict("ASK", "UNKNOWN_COMMAND", `gh auth ${sub ?? ""}`);
  }
  if (group === "gist") return verdict("DENY", "PUBLIC_GIST", "gist publishes repository content", "gh gist");
  if (group === "secret" || (group === "variable" && sub !== "list")) return verdict("DENY", "GH_SECRET_MANAGE", `gh ${group}`, `gh ${group}`);
  if (group === "pr") {
    if (sub === "merge") return verdict("DENY", "GH_PR_MERGE", "merge is a user decision", words.slice(3).join(" "));
    if (sub === "create") return verdict("ALLOW", "GH_PR_CREATE", "create pull request");
    if (sub === "close" || sub === "reopen" || sub === "lock") return verdict("ASK", "GH_REPO_CREATE", `gh pr ${sub}`, `gh pr ${sub}`);
    if (sub === "edit" || sub === "comment" || sub === "review" || sub === "ready" || sub === "checkout" || sub === "update-branch") return verdict("ALLOW", "GH_PR_UPDATE", `gh pr ${sub}`);
    if (GH_READ_SUBS.has(sub ?? "")) return verdict("ALLOW", "GH_READ", `gh pr ${sub}`);
    return verdict("ASK", "UNKNOWN_COMMAND", `gh pr ${sub ?? ""}`);
  }
  if (group === "issue") {
    if (sub === "create" || sub === "comment" || sub === "edit" || sub === "develop" || sub === "pin" || sub === "unpin") return verdict("ALLOW", "GH_PR_UPDATE", `gh issue ${sub}`);
    if (sub === "close" || sub === "reopen" || sub === "delete" || sub === "transfer" || sub === "lock") return verdict("ASK", "GH_REPO_CREATE", `gh issue ${sub}`, `gh issue ${sub}`);
    if (GH_READ_SUBS.has(sub ?? "")) return verdict("ALLOW", "GH_READ", `gh issue ${sub}`);
    return verdict("ASK", "UNKNOWN_COMMAND", `gh issue ${sub ?? ""}`);
  }
  if (group === "repo") {
    if (sub === "delete") return verdict("DENY", "GH_REPO_DELETE", "repository deletion is never allowed", words.slice(3).join(" "));
    if (sub === "create" || sub === "fork" || sub === "archive" || sub === "unarchive" || sub === "rename" || sub === "edit" || sub === "sync" || sub === "set-default" || sub === "deploy-key") return verdict("ASK", "GH_REPO_CREATE", `gh repo ${sub}`, `gh repo ${sub}`);
    if (GH_READ_SUBS.has(sub ?? "") || sub === "clone") return verdict("ALLOW", "GH_READ", `gh repo ${sub}`);
    return verdict("ASK", "UNKNOWN_COMMAND", `gh repo ${sub ?? ""}`);
  }
  if (group === "release") {
    if (sub === "create" || sub === "edit" || sub === "upload" || sub === "delete" || sub === "delete-asset") return verdict("ASK", "GH_REPO_CREATE", `gh release ${sub}`, `gh release ${sub}`);
    if (GH_READ_SUBS.has(sub ?? "")) return verdict("ALLOW", "GH_READ", `gh release ${sub}`);
    return verdict("ASK", "UNKNOWN_COMMAND", `gh release ${sub ?? ""}`);
  }
  if (group === "run" || group === "workflow") {
    if (sub === "rerun" || sub === "cancel" || sub === "run" || sub === "enable" || sub === "disable") return verdict("ALLOW", "GH_PR_UPDATE", `gh ${group} ${sub}`);
    if (sub === "delete") return verdict("ASK", "GH_REPO_CREATE", `gh run delete`, "gh run delete");
    return verdict("ALLOW", "GH_READ", `gh ${group} ${sub ?? ""}`);
  }
  if (group === "api") {
    const method = methodOf(lower);
    const url = lower.slice(2).find((w) => !w.startsWith("-") && w !== method.toLowerCase() && !["--method", "-x", "-f", "-f", "--field", "--raw-field", "-h", "--header", "--jq", "-q", "--input"].includes(w) && !isValueOfFlag(lower, w));
    const u = url ?? "";
    if (u.endsWith("/merge") && method !== "GET") return verdict("DENY", "GH_PR_MERGE", "merge via API", u);
    if (u.includes("/gists") && method !== "GET") return verdict("DENY", "PUBLIC_GIST", "gist via API", u);
    if (u.includes("/secrets") && method !== "GET") return verdict("DENY", "GH_SECRET_MANAGE", "secrets via API", u);
    if (method === "DELETE" && /^\/?repos\/[^/]+\/[^/]+\/?$/.test(u)) return verdict("DENY", "GH_REPO_DELETE", "repository deletion via API", u);
    if (method === "GET") return verdict("ALLOW", "GH_READ", `gh api GET ${u}`);
    if (/\/(pulls|issues)(\/|$)/.test(u) && (method === "POST" || method === "PATCH")) return verdict("ALLOW", "GH_PR_UPDATE", `gh api ${method} ${u}`);
    return verdict("ASK", "UNKNOWN_COMMAND", `gh api ${method} ${u}`, u);
  }
  if (group === "codespace" || group === "ssh-key" || group === "gpg-key" || group === "config" || group === "extension" || group === "alias") return verdict("ASK", "UNKNOWN_COMMAND", `gh ${group}`, `gh ${group}`);
  if (group === "search" || group === "browse" || group === "status" || group === "label" || group === "project" || group === "cache" || group === "org" || group === "ruleset" || group === "attestation" || group === "version" || group === "--version" || group === "help") {
    return verdict("ALLOW", "GH_READ", `gh ${group}`);
  }
  return verdict("ASK", "UNKNOWN_COMMAND", `gh ${group ?? ""}`);
}

function methodOf(lower: string[]): string {
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === "-x" || lower[i] === "--method") return (lower[i + 1] ?? "GET").toUpperCase();
    if (lower[i].startsWith("--method=")) return lower[i].split("=")[1].toUpperCase();
  }
  if (lower.some((w) => w === "-f" || w === "-F" || w === "--field" || w === "--raw-field" || w === "--input")) return "POST";
  return "GET";
}

function isValueOfFlag(lower: string[], w: string): boolean {
  const i = lower.indexOf(w);
  if (i <= 0) return false;
  const prev = lower[i - 1];
  return ["-x", "--method", "-f", "--field", "--raw-field", "-h", "--header", "--jq", "-q", "--input", "-p", "--preview"].includes(prev);
}

function classifyDocker(name: string, words: string[]): Verdict {
  const lower = words.map((w) => w.toLowerCase());
  let i = 1;
  // global flags: docker --context x, -H host
  while (i < lower.length && lower[i].startsWith("-")) {
    if (["--context", "-c", "-h", "--host", "--config", "-l", "--log-level"].includes(lower[i])) i++;
    i++;
  }
  let sub = lower[i] ?? "";
  let rest = lower.slice(i + 1);
  if (name === "docker-compose") {
    rest = lower.slice(i);
    sub = "compose";
  }
  const joined = words.join(" ");
  if (sub === "compose" || sub === "stack") {
    let j = 0;
    while (j < rest.length && rest[j].startsWith("-")) {
      if (["-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory"].includes(rest[j])) j++;
      j++;
    }
    const csub = rest[j] ?? "";
    const cargs = rest.slice(j + 1);
    if (csub === "down" && cargs.some((a) => a === "-v" || a === "--volumes" || /^-[a-z]*v/.test(a))) return verdict("ASK", "DOCKER_DELETE_VOLUME", "compose down removes volumes", joined);
    if (csub === "rm" && cargs.some((a) => a === "-v" || a === "--volumes")) return verdict("ASK", "DOCKER_DELETE_VOLUME", "compose rm -v", joined);
    if (csub === "build") return verdict("ALLOW", "LOCAL_DOCKER_BUILD", "compose build");
    if (["up", "start", "stop", "restart", "logs", "ps", "exec", "run", "pull", "down", "config", "images", "top", "port", "events", "create", "kill", "pause", "unpause", "rm", "cp", "ls", "version", "watch", "attach", "wait", "stats"].includes(csub)) {
      return verdict("ALLOW", "LOCAL_DOCKER_UP", `compose ${csub}`);
    }
    return verdict("ASK", "UNKNOWN_COMMAND", `docker compose ${csub}`);
  }
  if (sub === "build" || sub === "buildx") return verdict("ALLOW", "LOCAL_DOCKER_BUILD", "docker build");
  if (sub === "system" && rest[0] === "prune") return verdict("ASK", "DOCKER_PRUNE", "docker system prune", joined);
  if (sub === "volume") {
    if (rest[0] === "rm" || rest[0] === "prune" || rest[0] === "remove") return verdict("ASK", "DOCKER_DELETE_VOLUME", `docker volume ${rest[0]}`, joined);
    return verdict("ALLOW", "LOCAL_DOCKER_UP", `docker volume ${rest[0] ?? ""}`);
  }
  if ((sub === "image" || sub === "container" || sub === "network" || sub === "builder") && (rest[0] === "prune" || rest[0] === "rm" || rest[0] === "remove")) {
    return verdict("ASK", "DOCKER_PRUNE", `docker ${sub} ${rest[0]}`, joined);
  }
  if (sub === "rmi" || sub === "rm") {
    if (sub === "rm" && rest.some((a) => a === "-v" || a === "--volumes")) return verdict("ASK", "DOCKER_DELETE_VOLUME", "docker rm -v", joined);
    return verdict("ASK", "DOCKER_PRUNE", `docker ${sub}`, joined);
  }
  if (sub === "run" && rest.some((a) => a === "--privileged")) return verdict("ASK", "UNKNOWN_COMMAND", "privileged container", joined);
  if (sub === "run" && rest.some((a) => a.includes("docker.sock"))) return verdict("ASK", "UNKNOWN_COMMAND", "container with docker socket", joined);
  if (sub === "login" || sub === "logout") return verdict("ASK", "GH_AUTH_CHANGE", `docker ${sub}`, `docker ${sub}`);
  if (sub === "push") return verdict("ASK", "STAGING_DEPLOY", "docker push to registry", joined);
  if (sub === "context" && rest[0] && rest[0] !== "ls" && rest[0] !== "show" && rest[0] !== "inspect") return verdict("ASK", "SYSTEM_CONFIG_CHANGE", `docker context ${rest[0]}`, joined);
  if (["run", "exec", "start", "stop", "restart", "logs", "ps", "pull", "images", "inspect", "cp", "create", "kill", "pause", "unpause", "stats", "top", "port", "version", "info", "events", "wait", "attach", "tag", "load", "save", "history", "diff", "commit", "export", "import", "search", "sbom", "scout", "network", "image", "container", "manifest", "system", "sandbox", "init", "compose"].includes(sub)) {
    return verdict("ALLOW", "LOCAL_DOCKER_UP", `docker ${sub}`);
  }
  return verdict("ASK", "UNKNOWN_COMMAND", `docker ${sub}`);
}

function classifyPackageManager(name: string, lower: string[]): Verdict {
  const joined = lower.join(" ");
  const sub = lower[1] ?? "";
  const hasGlobal = lower.includes("-g") || lower.includes("--global") || lower.includes("global") || lower.includes("-global");
  if (["brew", "apt", "apt-get", "yum", "dnf", "pacman", "port", "choco", "winget", "snap"].includes(name)) {
    if (["install", "uninstall", "remove", "upgrade", "update", "reinstall", "link", "unlink", "tap", "untap", "cask", "purge", "autoremove", "add", "dist-upgrade"].includes(sub) && !lower.includes("--dry-run")) {
      return verdict("ASK", "GLOBAL_DEP_INSTALL", `${name} ${sub}`, joined);
    }
    return verdict("ALLOW", "SHELL_READ_ONLY", `${name} ${sub}`);
  }
  if (name === "pipx" || name === "conda") return ["install", "uninstall", "upgrade", "remove", "inject", "create", "env"].includes(sub) ? verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined) : verdict("ALLOW", "SHELL_READ_ONLY", joined);
  if (name === "cargo" && (sub === "install" || sub === "uninstall")) return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined);
  if (name === "go" && sub === "install") return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined);
  if (name === "gem" && (sub === "install" || sub === "uninstall" || sub === "update")) return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined);
  if (name === "dotnet") return verdict("ALLOW", "BUILD", joined);
  if (name === "composer" && sub === "global") return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined);
  if (name === "pip" || name === "pip3" || name === "uv" || name === "poetry") {
    if ((sub === "install" || sub === "uninstall" || sub === "add" || sub === "remove" || sub === "sync") && (lower.includes("--user") || lower.includes("--system") || lower.includes("--break-system-packages"))) {
      return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined);
    }
    if (name === "uv" && sub === "tool") return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined);
    if (["install", "uninstall", "add", "remove", "sync", "lock", "update", "upgrade"].includes(sub)) return verdict("ALLOW", "LOCAL_DEP_INSTALL", joined);
    if (sub === "run" || sub === "shell") return verdict("ALLOW", "BUILD", joined);
    return verdict("ALLOW", "SHELL_READ_ONLY", joined);
  }
  // npm / pnpm / yarn / bun / composer / cargo(non-install) / go(non-install)
  if (hasGlobal && ["install", "i", "add", "uninstall", "remove", "rm", "un", "update", "up", "link", "ln", "global"].includes(sub)) return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined);
  if (name === "yarn" && sub === "global") return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined);
  if (sub === "publish") return verdict("ASK", "STAGING_DEPLOY", `${name} publish`, joined);
  if (sub === "login" || sub === "logout" || sub === "adduser" || sub === "token") return verdict("ASK", "GH_AUTH_CHANGE", `${name} ${sub}`, joined);
  if (["install", "i", "ci", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "dedupe", "prune", "link", "outdated", "audit", "require", "dump-autoload", "self-update", "mod", "vendor", "fetch", "generate", "rebuild"].includes(sub)) {
    if (name === "go" && sub === "generate") return verdict("ALLOW", "BUILD", joined);
    return verdict("ALLOW", "LOCAL_DEP_INSTALL", joined);
  }
  if (sub === "test" || sub === "t") return verdict("ALLOW", "TEST", joined);
  if (sub === "run" || sub === "run-script" || sub === "exec" || sub === "x" || sub === "dlx" || sub === "create") {
    const script = lower[2] ?? "";
    if (/test|spec|e2e/.test(script)) return verdict("ALLOW", "TEST", joined);
    if (/lint|format|prettier|typecheck|type-check|check/.test(script)) return verdict("ALLOW", "LINT", joined);
    if (/deploy|release|publish/.test(script)) return verdict("ASK", PROD_MARKER.test(joined) ? "PROD_DEPLOY" : "STAGING_DEPLOY", joined, joined);
    return verdict("ALLOW", "BUILD", joined);
  }
  if (["build", "start", "dev", "serve", "preview", "lint", "format", "check", "version", "ls", "list", "why", "info", "view", "search", "config", "cache", "pack", "init", "explain", "licenses", "show", "env", "bin", "root", "doctor", "workspaces", "ping", "vet", "fmt", "clean", "tree", "metadata", "doc", "bench", "help", "-v", "--version"].includes(sub)) {
    if (sub === "lint" || sub === "format" || sub === "check" || sub === "vet" || sub === "fmt") return verdict("ALLOW", "LINT", joined);
    if (sub === "build" || sub === "start" || sub === "dev" || sub === "serve" || sub === "preview" || sub === "pack" || sub === "bench") return verdict("ALLOW", "BUILD", joined);
    return verdict("ALLOW", "SHELL_READ_ONLY", joined);
  }
  if (name === "cargo" || name === "go") return verdict("ALLOW", "BUILD", joined);
  return verdict("ASK", "UNKNOWN_COMMAND", joined, joined);
}

function prodOrLocalDestructive(joined: string): Verdict {
  return PROD_MARKER.test(joined)
    ? verdict("ASK", "PROD_DESTRUCTIVE_DB", "destructive production database operation requires backup and rollback plan", joined)
    : verdict("ASK", "LOCAL_DESTRUCTIVE_DB", "destructive database operation", joined);
}

function classifyDatabase(name: string, words: string[], joined: string): Verdict {
  const lower = joined.toLowerCase();
  if (name === "dropdb") return prodOrLocalDestructive(joined);
  if (name === "prisma") {
    if (/migrate reset|db push .*--force-reset|--force-reset/.test(lower)) return prodOrLocalDestructive(joined);
    return verdict("ALLOW", "BUILD", "prisma");
  }
  if (name === "sequelize" || name === "knex" || name === "typeorm" || name === "alembic") {
    if (/db:drop|schema:drop|migrate:rollback --all|downgrade base|drop/.test(lower)) return prodOrLocalDestructive(joined);
    return verdict("ALLOW", "BUILD", name);
  }
  const isProd = PROD_MARKER.test(joined);
  if (DB_DESTRUCTIVE_SQL.test(joined)) return prodOrLocalDestructive(joined);
  if (isProd) return verdict("ASK", "PROD_DB_WRITE", "database client against production target", joined);
  return verdict("ALLOW", "SHELL_READ_ONLY", `local database client: ${name}`);
}

function classifyDeploy(name: string, lower: string[], joined: string): Verdict {
  const sub = lower[1] ?? "";
  const isProd = PROD_MARKER.test(joined) || lower.includes("--prod") || lower.includes("--production");
  const readOnly = ["get", "describe", "logs", "plan", "validate", "fmt", "show", "list", "ls", "status", "version", "whoami", "config", "output", "diff", "explain", "api-resources", "top", "preview", "help", "init", "login", "lint", "template", "repo", "search", "env", "info", "inspect", "auth", "sts", "s3api", "cluster-info", "--version", "-v"];
  if (name === "kubectl" || name === "helm" || name === "terraform" || name === "tofu" || name === "pulumi" || name === "cdk") {
    if (readOnly.includes(sub)) return verdict("ALLOW", "SHELL_READ_ONLY", `${name} ${sub}`);
    if (name === "kubectl" && (sub === "delete" || sub === "drain" || sub === "cordon")) return verdict("ASK", isProd ? "PROD_DEPLOY" : "STAGING_DEPLOY", `${name} ${sub}`, joined);
    return verdict("ASK", isProd ? "PROD_DEPLOY" : "STAGING_DEPLOY", `${name} ${sub}`, joined);
  }
  if (name === "aws" || name === "gcloud" || name === "az" || name === "doctl") {
    const verbs = ["deploy", "update", "create", "delete", "put", "run", "apply", "start", "stop", "restart", "scale", "set", "publish", "invoke", "sync", "cp", "rm", "mb", "rb", "release", "rollout", "terminate", "reboot", "modify", "attach", "detach", "enable", "disable", "import", "restore", "purge"];
    if (lower.slice(1).some((w) => verbs.includes(w) || verbs.some((v) => w.startsWith(v + "-")))) return verdict("ASK", isProd ? "PROD_DEPLOY" : "STAGING_DEPLOY", joined, joined);
    return verdict("ALLOW", "SHELL_READ_ONLY", `${name} read`);
  }
  if (readOnly.includes(sub)) return verdict("ALLOW", "SHELL_READ_ONLY", `${name} ${sub}`);
  return verdict("ASK", isProd ? "PROD_DEPLOY" : "STAGING_DEPLOY", `${name} ${sub}`, joined);
}

function classifyArtisan(lower: string[], joined: string): Verdict {
  const cmd = lower[2] ?? "";
  if (/^(migrate:fresh|migrate:reset|migrate:rollback|db:wipe|migrate:refresh)$/.test(cmd)) return prodOrLocalDestructive(joined);
  if (cmd === "test") return verdict("ALLOW", "TEST", "artisan test");
  if (cmd === "deploy" || cmd.startsWith("deploy:")) return verdict("ASK", PROD_MARKER.test(joined) ? "PROD_DEPLOY" : "STAGING_DEPLOY", joined, joined);
  return verdict("ALLOW", "BUILD", `artisan ${cmd}`);
}

// ---------------------------------------------------------------------------
// tool-level classification (file tools และ GitHub connector tools)
// ---------------------------------------------------------------------------

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

const READ_TOOLS = new Set(["read", "read_file", "view", "glob", "grep", "ls", "find", "cat"]);
const WRITE_TOOLS = new Set(["write", "write_file", "edit", "multiedit", "create_file", "str_replace_editor", "notebookedit"]);
const DELETE_TOOLS = new Set(["delete", "delete_file", "remove_file"]);

export function classifyTool(call: ToolCall, ctx: PolicyContext): Verdict {
  const raw = call.toolName;
  let name = raw.toLowerCase();
  const input = call.input ?? {};
  const mcpMatch = name.match(/^mcp__([^_]+)__(.+)$/);
  const isGithubConnector = name.startsWith("github.") || (mcpMatch !== null && mcpMatch[1].includes("github")) || (mcpMatch === null && GITHUB_TOOL_NAMES.has(name));
  if (mcpMatch) name = mcpMatch[2];
  if (name.startsWith("github.")) name = name.slice("github.".length);

  if (isGithubConnector) return classifyGithubTool(name, input, ctx);

  if (name === "bash" || name === "shell" || name === "exec_command" || name === "unified_exec" || name === "run_command" || name === "local_shell" || name === "powershell" || name === "shell_command") {
    const cmd = shellCommandFromInput(input);
    if (cmd === null) return verdict("ASK", "UNKNOWN_COMMAND", `shell tool without command: ${raw}`);
    return classifyCommand(cmd, ctx);
  }
  if (name === "apply_patch") {
    const patch = String(input.patch ?? input.input ?? "");
    const verdicts: Verdict[] = [];
    for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
      const op: PathOp = m[1] === "Delete" ? "delete" : "write";
      verdicts.push(classifyPath(op, m[2].trim(), ctx));
    }
    for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) verdicts.push(classifyPath("write", m[1].trim(), ctx));
    return verdicts.length === 0 ? verdict("ASK", "UNKNOWN_COMMAND", "apply_patch without file headers") : strictest(verdicts);
  }
  const p = pathFromInput(input);
  if (READ_TOOLS.has(name)) return p === null ? verdict("ALLOW", "FS_READ_SOURCE", `${raw} without path`) : classifyPath("read", p, ctx);
  if (WRITE_TOOLS.has(name)) return p === null ? verdict("ASK", "UNKNOWN_COMMAND", `${raw} without path`) : classifyPath("write", p, ctx);
  if (DELETE_TOOLS.has(name)) return p === null ? verdict("ASK", "UNKNOWN_COMMAND", `${raw} without path`) : classifyPath("delete", p, ctx);
  if (name === "webfetch" || name === "web_fetch" || name === "websearch" || name === "web_search" || name === "fetch" || name === "webrun") return verdict("ALLOW", "SHELL_READ_ONLY", raw);
  if (name === "share" || name === "share_session" || name === "export_session") return verdict("DENY", "PI_SHARE", "session share is blocked", raw);
  // Codex ส่ง namespace ติดกับชื่อ tool เช่น collaborationwait_agent
  if (name.startsWith("collaboration")) name = name.slice("collaboration".length);
  if (AGENT_TOOLS.has(name)) return classifyAgentSpawn(raw, input, ctx);
  if (AGENT_COORDINATION_TOOLS.has(name)) return verdict("ALLOW", "AGENT_SPAWN", `agent coordination: ${raw}`, raw);
  if (name === "update_plan" || name === "todowrite" || name === "todoread") return verdict("ALLOW", "SHELL_READ_ONLY", `plan tool: ${raw}`);
  return verdict("ASK", "UNKNOWN_COMMAND", `unknown tool: ${raw}`, raw);
}

const AGENT_TOOLS = new Set(["agent", "task", "spawn_agent", "dispatch_agent", "subagent"]);
const AGENT_COORDINATION_TOOLS = new Set(["wait_agent", "send_message", "list_agents", "followup_task", "interrupt_agent", "close_agent", "resume_agent", "send_input"]);

/** security agent บน provider ที่ไม่ใช่ Anthropic = DENY: content filter ของ provider อื่นแฟล็ก context ถาวร */
export function classifyAgentSpawn(raw: string, input: Record<string, unknown>, ctx: PolicyContext): Verdict {
  const agentType = String(input.subagent_type ?? input.agent_type ?? input.subagentType ?? input.agentType ?? input.type ?? "").trim().toLowerCase();
  const host = ctx.providerHost?.toLowerCase();
  const thirdParty = host !== undefined && host !== "" && !ctx.anthropicHosts.map((h) => h.toLowerCase()).includes(host);
  if (thirdParty && ctx.securityAgentTypes.map((t) => t.toLowerCase()).includes(agentType)) {
    return verdict("DENY", "SECURITY_AGENT_PROVIDER", `security agent '${agentType}' on third-party provider ${host}: its content filter flags audit context permanently; run this agent on Anthropic directly`, agentType);
  }
  return verdict("ALLOW", "AGENT_SPAWN", `spawn agent ${agentType || raw}`, agentType || raw);
}

const GITHUB_TOOL_NAMES = new Set([
  "merge_pull_request", "enable_auto_merge", "delete_file", "update_ref", "create_pull_request", "create_branch", "create_commit", "create_tree", "create_blob",
  "push_files", "create_or_update_file", "add_comment_to_issue", "create_issue", "update_issue", "create_pull_request_review", "rerun_failed_workflow_run_jobs",
  "rerun_workflow_job", "delete_repository", "create_gist", "create_repository", "fork_repository", "get_file_contents", "list_pull_requests", "search_code",
]);

function classifyGithubTool(name: string, input: Record<string, unknown>, ctx: PolicyContext): Verdict {
  const protectedSet = new Set(ctx.protectedBranches.map((b) => b.toLowerCase()));
  const refRaw = String(input.ref ?? input.branch ?? input.base ?? input.head ?? "");
  const ref = refRaw.toLowerCase().replace(/^refs\/heads\//, "");
  if (name === "merge_pull_request" || name === "enable_auto_merge" || name === "merge_pull_request_branch") {
    return verdict("DENY", "GH_PR_MERGE", "merge is a user decision", name);
  }
  if (name === "delete_repository" || name === "delete_repo") return verdict("DENY", "GH_REPO_DELETE", "repository deletion", name);
  if (name === "create_gist" || name.includes("gist")) return verdict("DENY", "PUBLIC_GIST", "gist", name);
  if (name.includes("secret")) return verdict("DENY", "GH_SECRET_MANAGE", name, name);
  if (name === "delete_file") return verdict("ASK", "GH_DELETE_FILE", `delete file ${String(input.path ?? "")}`, String(input.path ?? name));
  if (name === "update_ref" || name === "push_files" || name === "create_or_update_file" || name === "delete_branch") {
    if (ref !== "" && protectedSet.has(ref)) return verdict("DENY", "GIT_PUSH_PROTECTED", `protected ref ${ref}`, ref);
    if (input.force === true) return verdict("DENY", "GIT_FORCE_PUSH", "force ref update", ref);
    if (name === "delete_branch") return verdict("ASK", "GIT_REMOTE_DELETE", `delete branch ${ref}`, ref);
    return verdict("ALLOW", "GIT_PUSH_FEATURE", `${name} ${ref}`, ref);
  }
  if (name === "create_pull_request") return verdict("ALLOW", "GH_PR_CREATE", "create pull request");
  if (name === "create_repository" || name === "fork_repository" || name === "create_release" || name === "close_pull_request") return verdict("ASK", "GH_REPO_CREATE", name, name);
  if (name.startsWith("get_") || name.startsWith("list_") || name.startsWith("search_") || name.startsWith("read_") || name.startsWith("download_")) return verdict("ALLOW", "GH_READ", name);
  if (name.startsWith("create_") || name.startsWith("add_") || name.startsWith("update_") || name.startsWith("rerun_") || name.startsWith("request_") || name.startsWith("submit_") || name.startsWith("dismiss_") || name.startsWith("assign_")) {
    return verdict("ALLOW", "GH_PR_UPDATE", name);
  }
  return verdict("ASK", "UNKNOWN_COMMAND", `unknown GitHub tool: ${name}`, name);
}

function shellCommandFromInput(input: Record<string, unknown>): string | null {
  const c = input.command ?? input.cmd ?? input.script;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => shellQuote(String(x))).join(" ");
  return null;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=+@%,-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

function pathFromInput(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "path", "filePath", "filename", "file", "target", "notebook_path", "pattern_path", "cwd"]) {
    const v = input[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

/** ข้อความ input ของ user (Pi slash command เป็นต้น) */
export function classifyUserInput(text: string): Verdict | null {
  const t = text.trim().toLowerCase();
  if (t === "/share" || t.startsWith("/share ") || t === "/export-share") return verdict("DENY", "PI_SHARE", "session share uploads repository content", "/share");
  return null;
}

