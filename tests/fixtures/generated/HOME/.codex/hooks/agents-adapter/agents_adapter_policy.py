"""
agents-adapter policy engine (Python mirror of src/core/*.ts)

Provider-neutral classifier used by Codex hooks. Kept in lockstep with the
TypeScript implementation; the parity test-suite runs the same fixtures
through both and fails on any divergence.

No third-party dependencies (stdlib only) so the hook works with any python3.
"""
from __future__ import annotations

import json
import os
import re
import dataclasses
from dataclasses import dataclass, field
from typing import Optional

RANK = {"ALLOW": 0, "ASK": 1, "DENY": 2}


@dataclass
class Verdict:
    decision: str
    rule_id: str
    reason: str
    target: Optional[str] = None

    def to_dict(self) -> dict:
        d = {"decision": self.decision, "ruleId": self.rule_id, "reason": self.reason}
        if self.target is not None:
            d["target"] = self.target
        return d


def verdict(decision: str, rule_id: str, reason: str, target: Optional[str] = None) -> Verdict:
    return Verdict(decision, rule_id, reason, target)


def strictest(verdicts: list[Verdict]) -> Verdict:
    if not verdicts:
        return verdict("ALLOW", "SHELL_READ_ONLY", "empty command")
    best = verdicts[0]
    for v in verdicts[1:]:
        if RANK[v.decision] > RANK[best.decision]:
            best = v
    return best


# ---------------------------------------------------------------------------
# context
# ---------------------------------------------------------------------------


@dataclass
class PolicyContext:
    home: str
    tmpdir: str
    cwd: str
    development_roots: list[str]
    protected_branches: list[str]
    dev_env_patterns: list[str]
    prod_env_patterns: list[str]
    credential_paths: list[str]
    credential_basenames: list[str]
    credential_extensions: list[str]
    system_config_paths: list[str]
    always_writable: list[str]
    agent_config_dirs: list[str]
    realpath: object = field(default=None)  # callable(path) -> str, raises when missing
    security_agent_types: list[str] = field(default_factory=lambda: ["auditor", "skeptic", "security-review", "security-reviewer", "security-auditor"])
    anthropic_hosts: list[str] = field(default_factory=lambda: ["api.anthropic.com"])
    provider_host: Optional[str] = None  # host ของ ANTHROPIC_BASE_URL; None = Anthropic โดยตรง

    @staticmethod
    def from_json(data: dict, cwd: str, realpath=None) -> "PolicyContext":
        return PolicyContext(
            home=data["home"],
            tmpdir=data["tmpdir"],
            cwd=cwd,
            development_roots=list(data["developmentRoots"]),
            protected_branches=list(data["protectedBranches"]),
            dev_env_patterns=list(data["devEnvPatterns"]),
            prod_env_patterns=list(data["prodEnvPatterns"]),
            credential_paths=list(data["credentialPaths"]),
            credential_basenames=list(data["credentialBasenames"]),
            credential_extensions=list(data["credentialExtensions"]),
            system_config_paths=list(data["systemConfigPaths"]),
            always_writable=list(data["alwaysWritable"]),
            agent_config_dirs=list(data["agentConfigDirs"]),
            realpath=realpath,
            security_agent_types=list(data.get("securityAgentTypes") or ["auditor", "skeptic", "security-review", "security-reviewer", "security-auditor"]),
            anthropic_hosts=list(data.get("anthropicHosts") or ["api.anthropic.com"]),
            provider_host=data.get("providerHost") or host_from_url(os.environ.get("ANTHROPIC_BASE_URL")),
        )


def host_from_url(url: Optional[str]) -> Optional[str]:
    """mirror ของ hostFromUrl ใน policy-loader.ts"""
    if not url or not url.strip():
        return None
    try:
        from urllib.parse import urlparse

        host = urlparse(url.strip()).hostname
        return host.lower() if host else url.strip().lower()
    except Exception:
        return url.strip().lower()


# ---------------------------------------------------------------------------
# shell parsing (mirror of shell.ts)
# ---------------------------------------------------------------------------

WRAPPERS = {"env", "command", "exec", "nice", "time", "nohup", "builtin"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish"}
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


@dataclass
class SimpleCommand:
    words: list[str] = field(default_factory=list)
    redirect_writes: list[str] = field(default_factory=list)
    redirect_reads: list[str] = field(default_factory=list)
    has_substitution: bool = False
    piped_from_previous: bool = False


def _tokenize(inp: str) -> list[tuple[str, str, bool]]:
    tokens: list[tuple[str, str, bool]] = []
    i, n = 0, len(inp)
    cur = ""
    in_word = False
    subst = False

    def flush():
        nonlocal cur, in_word, subst
        if in_word:
            tokens.append((cur, "word", subst))
            cur = ""
            in_word = False
            subst = False

    while i < n:
        c = inp[i]
        if c == "'":
            in_word = True
            i += 1
            while i < n and inp[i] != "'":
                cur += inp[i]
                i += 1
            i += 1
            continue
        if c == '"':
            in_word = True
            i += 1
            while i < n and inp[i] != '"':
                if inp[i] == "\\" and i + 1 < n:
                    cur += inp[i + 1]
                    i += 2
                    continue
                if inp[i] in "$`":
                    subst = True
                cur += inp[i]
                i += 1
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            in_word = True
            cur += inp[i + 1]
            i += 2
            continue
        if c == "`":
            in_word = True
            subst = True
            i += 1
            while i < n and inp[i] != "`":
                cur += inp[i]
                i += 1
            i += 1
            continue
        if c == "$" and i + 1 < n and inp[i + 1] in "({":
            in_word = True
            subst = True
            open_c = inp[i + 1]
            close_c = ")" if open_c == "(" else "}"
            depth = 0
            while i < n:
                if inp[i] == open_c:
                    depth += 1
                if inp[i] == close_c:
                    depth -= 1
                    if depth == 0:
                        cur += inp[i]
                        i += 1
                        break
                cur += inp[i]
                i += 1
            continue
        if c == "$":
            in_word = True
            j = i + 1
            name = ""
            while j < n and re.match(r"[A-Za-z0-9_]", inp[j]):
                name += inp[j]
                j += 1
            if name not in ("HOME", "TMPDIR", "PWD"):
                subst = True
            cur += inp[i:j]
            i = j
            continue
        if c in " \t":
            flush()
            i += 1
            continue
        if c in "\n;":
            flush()
            tokens.append((";", "op", False))
            i += 1
            continue
        if c == "&" and i + 1 < n and inp[i + 1] == "&":
            flush()
            tokens.append(("&&", "op", False))
            i += 2
            continue
        if c == "|" and i + 1 < n and inp[i + 1] == "|":
            flush()
            tokens.append(("||", "op", False))
            i += 2
            continue
        if c == "|":
            flush()
            tokens.append(("|", "op", False))
            i += 1
            continue
        if c == "&":
            flush()
            tokens.append((";", "op", False))
            i += 1
            continue
        if c in "()":
            flush()
            tokens.append((";", "op", True))
            i += 1
            continue
        if c in "<>":
            flush()
            op = c
            if i + 1 < n and inp[i + 1] in ">&":
                i += 1
                op += inp[i]
            if cur == "" and tokens and tokens[-1][1] == "word" and re.fullmatch(r"\d", tokens[-1][0]):
                tokens.pop()
            tokens.append((op, "redirect", False))
            i += 1
            continue
        if c == "#" and not in_word:
            while i < n and inp[i] != "\n":
                i += 1
            continue
        in_word = True
        cur += c
        i += 1
    flush()
    return tokens


def _split_segments(tokens) -> list[SimpleCommand]:
    segments: list[SimpleCommand] = []
    seg = SimpleCommand()
    pending: Optional[str] = None

    def push(piped_next: bool):
        nonlocal seg
        if seg.words or seg.redirect_writes or seg.redirect_reads:
            segments.append(seg)
        seg = SimpleCommand(piped_from_previous=piped_next)

    for text, kind, subst in tokens:
        if kind == "op":
            if subst:
                seg.has_substitution = True
            push(text == "|")
            continue
        if kind == "redirect":
            pending = text
            continue
        if pending is not None:
            if pending.startswith("<"):
                seg.redirect_reads.append(text)
            elif not pending.endswith("&"):
                seg.redirect_writes.append(text)
            pending = None
            if subst:
                seg.has_substitution = True
            continue
        if subst:
            seg.has_substitution = True
        seg.words.append(text)
    push(False)
    return segments


def strip_wrappers(words: list[str]) -> list[str]:
    w = list(words)
    changed = True
    while changed and w:
        changed = False
        if ASSIGN.match(w[0]):
            w.pop(0)
            changed = True
            continue
        if w[0] in WRAPPERS:
            w.pop(0)
            while w and w[0].startswith("-"):
                flag = w.pop(0)
                if flag in ("-n", "-u", "-C", "-S") and w:
                    w.pop(0)
            changed = True
    return w


MAX_EXPANSIONS = 32
FOR_RE = re.compile(r"\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+?)\s*(?:;|\n)\s*do\b")
ASSIGN_RE = re.compile(r"(?:^|[;&|\n]\s*)([A-Za-z_][A-Za-z0-9_]*)=(\"[^\"$`]*\"|'[^']*'|[^\s;&|$`()]+)(?=\s*(?:[;&|\n]|$))")
LIST_WORD_RE = re.compile(r"\"[^\"]*\"|'[^']*'|\S+")


def _strip_quotes(w: str) -> str:
    if len(w) >= 2 and ((w[0] == '"' and w[-1] == '"') or (w[0] == "'" and w[-1] == "'")):
        return w[1:-1]
    return w


def expand_literal_bindings(command: str) -> list[str]:
    """ขยาย for VAR in <literal>; do ... และ VAR=<literal> ให้ $VAR เป็นค่าจริง (mirror ของ shell.ts); [] เมื่อขยายไม่ได้"""
    bindings: list[tuple[str, list[str]]] = []
    for m in FOR_RE.finditer(command):
        vals = [w for w in LIST_WORD_RE.findall(m.group(2)) if w]
        if not vals or any(re.search(r"[$`(]", v) for v in vals):
            continue
        bindings.append((m.group(1), [_strip_quotes(v) for v in vals]))
    for m in ASSIGN_RE.finditer(command):
        bindings.append((m.group(1), [_strip_quotes(m.group(2))]))
    if not bindings:
        return []
    variants = [command]
    for name, values in bindings:
        pat = re.compile(r"\$\{" + name + r"\}|\$" + name + r"(?![A-Za-z0-9_])")
        nxt: list[str] = []
        for v in variants:
            for val in values:
                nxt.append(pat.sub(lambda _m, val=val: val, v))
        variants = list(dict.fromkeys(nxt))
        if len(variants) > MAX_EXPANSIONS:
            return []
    if len(variants) == 1 and variants[0] == command:
        return []
    return variants


def command_substitutions(command: str) -> list[str]:
    """คืน command ภายใน $(...) และ `...` ระดับนอกสุด (mirror ของ shell.ts)"""
    out: list[str] = []
    i, n = 0, len(command)
    while i < n:
        c = command[i]
        if c == "'":
            i += 1
            while i < n and command[i] != "'":
                i += 1
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if c == "`":
            i += 1
            start = i
            while i < n and command[i] != "`":
                i += 1
            out.append(command[start:i])
            i += 1
            continue
        if c == "$" and i + 1 < n and command[i + 1] == "(":
            depth = 0
            start = i + 2
            while i < n:
                if command[i] == "(":
                    depth += 1
                if command[i] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            out.append(command[start:i])
            i += 1
            continue
        i += 1
    return [x.strip() for x in out if x.strip()]


def nested_shell_script(words: list[str]) -> Optional[str]:
    if len(words) < 2:
        return None
    base = words[0].split("/")[-1]
    if base not in SHELLS:
        return None
    for i in range(1, len(words)):
        a = words[i]
        if a.startswith("-") and "c" in a:
            return words[i + 1] if i + 1 < len(words) else None
        if not a.startswith("-"):
            return None
    return None


def parse_command(inp: str, depth: int = 0) -> list[SimpleCommand]:
    out: list[SimpleCommand] = []
    for seg in _split_segments(_tokenize(inp)):
        words = strip_wrappers(seg.words)
        nested = nested_shell_script(words) if depth < 4 else None
        if nested is not None:
            for s in parse_command(nested, depth + 1):
                s.piped_from_previous = s.piped_from_previous or seg.piped_from_previous
                s.has_substitution = s.has_substitution or seg.has_substitution
                out.append(s)
            continue
        seg.words = words
        out.append(seg)
    return out


def command_name(words: list[str]) -> str:
    if not words:
        return ""
    return words[0].split("/")[-1].lower()


# ---------------------------------------------------------------------------
# paths (mirror of paths.ts)
# ---------------------------------------------------------------------------

SYSTEM_READ_ONLY_PREFIXES = ["/usr", "/opt", "/bin", "/sbin", "/Library", "/System", "/etc", "/dev", "/proc"]


def expand_path(raw: str, ctx: PolicyContext) -> str:
    p = raw.strip()
    if p.startswith("~/") or p == "~":
        p = ctx.home + p[1:]
    p = re.sub(r"\$\{HOME\}|\$HOME\b", lambda _: ctx.home, p)
    p = re.sub(r"\$\{TMPDIR\}|\$TMPDIR\b", lambda _: ctx.tmpdir, p)
    p = re.sub(r"\$\{PWD\}|\$PWD\b", lambda _: ctx.cwd, p)
    if not os.path.isabs(p):
        p = os.path.join(ctx.cwd, p)
    return os.path.normpath(p)


def _default_realpath(p: str) -> str:
    if not os.path.lexists(p):
        raise FileNotFoundError(p)
    return os.path.realpath(p)


def resolve_real(abs_path: str, ctx: PolicyContext) -> str:
    real = ctx.realpath or _default_realpath
    current = abs_path
    tail: list[str] = []
    while True:
        try:
            resolved = real(current)
            if not tail:
                return resolved
            return os.path.join(resolved, *reversed(tail))
        except Exception:
            parent = os.path.dirname(current)
            if parent == current:
                return abs_path
            tail.append(os.path.basename(current))
            current = parent


def is_under(target: str, root: str) -> bool:
    rel = os.path.relpath(target, root)
    return rel == "." or (not rel.startswith("..") and not os.path.isabs(rel))


ENV_TEMPLATE_SUFFIXES = (".example", ".sample", ".dist", ".template")


def is_env_template(basename: str) -> bool:
    """ไฟล์ env ที่เป็น template (.example/.sample/.dist/.template) ไม่ถือเป็น env จริง"""
    return basename.lower().endswith(ENV_TEMPLATE_SUFFIXES)


def basename_matches(basename: str, patterns: list[str]) -> bool:
    for pat in patterns:
        regex = "^" + ".*".join(re.escape(part) for part in pat.split("*")) + "$"
        if re.match(regex, basename):
            return True
    return False


def classify_path_kind(raw: str, ctx: PolicyContext) -> tuple[str, str]:
    expanded = expand_path(raw, ctx)
    resolved = resolve_real(expanded, ctx)
    base = os.path.basename(resolved)
    ext = os.path.splitext(resolved)[1].lower()
    candidates = [expanded, resolved]

    credential_roots = [resolve_real(expand_path(p, ctx), ctx) for p in ctx.credential_paths]
    if (
        any(is_under(c, root) for c in candidates for root in credential_roots)
        or base in ctx.credential_basenames
        or ext in ctx.credential_extensions
    ):
        return "credential", resolved
    # .env.prod.example / .env.sample / .env.dist / .env.template เป็น template ค่าปลอมที่ commit ได้ ไม่ใช่ env จริง
    env_template = is_env_template(base)
    if not env_template and basename_matches(base, ctx.prod_env_patterns):
        return "prod_env", resolved

    trusted_roots = [
        resolve_real(expand_path(p, ctx), ctx)
        for p in (list(ctx.development_roots) + [ctx.cwd] + list(ctx.always_writable) + list(ctx.agent_config_dirs))
    ]
    # trust zone is decided on the resolved path only: a symlink inside the project pointing outside must not count as in-zone
    in_zone = any(is_under(resolved, root) for root in trusted_roots)

    system_roots = [resolve_real(expand_path(p, ctx), ctx) for p in ctx.system_config_paths]
    if any(is_under(c, root) for c in candidates for root in system_roots):
        return "system_config", resolved

    if not env_template and basename_matches(base, ctx.dev_env_patterns):
        return ("dev_env" if in_zone else "outside"), resolved
    if in_zone:
        return "trusted", resolved
    if any(is_under(resolved, p) for p in SYSTEM_READ_ONLY_PREFIXES):
        return "system_read", resolved
    return "outside", resolved


def classify_path(op: str, raw: str, ctx: PolicyContext) -> Verdict:
    kind, resolved = classify_path_kind(raw, ctx)
    write = op != "read"
    if kind == "credential":
        return verdict("DENY", "CREDENTIAL_WRITE" if write else "CREDENTIAL_READ", f"credential path: {resolved}", resolved)
    if kind == "prod_env":
        return verdict("DENY", "PROD_ENV_WRITE" if write else "PROD_ENV_READ", f"production env: {resolved}", resolved)
    if kind == "dev_env":
        return verdict("ALLOW", "DEV_ENV_WRITE" if write else "DEV_ENV_READ", f"development env: {resolved}", resolved)
    if kind == "system_config":
        if write:
            return verdict("ASK", "SYSTEM_CONFIG_CHANGE", f"system configuration: {resolved}", resolved)
        return verdict("ALLOW", "FS_READ_SOURCE", f"read system configuration: {resolved}", resolved)
    if kind == "trusted":
        if write:
            return verdict("ALLOW", "FS_WRITE_SOURCE", f"trusted: {resolved}", resolved)
        return verdict("ALLOW", "FS_READ_SOURCE", f"trusted: {resolved}", resolved)
    if kind == "system_read":
        if write:
            return verdict("ASK", "OUTSIDE_TRUST_ZONE", f"system path write: {resolved}", resolved)
        return verdict("ALLOW", "FS_READ_SOURCE", f"system path read: {resolved}", resolved)
    return verdict("ASK", "OUTSIDE_TRUST_ZONE", f"outside Development Trust Zone: {resolved}", resolved)


def looks_like_path(word: str, ctx: PolicyContext) -> bool:
    if word.startswith("-"):
        return False
    if "://" in word:
        return False
    if word.startswith(("/", "~", "./", "../", "$HOME", "${HOME}")):
        return True
    if "/" in word:
        return True
    base = os.path.basename(word)
    if not is_env_template(base) and (basename_matches(base, ctx.dev_env_patterns) or basename_matches(base, ctx.prod_env_patterns)):
        return True
    if base in ctx.credential_basenames:
        return True
    if os.path.splitext(base)[1].lower() in ctx.credential_extensions:
        return True
    return False


# ---------------------------------------------------------------------------
# command classification (mirror of classifier.ts)
# ---------------------------------------------------------------------------

BYPASS_FLAGS = [
    "--dangerously-skip-permissions",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--yolo",
    "--no-sandbox",
]
SHELL_NAMES = SHELLS
SHELL_KEYWORDS = {"for", "select", "case", "while", "until", "if", "then", "else", "elif", "fi", "do", "done", "esac", "!", "{", "}"}
PRINT_CMDS = {"cat", "less", "more", "head", "tail", "grep", "rg", "egrep", "fgrep", "awk", "cut", "strings", "base64", "xxd", "od", "hexdump", "jq", "yq", "sed", "bat", "nl", "tac", "pbcopy", "open"}
READ_ONLY_CMDS = {
    "ls", "pwd", "echo", "printf", "cat", "head", "tail", "less", "more", "grep", "rg", "egrep", "fgrep", "find", "fd", "wc", "sort", "uniq", "cut",
    "awk", "sed", "diff", "file", "stat", "du", "df", "which", "whereis", "type", "tree", "date", "whoami", "uname", "env", "printenv", "true",
    "false", "test", "[", "jq", "yq", "xargs", "tr", "basename", "dirname", "realpath", "readlink", "ps", "sleep", "cd", "export", "source", ".",
    "alias", "man", "bat", "nl", "tac", "hostname", "id", "kill", "pkill", "killall", "pgrep", "pidof", "lsof", "netstat", "ping", "curl", "wget", "tee", "mkdir",
    "touch", "cp", "mv", "ln", "chmod", "chown", "truncate", "install", "rmdir", "patch", "unzip", "zip", "tar", "gzip", "gunzip", "rm", "column",
    "seq", "expr", "bc", "md5", "md5sum", "shasum", "sha256sum", "openssl", "ssh-keygen", "cmp", "comm", "join", "paste", "split", "rev", "fold",
    "watch", "time", "wait", "clear", "tput", "stty", "read", "set", "unset", "shift", "exit", "return", "trap", "ulimit", "umask", "declare", "local", "eval",
}
WRITE_CMDS = {"tee", "mkdir", "touch", "cp", "mv", "ln", "chmod", "chown", "truncate", "install", "rmdir", "patch", "unzip", "tar", "rm", "sed"}
BUILD_CMDS = {
    "make", "cmake", "ninja", "tsc", "vite", "webpack", "esbuild", "rollup", "next", "nuxt", "gradle", "gradlew", "mvn", "mvnw", "xcodebuild", "swift",
    "node", "python", "python3", "ruby", "bundle", "npx", "pnpx", "bunx", "php", "deno", "tsx", "ts-node", "dotnet", "cargo", "go", "javac", "java",
    "rustc", "gcc", "clang", "g++", "zig", "elixir", "mix", "artisan", "rake", "rails", "flutter", "pod", "fastlane", "turbo", "nx", "lerna", "bun",
}
TEST_CMDS = {"pytest", "jest", "vitest", "mocha", "phpunit", "playwright", "cypress", "karma", "ava", "tap", "rspec", "minitest", "nunit", "xunit", "codecept", "pest", "behat"}
LINT_CMDS = {
    "eslint", "prettier", "ruff", "black", "flake8", "mypy", "pylint", "isort", "phpstan", "psalm", "php-cs-fixer", "pint", "golangci-lint", "gofmt", "goimports",
    "clippy", "rustfmt", "rubocop", "stylelint", "biome", "markdownlint", "markdownlint-cli2", "shellcheck", "hadolint", "swiftlint", "swiftformat", "ktlint", "detekt", "tflint", "yamllint", "actionlint", "oxlint", "dprint",
}
PKG_MANAGERS = {"npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx", "composer", "gem", "brew", "poetry", "uv", "cargo", "go", "conda", "apt", "apt-get", "yum", "dnf", "pacman", "port", "choco", "winget", "snap"}
DEPLOY_CMDS = {"vercel", "netlify", "firebase", "fly", "flyctl", "heroku", "serverless", "sls", "sam", "cdk", "pulumi", "terraform", "tofu", "kubectl", "helm", "aws", "gcloud", "az", "cap", "ansible-playbook", "wrangler", "railway", "render", "doctl", "eb", "copilot"}
REMOTE_CMDS = {"ssh", "scp", "rsync", "sftp"}
DB_CLIENTS = {"psql", "mysql", "mariadb", "sqlcmd", "mongosh", "mongo", "redis-cli", "sqlite3", "clickhouse-client", "cqlsh"}
DB_DESTRUCTIVE_SQL = re.compile(r"\b(drop\s+(database|table|schema)|truncate|flushall|flushdb|dropdatabase|deleteMany\(\s*\{?\s*\}?\s*\))", re.I)
PROD_MARKER = re.compile(r"(^|[^a-z])(prod|production)([^a-z]|$)", re.I)


def classify_command(command: str, ctx: PolicyContext, depth: int = 0) -> Verdict:
    # for VAR in <literal>; VAR=<literal>: ตัดสินจากค่าจริงทุก combination แทน ASK
    variants = expand_literal_bindings(command) if depth < 4 else []
    if variants:
        return strictest([_classify_command_once(v, ctx, depth + 1) for v in variants])
    return _classify_command_once(command, ctx, depth)


def _classify_command_once(command: str, ctx: PolicyContext, depth: int) -> Verdict:
    segments = parse_command(command)
    if not segments:
        return verdict("ALLOW", "SHELL_READ_ONLY", "empty command")
    verdicts: list[Verdict] = []
    for i, seg in enumerate(segments):
        nxt = segments[i + 1] if i + 1 < len(segments) else None
        verdicts.extend(_classify_segment(seg, nxt, ctx))
    # command ภายใน $(...) / `...` ยังถูก classify แยก: ASK ของ segment นอกคงอยู่ แต่ inner ที่ DENY ต้องชนะ
    if depth < 4:
        for inner in command_substitutions(command):
            verdicts.append(classify_command(inner, ctx, depth + 1))
    return strictest(verdicts)


def _classify_segment(seg: SimpleCommand, nxt: Optional[SimpleCommand], ctx: PolicyContext) -> list[Verdict]:
    out: list[Verdict] = []
    words = seg.words
    # shell keyword นำหน้า (do/then/else/if/while/!/{ ...) ไม่ใช่ command: ตัดออกก่อนให้ name/path/print ตรวจจาก command จริง
    while words and words[0] in SHELL_KEYWORDS and words[0] not in ("for", "select", "case"):
        words = words[1:]
    name = command_name(words)
    bypass = _find_bypass(words)
    if bypass:
        out.append(verdict("DENY", "SAFETY_BYPASS", f"bypass flag: {bypass}", bypass))
    if words:
        out.extend(_classify_by_command(name, words, seg, nxt, ctx))
    out.extend(_classify_word_paths(seg if words is seg.words else dataclasses.replace(seg, words=words), name, ctx))
    if seg.has_substitution:
        out.append(verdict("ASK", "SHELL_SUBSTITUTION", "command substitution cannot be verified", " ".join(seg.words)))
    return out


def _find_bypass(words: list[str]) -> Optional[str]:
    for i, w in enumerate(words):
        lw = w.lower()
        if any(lw == f or lw.startswith(f + "=") for f in BYPASS_FLAGS):
            return w
        if lw.startswith("--permission-mode"):
            val = lw.split("=", 1)[1] if "=" in lw else (words[i + 1].lower() if i + 1 < len(words) else "")
            if val == "bypasspermissions":
                return f"{w} bypassPermissions"
        if lw in ("--sandbox", "-s") or lw.startswith("--sandbox="):
            val = lw.split("=", 1)[1] if "=" in lw else (words[i + 1].lower() if i + 1 < len(words) else "")
            if val == "danger-full-access":
                return f"{w} danger-full-access"
        if lw == "-a" and i + 1 < len(words) and words[i + 1].lower() == "never":
            return "-a never"
        if lw.startswith("--ask-for-approval"):
            val = lw.split("=", 1)[1] if "=" in lw else (words[i + 1] if i + 1 < len(words) else "")
            if (val or "").lower() == "never" and any("danger" in x.lower() for x in words):
                return "approval never + danger"
        if lw in ("-ne", "--no-extensions"):
            return w
    return None


def _has_inplace(words: list[str]) -> bool:
    return any(w == "-i" or w.startswith("-i") for w in words)


def _classify_word_paths(seg: SimpleCommand, name: str, ctx: PolicyContext) -> list[Verdict]:
    out: list[Verdict] = []
    is_print = name in PRINT_CMDS and not (name == "sed" and _has_inplace(seg.words))
    is_write = name in WRITE_CMDS and not (name == "sed" and not _has_inplace(seg.words))
    is_delete = name in ("rm", "rmdir")
    args = [w for w in seg.words[1:] if not w.startswith("-") or "/" in w]
    for w in args:
        if not looks_like_path(w, ctx):
            continue
        if is_delete:
            op = "delete"
        elif is_write and _is_write_target(name, w, args):
            op = "write"
        else:
            op = "read"
        v = classify_path(op, w, ctx)
        if v.rule_id == "DEV_ENV_READ" and is_print:
            out.append(verdict("DENY", "DEV_ENV_PRINT", f"printing development env: {w}", v.target))
            continue
        out.append(v)
    for w in seg.redirect_writes:
        if w in ("/dev/null", "/dev/stdout", "/dev/stderr"):
            continue
        out.append(classify_path("write", w, ctx))
    for w in seg.redirect_reads:
        v = classify_path("read", w, ctx)
        if v.rule_id == "DEV_ENV_READ" and (is_print or name == ""):
            out.append(verdict("DENY", "DEV_ENV_PRINT", f"printing development env: {w}", v.target))
        else:
            out.append(v)
    return out


def _is_write_target(name: str, word: str, args: list[str]) -> bool:
    if name in ("cp", "mv", "ln", "install"):
        positional = [a for a in args if not a.startswith("-")]
        return word == positional[-1] if len(positional) >= 2 else True
    if name in ("tar", "unzip", "patch"):
        return False
    return True


def _classify_by_command(name: str, words: list[str], seg: SimpleCommand, nxt: Optional[SimpleCommand], ctx: PolicyContext) -> list[Verdict]:
    lower = [w.lower() for w in words]
    joined = " ".join(words)
    if name in SHELL_KEYWORDS:
        # for/while/if ... เป็น shell keyword ไม่ใช่ command: ตัดสินจาก command ที่ตามหลัง (ถ้ามี)
        if name in ("for", "select", "case"):
            return [verdict("ALLOW", "SHELL_READ_ONLY", f"shell keyword: {name}")]
        rest = words[1:]
        if not rest:
            return [verdict("ALLOW", "SHELL_READ_ONLY", f"shell keyword: {name}")]
        return _classify_by_command(command_name(rest), rest, seg, nxt, ctx)
    if name in ("sudo", "doas", "su"):
        return [verdict("DENY", "PRIVILEGE_ESCALATION", f"privileged execution: {name}", name)]
    if name in SHELL_NAMES and seg.piped_from_previous:
        return [verdict("DENY", "PIPE_TO_SHELL", "piping remote content into shell")]
    if name in ("curl", "wget") and nxt is not None and command_name(nxt.words) in SHELL_NAMES and nxt.piped_from_previous:
        return [verdict("DENY", "PIPE_TO_SHELL", f"{name} piped into shell")]
    if name == "git":
        return [classify_git(words, ctx)]
    if name == "gh":
        return [classify_gh(words)]
    if name in ("docker", "docker-compose", "podman"):
        return [_classify_docker(name, words)]
    if name in PKG_MANAGERS:
        return [_classify_package_manager(name, lower)]
    if name == "rm":
        flags = "".join(w for w in words[1:] if w.startswith("-") and not w.startswith("--"))
        long = [w for w in words[1:] if w.startswith("--")]
        recursive = bool(re.search(r"r", flags, re.I)) or "--recursive" in long
        force = "f" in flags or "--force" in long
        if recursive and force:
            return [verdict("ASK", "DESTRUCTIVE_DELETE", f"recursive force delete: {joined}", " ".join(w for w in words[1:] if not w.startswith("-")))]
        return [verdict("ALLOW", "FS_WRITE_SOURCE", "delete file")]
    if name in ("pi", "claude", "codex"):
        return [verdict("ALLOW", "BUILD", f"agent CLI: {name}")]
    if name in DB_CLIENTS or name in ("dropdb", "prisma", "sequelize", "knex", "alembic", "typeorm"):
        return [_classify_database(name, words, joined)]
    if name in DEPLOY_CMDS:
        return [_classify_deploy(name, lower, joined)]
    if name in REMOTE_CMDS:
        remote = next((w for w in words[1:] if not w.startswith("-") and ("@" in w or re.match(r"^[^/]+:", w))), None)
        if remote:
            return [verdict("ASK", "OUTSIDE_TRUST_ZONE", f"remote host operation: {name} {remote}", remote)]
        return [verdict("ALLOW", "SHELL_READ_ONLY", f"{name} local")]
    if name == "php" and len(lower) > 1 and lower[1] == "artisan":
        return [_classify_artisan(lower, joined)]
    if name in ("rails", "rake", "bin/rails"):
        if any(re.match(r"^db:(reset|drop|schema:load|purge)", w) for w in lower):
            return [_prod_or_local_destructive(joined)]
    if name == "dotnet":
        if len(lower) > 3 and lower[1] == "ef" and lower[2] == "database" and lower[3] == "drop":
            return [_prod_or_local_destructive(joined)]
        if len(lower) > 1 and lower[1] == "test":
            return [verdict("ALLOW", "TEST", "dotnet test")]
        if len(lower) > 1 and lower[1] == "tool" and "-g" in lower:
            return [verdict("ASK", "GLOBAL_DEP_INSTALL", joined)]
        return [verdict("ALLOW", "BUILD", joined)]
    if name == "go" and len(lower) > 1 and lower[1] == "test":
        return [verdict("ALLOW", "TEST", "go test")]
    if name == "cargo" and len(lower) > 1 and lower[1] == "test":
        return [verdict("ALLOW", "TEST", "cargo test")]
    if name == "cargo" and len(lower) > 1 and lower[1] == "clippy":
        return [verdict("ALLOW", "LINT", "cargo clippy")]
    if name in TEST_CMDS:
        return [verdict("ALLOW", "TEST", name)]
    if name in LINT_CMDS:
        return [verdict("ALLOW", "LINT", name)]
    if name in BUILD_CMDS:
        if name in ("npx", "pnpx", "bunx") and len(words) > 1:
            inner = command_name([words[1]])
            if inner in TEST_CMDS:
                return [verdict("ALLOW", "TEST", joined)]
            if inner in LINT_CMDS:
                return [verdict("ALLOW", "LINT", joined)]
            if inner in ("prisma", "sequelize", "knex", "typeorm"):
                return [_classify_database(inner, words[1:], " ".join(words[1:]))]
        return [verdict("ALLOW", "BUILD", name)]
    if name in READ_ONLY_CMDS:
        return [verdict("ALLOW", "SHELL_READ_ONLY", name)]
    if name in SHELL_NAMES:
        # `bash scripts/x.sh args` (ไม่ใช่ -c ซึ่ง parser unwrap ไปแล้ว): ตัดสินจาก path ของ script
        script = next((w for w in words[1:] if not w.startswith("-")), None)
        if script is None:
            return [verdict("ASK", "UNKNOWN_COMMAND", f"interactive shell: {name}", name)]
        v = classify_path("read", script, ctx)
        if v.decision != "ALLOW":
            return [v]
        return [verdict("ALLOW", "BUILD", f"shell script: {script}")]
    if name.endswith((".sh", ".py", ".js", ".ts")):
        v = classify_path("read", words[0], ctx)
        if v.decision != "ALLOW":
            return [v]
        return [verdict("ALLOW", "BUILD", f"project script: {words[0]}")]
    return [verdict("ASK", "UNKNOWN_COMMAND", f"unknown command: {name}", name)]


def _git_subcommand(words: list[str]) -> tuple[str, list[str]]:
    i = 1
    while i < len(words):
        w = words[i]
        if w in ("-C", "-c"):
            i += 2
            continue
        if w.startswith("-"):
            i += 1
            continue
        break
    sub = words[i].lower() if i < len(words) else ""
    return sub, words[i + 1:]


GIT_READ = {"status", "diff", "log", "show", "blame", "fetch", "ls-files", "ls-remote", "rev-parse", "describe", "shortlog", "reflog", "grep", "cat-file", "show-ref", "for-each-ref", "worktree", "config", "help", "version", "--version", "remote", "branch", "tag", "stash", "name-rev", "merge-base", "cherry", "bisect", "count-objects", "fsck", "gc", "notes"}
GIT_LOCAL_WRITE = {"add", "commit", "switch", "checkout", "merge", "rebase", "cherry-pick", "revert", "restore", "mv", "rm", "apply", "am", "init", "pull", "submodule", "sparse-checkout", "mergetool", "format-patch", "clone", "reset"}


def classify_git(words: list[str], ctx: PolicyContext) -> Verdict:
    sub, args = _git_subcommand(words)
    lower = [a.lower() for a in args]
    first = lower[0] if lower else ""
    if sub == "push":
        return classify_git_push(args, ctx)
    if sub == "remote":
        if first in ("add", "set-url", "remove", "rm", "rename", "set-head", "prune"):
            return verdict("ASK", "GIT_REMOTE_CHANGE", f"git remote {first}", " ".join(lower[:2]))
        return verdict("ALLOW", "GIT_STATUS", "git remote (read)")
    if sub == "reset":
        if "--hard" in lower or "--merge" in lower:
            return verdict("ASK", "GIT_RESET_HARD", "git reset --hard", " ".join(args))
        return verdict("ALLOW", "GIT_COMMIT", "git reset (soft/mixed)")
    if sub == "clean":
        if any(a == "--force" or (re.match(r"^-[a-z]*f", a, re.I) and not a.startswith("--")) for a in lower):
            return verdict("ASK", "GIT_CLEAN", "git clean force", " ".join(args))
        return verdict("ALLOW", "GIT_STATUS", "git clean dry-run")
    if sub == "branch":
        targets = " ".join(a for a in args if not a.startswith("-"))
        if any(a == "-D" or (re.match(r"^-[a-zA-Z]*D", a) and not a.startswith("--")) for a in args):
            return verdict("ASK", "GIT_BRANCH_FORCE_DELETE", "force delete local branch", targets)
        if "--delete" in lower and ("--force" in lower or "-f" in lower):
            return verdict("ASK", "GIT_BRANCH_FORCE_DELETE", "force delete local branch", targets)
        if "-d" in lower or "--delete" in lower:
            return verdict("ALLOW", "GIT_COMMIT", "delete merged local branch")
        return verdict("ALLOW", "GIT_STATUS", "git branch")
    if sub == "tag":
        if "-d" in lower or "--delete" in lower:
            return verdict("ASK", "GIT_BRANCH_FORCE_DELETE", "delete tag", " ".join(a for a in args if not a.startswith("-")))
        return verdict("ALLOW", "GIT_COMMIT", "git tag")
    if sub == "config":
        if "--global" in lower or "--system" in lower:
            return verdict("ASK", "SYSTEM_CONFIG_CHANGE", "git config --global", " ".join(args))
        return verdict("ALLOW", "GIT_COMMIT", "git config local")
    if sub == "stash":
        if first in ("drop", "clear"):
            return verdict("ASK", "GIT_BRANCH_FORCE_DELETE", f"git stash {first}", f"stash {first}")
        return verdict("ALLOW", "GIT_COMMIT", "git stash")
    if sub in ("filter-branch", "filter-repo", "replace"):
        return verdict("ASK", "GIT_RESET_HARD", f"history rewrite: git {sub}", sub)
    if sub in GIT_READ:
        return verdict("ALLOW", "GIT_STATUS", f"git {sub}")
    if sub in GIT_LOCAL_WRITE:
        return verdict("ALLOW", "GIT_COMMIT", f"git {sub}")
    return verdict("ASK", "UNKNOWN_COMMAND", f"unknown git subcommand: {sub}", f"git {sub}")


PUSH_FLAGS_WITH_VALUE = {"-o", "--push-option", "--receive-pack", "--exec", "--repo", "--recurse-submodules", "--signed"}


def _normalize_ref(ref: str) -> str:
    r = ref.strip().lower()
    if r.startswith("+"):
        r = r[1:]
    if r.startswith("refs/heads/"):
        r = r[len("refs/heads/"):]
    elif r.startswith("refs/remotes/"):
        r = "/".join(r.split("/")[3:])
    elif r.startswith("refs/tags/"):
        r = "tags/" + r[len("refs/tags/"):]
    return r


def classify_git_push(args: list[str], ctx: PolicyContext) -> Verdict:
    protected = {b.lower() for b in ctx.protected_branches}
    force = delete = all_ = mirror = False
    positional: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        la = a.lower()
        if la == "--":
            positional.extend(args[i + 1:])
            break
        if a.startswith("--"):
            key = la.split("=", 1)[0]
            if key in ("--force", "--force-with-lease", "--force-if-includes"):
                force = True
            elif key == "--delete":
                delete = True
            elif key in ("--all", "--branches"):
                all_ = True
            elif key == "--mirror":
                mirror = True
            elif key in PUSH_FLAGS_WITH_VALUE and "=" not in la:
                i += 1
            i += 1
            continue
        if a.startswith("-") and len(a) > 1:
            letters = a[1:]
            if "f" in letters:
                force = True
            if "d" in letters:
                delete = True
            if a in PUSH_FLAGS_WITH_VALUE:
                i += 1
            i += 1
            continue
        positional.append(a)
        i += 1
    remote = positional[0] if positional else None
    refspecs = positional[1:]
    if any(r.startswith("+") for r in refspecs):
        force = True
    if force or mirror:
        return verdict("DENY", "GIT_FORCE_PUSH", "force push is never allowed", " ".join(positional))
    if all_:
        return verdict("DENY", "GIT_PUSH_PROTECTED", "--all pushes protected branches", "--all")
    if not remote or not refspecs:
        return verdict("DENY", "GIT_PUSH_BARE", "push must name remote and branch", remote or "")
    results: list[Verdict] = []
    for spec in refspecs:
        colon = spec.find(":")
        src = spec if colon == -1 else spec[:colon]
        dst = spec if colon == -1 else spec[colon + 1:]
        norm_dst = _normalize_ref(dst)
        norm_src = _normalize_ref(src)
        if norm_dst in protected or (src != "" and norm_src in protected and colon == -1):
            results.append(verdict("DENY", "GIT_PUSH_PROTECTED", f"protected branch: {norm_dst or norm_src}", f"{remote}:{norm_dst or norm_src}"))
            continue
        if re.match(r"^head([~^@]|$)", src, re.I):
            results.append(verdict("DENY", "GIT_PUSH_HEAD", "HEAD as source ref is ambiguous", f"{remote}:{spec}"))
            continue
        if delete or src == "":
            results.append(verdict("ASK", "GIT_REMOTE_DELETE", f"delete remote ref {norm_dst}", f"{remote}:{norm_dst}"))
            continue
        results.append(verdict("ALLOW", "GIT_PUSH_FEATURE", f"push {norm_src} to {remote}/{norm_dst}", f"{remote}:{norm_dst}"))
    return strictest(results)


GH_READ_SUBS = {"view", "list", "status", "checks", "diff", "download", "watch", "search", "browse", "ls", "logs"}


def _method_of(lower: list[str]) -> str:
    for i, w in enumerate(lower):
        if w in ("-x", "--method"):
            return (lower[i + 1] if i + 1 < len(lower) else "GET").upper()
        if w.startswith("--method="):
            return w.split("=", 1)[1].upper()
    if any(w in ("-f", "-F", "--field", "--raw-field", "--input") for w in lower):
        return "POST"
    return "GET"


def _is_value_of_flag(lower: list[str], w: str) -> bool:
    try:
        i = lower.index(w)
    except ValueError:
        return False
    if i <= 0:
        return False
    return lower[i - 1] in ("-x", "--method", "-f", "--field", "--raw-field", "-h", "--header", "--jq", "-q", "--input", "-p", "--preview")


def classify_gh(words: list[str]) -> Verdict:
    lower = [w.lower() for w in words]
    group = lower[1] if len(lower) > 1 else None
    sub = lower[2] if len(lower) > 2 else None
    tail = " ".join(words[3:])
    if group == "auth":
        if sub == "token" or "--show-token" in lower or "-t" in lower:
            return verdict("DENY", "CREDENTIAL_READ", "gh auth token exposes credential", "gh auth token")
        if sub == "status":
            return verdict("ALLOW", "GH_READ", "gh auth status")
        if sub in ("login", "logout", "refresh", "switch", "setup-git"):
            return verdict("ASK", "GH_AUTH_CHANGE", f"gh auth {sub}", f"gh auth {sub}")
        return verdict("ASK", "UNKNOWN_COMMAND", f"gh auth {sub or ''}")
    if group == "gist":
        return verdict("DENY", "PUBLIC_GIST", "gist publishes repository content", "gh gist")
    if group == "secret" or (group == "variable" and sub != "list"):
        return verdict("DENY", "GH_SECRET_MANAGE", f"gh {group}", f"gh {group}")
    if group == "pr":
        if sub == "merge":
            return verdict("DENY", "GH_PR_MERGE", "merge is a user decision", tail)
        if sub == "create":
            return verdict("ALLOW", "GH_PR_CREATE", "create pull request")
        if sub in ("close", "reopen", "lock"):
            return verdict("ASK", "GH_REPO_CREATE", f"gh pr {sub}", f"gh pr {sub}")
        if sub in ("edit", "comment", "review", "ready", "checkout", "update-branch"):
            return verdict("ALLOW", "GH_PR_UPDATE", f"gh pr {sub}")
        if sub in GH_READ_SUBS:
            return verdict("ALLOW", "GH_READ", f"gh pr {sub}")
        return verdict("ASK", "UNKNOWN_COMMAND", f"gh pr {sub or ''}")
    if group == "issue":
        if sub in ("create", "comment", "edit", "develop", "pin", "unpin"):
            return verdict("ALLOW", "GH_PR_UPDATE", f"gh issue {sub}")
        if sub in ("close", "reopen", "delete", "transfer", "lock"):
            return verdict("ASK", "GH_REPO_CREATE", f"gh issue {sub}", f"gh issue {sub}")
        if sub in GH_READ_SUBS:
            return verdict("ALLOW", "GH_READ", f"gh issue {sub}")
        return verdict("ASK", "UNKNOWN_COMMAND", f"gh issue {sub or ''}")
    if group == "repo":
        if sub == "delete":
            return verdict("DENY", "GH_REPO_DELETE", "repository deletion is never allowed", tail)
        if sub in ("create", "fork", "archive", "unarchive", "rename", "edit", "sync", "set-default", "deploy-key"):
            return verdict("ASK", "GH_REPO_CREATE", f"gh repo {sub}", f"gh repo {sub}")
        if sub in GH_READ_SUBS or sub == "clone":
            return verdict("ALLOW", "GH_READ", f"gh repo {sub}")
        return verdict("ASK", "UNKNOWN_COMMAND", f"gh repo {sub or ''}")
    if group == "release":
        if sub in ("create", "edit", "upload", "delete", "delete-asset"):
            return verdict("ASK", "GH_REPO_CREATE", f"gh release {sub}", f"gh release {sub}")
        if sub in GH_READ_SUBS:
            return verdict("ALLOW", "GH_READ", f"gh release {sub}")
        return verdict("ASK", "UNKNOWN_COMMAND", f"gh release {sub or ''}")
    if group in ("run", "workflow"):
        if sub in ("rerun", "cancel", "run", "enable", "disable"):
            return verdict("ALLOW", "GH_PR_UPDATE", f"gh {group} {sub}")
        if sub == "delete":
            return verdict("ASK", "GH_REPO_CREATE", "gh run delete", "gh run delete")
        return verdict("ALLOW", "GH_READ", f"gh {group} {sub or ''}")
    if group == "api":
        method = _method_of(lower)
        skip = {"--method", "-x", "-f", "--field", "--raw-field", "-h", "--header", "--jq", "-q", "--input"}
        url = next((w for w in lower[2:] if not w.startswith("-") and w != method.lower() and w not in skip and not _is_value_of_flag(lower, w)), "")
        if url.endswith("/merge") and method != "GET":
            return verdict("DENY", "GH_PR_MERGE", "merge via API", url)
        if "/gists" in url and method != "GET":
            return verdict("DENY", "PUBLIC_GIST", "gist via API", url)
        if "/secrets" in url and method != "GET":
            return verdict("DENY", "GH_SECRET_MANAGE", "secrets via API", url)
        if method == "DELETE" and re.match(r"^/?repos/[^/]+/[^/]+/?$", url):
            return verdict("DENY", "GH_REPO_DELETE", "repository deletion via API", url)
        if method == "GET":
            return verdict("ALLOW", "GH_READ", f"gh api GET {url}")
        if re.search(r"/(pulls|issues)(/|$)", url) and method in ("POST", "PATCH"):
            return verdict("ALLOW", "GH_PR_UPDATE", f"gh api {method} {url}")
        return verdict("ASK", "UNKNOWN_COMMAND", f"gh api {method} {url}", url)
    if group in ("codespace", "ssh-key", "gpg-key", "config", "extension", "alias"):
        return verdict("ASK", "UNKNOWN_COMMAND", f"gh {group}", f"gh {group}")
    if group in ("search", "browse", "status", "label", "project", "cache", "org", "ruleset", "attestation", "version", "--version", "help"):
        return verdict("ALLOW", "GH_READ", f"gh {group}")
    return verdict("ASK", "UNKNOWN_COMMAND", f"gh {group or ''}")


def _classify_docker(name: str, words: list[str]) -> Verdict:
    lower = [w.lower() for w in words]
    i = 1
    while i < len(lower) and lower[i].startswith("-"):
        if lower[i] in ("--context", "-c", "-h", "--host", "--config", "-l", "--log-level"):
            i += 1
        i += 1
    sub = lower[i] if i < len(lower) else ""
    rest = lower[i + 1:]
    if name == "docker-compose":
        rest = lower[i:]
        sub = "compose"
    joined = " ".join(words)
    if sub in ("compose", "stack"):
        j = 0
        while j < len(rest) and rest[j].startswith("-"):
            if rest[j] in ("-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory"):
                j += 1
            j += 1
        csub = rest[j] if j < len(rest) else ""
        cargs = rest[j + 1:]
        if csub == "down" and any(a in ("-v", "--volumes") or re.match(r"^-[a-z]*v", a) for a in cargs):
            return verdict("ASK", "DOCKER_DELETE_VOLUME", "compose down removes volumes", joined)
        if csub == "rm" and any(a in ("-v", "--volumes") for a in cargs):
            return verdict("ASK", "DOCKER_DELETE_VOLUME", "compose rm -v", joined)
        if csub == "build":
            return verdict("ALLOW", "LOCAL_DOCKER_BUILD", "compose build")
        if csub in ("up", "start", "stop", "restart", "logs", "ps", "exec", "run", "pull", "down", "config", "images", "top", "port", "events", "create", "kill", "pause", "unpause", "rm", "cp", "ls", "version", "watch", "attach", "wait", "stats"):
            return verdict("ALLOW", "LOCAL_DOCKER_UP", f"compose {csub}")
        return verdict("ASK", "UNKNOWN_COMMAND", f"docker compose {csub}")
    if sub in ("build", "buildx"):
        return verdict("ALLOW", "LOCAL_DOCKER_BUILD", "docker build")
    r0 = rest[0] if rest else ""
    if sub == "system" and r0 == "prune":
        return verdict("ASK", "DOCKER_PRUNE", "docker system prune", joined)
    if sub == "volume":
        if r0 in ("rm", "prune", "remove"):
            return verdict("ASK", "DOCKER_DELETE_VOLUME", f"docker volume {r0}", joined)
        return verdict("ALLOW", "LOCAL_DOCKER_UP", f"docker volume {r0}")
    if sub in ("image", "container", "network", "builder") and r0 in ("prune", "rm", "remove"):
        return verdict("ASK", "DOCKER_PRUNE", f"docker {sub} {r0}", joined)
    if sub in ("rmi", "rm"):
        if sub == "rm" and any(a in ("-v", "--volumes") for a in rest):
            return verdict("ASK", "DOCKER_DELETE_VOLUME", "docker rm -v", joined)
        return verdict("ASK", "DOCKER_PRUNE", f"docker {sub}", joined)
    if sub == "run" and "--privileged" in rest:
        return verdict("ASK", "UNKNOWN_COMMAND", "privileged container", joined)
    if sub == "run" and any("docker.sock" in a for a in rest):
        return verdict("ASK", "UNKNOWN_COMMAND", "container with docker socket", joined)
    if sub in ("login", "logout"):
        return verdict("ASK", "GH_AUTH_CHANGE", f"docker {sub}", f"docker {sub}")
    if sub == "push":
        return verdict("ASK", "STAGING_DEPLOY", "docker push to registry", joined)
    if sub == "context" and r0 and r0 not in ("ls", "show", "inspect"):
        return verdict("ASK", "SYSTEM_CONFIG_CHANGE", f"docker context {r0}", joined)
    if sub in ("run", "exec", "start", "stop", "restart", "logs", "ps", "pull", "images", "inspect", "cp", "create", "kill", "pause", "unpause", "stats", "top", "port", "version", "info", "events", "wait", "attach", "tag", "load", "save", "history", "diff", "commit", "export", "import", "search", "sbom", "scout", "network", "image", "container", "manifest", "system", "sandbox", "init", "compose"):
        return verdict("ALLOW", "LOCAL_DOCKER_UP", f"docker {sub}")
    return verdict("ASK", "UNKNOWN_COMMAND", f"docker {sub}")


def _classify_package_manager(name: str, lower: list[str]) -> Verdict:
    joined = " ".join(lower)
    sub = lower[1] if len(lower) > 1 else ""
    has_global = any(x in lower for x in ("-g", "--global", "global", "-global"))
    if name in ("brew", "apt", "apt-get", "yum", "dnf", "pacman", "port", "choco", "winget", "snap"):
        if sub in ("install", "uninstall", "remove", "upgrade", "update", "reinstall", "link", "unlink", "tap", "untap", "cask", "purge", "autoremove", "add", "dist-upgrade") and "--dry-run" not in lower:
            return verdict("ASK", "GLOBAL_DEP_INSTALL", f"{name} {sub}", joined)
        return verdict("ALLOW", "SHELL_READ_ONLY", f"{name} {sub}")
    if name in ("pipx", "conda"):
        if sub in ("install", "uninstall", "upgrade", "remove", "inject", "create", "env"):
            return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined)
        return verdict("ALLOW", "SHELL_READ_ONLY", joined)
    if name == "cargo" and sub in ("install", "uninstall"):
        return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined)
    if name == "go" and sub == "install":
        return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined)
    if name == "gem" and sub in ("install", "uninstall", "update"):
        return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined)
    if name == "dotnet":
        return verdict("ALLOW", "BUILD", joined)
    if name == "composer" and sub == "global":
        return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined)
    if name in ("pip", "pip3", "uv", "poetry"):
        if sub in ("install", "uninstall", "add", "remove", "sync") and any(x in lower for x in ("--user", "--system", "--break-system-packages")):
            return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined)
        if name == "uv" and sub == "tool":
            return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined)
        if sub in ("install", "uninstall", "add", "remove", "sync", "lock", "update", "upgrade"):
            return verdict("ALLOW", "LOCAL_DEP_INSTALL", joined)
        if sub in ("run", "shell"):
            return verdict("ALLOW", "BUILD", joined)
        return verdict("ALLOW", "SHELL_READ_ONLY", joined)
    if has_global and sub in ("install", "i", "add", "uninstall", "remove", "rm", "un", "update", "up", "link", "ln", "global"):
        return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined)
    if name == "yarn" and sub == "global":
        return verdict("ASK", "GLOBAL_DEP_INSTALL", joined, joined)
    if sub == "publish":
        return verdict("ASK", "STAGING_DEPLOY", f"{name} publish", joined)
    if sub in ("login", "logout", "adduser", "token"):
        return verdict("ASK", "GH_AUTH_CHANGE", f"{name} {sub}", joined)
    if sub in ("install", "i", "ci", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "dedupe", "prune", "link", "outdated", "audit", "require", "dump-autoload", "self-update", "mod", "vendor", "fetch", "generate", "rebuild"):
        if name == "go" and sub == "generate":
            return verdict("ALLOW", "BUILD", joined)
        return verdict("ALLOW", "LOCAL_DEP_INSTALL", joined)
    if sub in ("test", "t"):
        return verdict("ALLOW", "TEST", joined)
    if sub in ("run", "run-script", "exec", "x", "dlx", "create"):
        script = lower[2] if len(lower) > 2 else ""
        if re.search(r"test|spec|e2e", script):
            return verdict("ALLOW", "TEST", joined)
        if re.search(r"lint|format|prettier|typecheck|type-check|check", script):
            return verdict("ALLOW", "LINT", joined)
        if re.search(r"deploy|release|publish", script):
            return verdict("ASK", "PROD_DEPLOY" if PROD_MARKER.search(joined) else "STAGING_DEPLOY", joined, joined)
        return verdict("ALLOW", "BUILD", joined)
    if sub in ("build", "start", "dev", "serve", "preview", "lint", "format", "check", "version", "ls", "list", "why", "info", "view", "search", "config", "cache", "pack", "init", "explain", "licenses", "show", "env", "bin", "root", "doctor", "workspaces", "ping", "vet", "fmt", "clean", "tree", "metadata", "doc", "bench", "help", "-v", "--version"):
        if sub in ("lint", "format", "check", "vet", "fmt"):
            return verdict("ALLOW", "LINT", joined)
        if sub in ("build", "start", "dev", "serve", "preview", "pack", "bench"):
            return verdict("ALLOW", "BUILD", joined)
        return verdict("ALLOW", "SHELL_READ_ONLY", joined)
    if name in ("cargo", "go"):
        return verdict("ALLOW", "BUILD", joined)
    return verdict("ASK", "UNKNOWN_COMMAND", joined, joined)


def _prod_or_local_destructive(joined: str) -> Verdict:
    if PROD_MARKER.search(joined):
        return verdict("ASK", "PROD_DESTRUCTIVE_DB", "destructive production database operation requires backup and rollback plan", joined)
    return verdict("ASK", "LOCAL_DESTRUCTIVE_DB", "destructive database operation", joined)


def _classify_database(name: str, words: list[str], joined: str) -> Verdict:
    lower = joined.lower()
    if name == "dropdb":
        return _prod_or_local_destructive(joined)
    if name == "prisma":
        if re.search(r"migrate reset|db push .*--force-reset|--force-reset", lower):
            return _prod_or_local_destructive(joined)
        return verdict("ALLOW", "BUILD", "prisma")
    if name in ("sequelize", "knex", "typeorm", "alembic"):
        if re.search(r"db:drop|schema:drop|migrate:rollback --all|downgrade base|drop", lower):
            return _prod_or_local_destructive(joined)
        return verdict("ALLOW", "BUILD", name)
    is_prod = bool(PROD_MARKER.search(joined))
    if DB_DESTRUCTIVE_SQL.search(joined):
        return _prod_or_local_destructive(joined)
    if is_prod:
        return verdict("ASK", "PROD_DB_WRITE", "database client against production target", joined)
    return verdict("ALLOW", "SHELL_READ_ONLY", f"local database client: {name}")


def _classify_deploy(name: str, lower: list[str], joined: str) -> Verdict:
    sub = lower[1] if len(lower) > 1 else ""
    is_prod = bool(PROD_MARKER.search(joined)) or "--prod" in lower or "--production" in lower
    read_only = ["get", "describe", "logs", "plan", "validate", "fmt", "show", "list", "ls", "status", "version", "whoami", "config", "output", "diff", "explain", "api-resources", "top", "preview", "help", "init", "login", "lint", "template", "repo", "search", "env", "info", "inspect", "auth", "sts", "s3api", "cluster-info", "--version", "-v"]
    rule = "PROD_DEPLOY" if is_prod else "STAGING_DEPLOY"
    if name in ("kubectl", "helm", "terraform", "tofu", "pulumi", "cdk"):
        if sub in read_only:
            return verdict("ALLOW", "SHELL_READ_ONLY", f"{name} {sub}")
        return verdict("ASK", rule, f"{name} {sub}", joined)
    if name in ("aws", "gcloud", "az", "doctl"):
        verbs = ["deploy", "update", "create", "delete", "put", "run", "apply", "start", "stop", "restart", "scale", "set", "publish", "invoke", "sync", "cp", "rm", "mb", "rb", "release", "rollout", "terminate", "reboot", "modify", "attach", "detach", "enable", "disable", "import", "restore", "purge"]
        if any(w in verbs or any(w.startswith(v + "-") for v in verbs) for w in lower[1:]):
            return verdict("ASK", rule, joined, joined)
        return verdict("ALLOW", "SHELL_READ_ONLY", f"{name} read")
    if sub in read_only:
        return verdict("ALLOW", "SHELL_READ_ONLY", f"{name} {sub}")
    return verdict("ASK", rule, f"{name} {sub}", joined)


def _classify_artisan(lower: list[str], joined: str) -> Verdict:
    cmd = lower[2] if len(lower) > 2 else ""
    if re.match(r"^(migrate:fresh|migrate:reset|migrate:rollback|db:wipe|migrate:refresh)$", cmd):
        return _prod_or_local_destructive(joined)
    if cmd == "test":
        return verdict("ALLOW", "TEST", "artisan test")
    if cmd == "deploy" or cmd.startswith("deploy:"):
        return verdict("ASK", "PROD_DEPLOY" if PROD_MARKER.search(joined) else "STAGING_DEPLOY", joined, joined)
    return verdict("ALLOW", "BUILD", f"artisan {cmd}")


# ---------------------------------------------------------------------------
# tool-level classification
# ---------------------------------------------------------------------------

READ_TOOLS = {"read", "read_file", "view", "glob", "grep", "ls", "find", "cat"}
WRITE_TOOLS = {"write", "write_file", "edit", "multiedit", "create_file", "str_replace_editor", "notebookedit"}
DELETE_TOOLS = {"delete", "delete_file", "remove_file"}
GITHUB_TOOL_NAMES = {
    "merge_pull_request", "enable_auto_merge", "delete_file", "update_ref", "create_pull_request", "create_branch", "create_commit", "create_tree", "create_blob",
    "push_files", "create_or_update_file", "add_comment_to_issue", "create_issue", "update_issue", "create_pull_request_review", "rerun_failed_workflow_run_jobs",
    "rerun_workflow_job", "delete_repository", "create_gist", "create_repository", "fork_repository", "get_file_contents", "list_pull_requests", "search_code",
}


def _shell_quote(s: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_./:=+@%,-]+", s):
        return s
    return "'" + s.replace("'", "'\\''") + "'"


def _shell_command_from_input(inp: dict) -> Optional[str]:
    c = inp.get("command", inp.get("cmd", inp.get("script")))
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(_shell_quote(str(x)) for x in c)
    return None


def _path_from_input(inp: dict) -> Optional[str]:
    for key in ("file_path", "path", "filePath", "filename", "file", "target", "notebook_path", "pattern_path", "cwd"):
        v = inp.get(key)
        if isinstance(v, str) and v != "":
            return v
    return None


def classify_tool(tool_name: str, inp: Optional[dict], ctx: PolicyContext) -> Verdict:
    raw = tool_name
    name = raw.lower()
    inp = inp or {}
    m = re.match(r"^mcp__([^_]+)__(.+)$", name)
    is_github = name.startswith("github.") or (m is not None and "github" in m.group(1)) or (m is None and name in GITHUB_TOOL_NAMES)
    if m:
        name = m.group(2)
    if name.startswith("github."):
        name = name[len("github."):]
    if is_github:
        return _classify_github_tool(name, inp, ctx)
    if name in ("bash", "shell", "exec_command", "unified_exec", "run_command", "local_shell", "powershell", "shell_command"):
        cmd = _shell_command_from_input(inp)
        if cmd is None:
            return verdict("ASK", "UNKNOWN_COMMAND", f"shell tool without command: {raw}")
        return classify_command(cmd, ctx)
    if name == "apply_patch":
        patch = str(inp.get("patch", inp.get("input", "")))
        verdicts = []
        for mm in re.finditer(r"^\*\*\* (Add|Update|Delete) File: (.+)$", patch, re.M):
            verdicts.append(classify_path("delete" if mm.group(1) == "Delete" else "write", mm.group(2).strip(), ctx))
        for mm in re.finditer(r"^\*\*\* Move to: (.+)$", patch, re.M):
            verdicts.append(classify_path("write", mm.group(1).strip(), ctx))
        if not verdicts:
            return verdict("ASK", "UNKNOWN_COMMAND", "apply_patch without file headers")
        return strictest(verdicts)
    p = _path_from_input(inp)
    if name in READ_TOOLS:
        return verdict("ALLOW", "FS_READ_SOURCE", f"{raw} without path") if p is None else classify_path("read", p, ctx)
    if name in WRITE_TOOLS:
        return verdict("ASK", "UNKNOWN_COMMAND", f"{raw} without path") if p is None else classify_path("write", p, ctx)
    if name in DELETE_TOOLS:
        return verdict("ASK", "UNKNOWN_COMMAND", f"{raw} without path") if p is None else classify_path("delete", p, ctx)
    if name in ("webfetch", "web_fetch", "websearch", "web_search", "fetch", "webrun"):
        return verdict("ALLOW", "SHELL_READ_ONLY", raw)
    if name in ("share", "share_session", "export_session"):
        return verdict("DENY", "PI_SHARE", "session share is blocked", raw)
    # Codex ส่ง namespace ติดกับชื่อ tool เช่น collaborationwait_agent
    if name.startswith("collaboration"):
        name = name[len("collaboration"):]
    if name in AGENT_COORDINATION_TOOLS:
        return verdict("ALLOW", "AGENT_SPAWN", f"agent coordination: {raw}", raw)
    if name in ("update_plan", "todowrite", "todoread"):
        return verdict("ALLOW", "SHELL_READ_ONLY", f"plan tool: {raw}")
    if name in AGENT_TOOLS:
        return classify_agent_spawn(raw, inp, ctx)
    return verdict("ASK", "UNKNOWN_COMMAND", f"unknown tool: {raw}", raw)


AGENT_TOOLS = {"agent", "task", "spawn_agent", "dispatch_agent", "subagent"}
AGENT_COORDINATION_TOOLS = {"wait_agent", "send_message", "list_agents", "followup_task", "interrupt_agent", "close_agent", "resume_agent", "send_input"}


def classify_agent_spawn(raw: str, inp: dict, ctx: PolicyContext) -> Verdict:
    """mirror ของ classifyAgentSpawn: security agent บน provider ที่ไม่ใช่ Anthropic = DENY"""
    agent_type = ""
    for key in ("subagent_type", "agent_type", "subagentType", "agentType", "type"):
        v = inp.get(key)
        if isinstance(v, str) and v.strip():
            agent_type = v.strip().lower()
            break
    host = (ctx.provider_host or "").lower()
    third_party = host != "" and host not in [h.lower() for h in ctx.anthropic_hosts]
    if third_party and agent_type in [t.lower() for t in ctx.security_agent_types]:
        return verdict(
            "DENY",
            "SECURITY_AGENT_PROVIDER",
            f"security agent '{agent_type}' on third-party provider {host}: its content filter flags audit context permanently; run this agent on Anthropic directly",
            agent_type,
        )
    return verdict("ALLOW", "AGENT_SPAWN", f"spawn agent {agent_type or raw}", agent_type or raw)


def _classify_github_tool(name: str, inp: dict, ctx: PolicyContext) -> Verdict:
    protected = {b.lower() for b in ctx.protected_branches}
    ref_raw = str(inp.get("ref", inp.get("branch", inp.get("base", inp.get("head", "")))) or "")
    ref = ref_raw.lower()
    if ref.startswith("refs/heads/"):
        ref = ref[len("refs/heads/"):]
    if name in ("merge_pull_request", "enable_auto_merge", "merge_pull_request_branch"):
        return verdict("DENY", "GH_PR_MERGE", "merge is a user decision", name)
    if name in ("delete_repository", "delete_repo"):
        return verdict("DENY", "GH_REPO_DELETE", "repository deletion", name)
    if name == "create_gist" or "gist" in name:
        return verdict("DENY", "PUBLIC_GIST", "gist", name)
    if "secret" in name:
        return verdict("DENY", "GH_SECRET_MANAGE", name, name)
    if name == "delete_file":
        return verdict("ASK", "GH_DELETE_FILE", f"delete file {inp.get('path', '')}", str(inp.get("path", name)))
    if name in ("update_ref", "push_files", "create_or_update_file", "delete_branch"):
        if ref != "" and ref in protected:
            return verdict("DENY", "GIT_PUSH_PROTECTED", f"protected ref {ref}", ref)
        if inp.get("force") is True:
            return verdict("DENY", "GIT_FORCE_PUSH", "force ref update", ref)
        if name == "delete_branch":
            return verdict("ASK", "GIT_REMOTE_DELETE", f"delete branch {ref}", ref)
        return verdict("ALLOW", "GIT_PUSH_FEATURE", f"{name} {ref}", ref)
    if name == "create_pull_request":
        return verdict("ALLOW", "GH_PR_CREATE", "create pull request")
    if name in ("create_repository", "fork_repository", "create_release", "close_pull_request"):
        return verdict("ASK", "GH_REPO_CREATE", name, name)
    if name.startswith(("get_", "list_", "search_", "read_", "download_")):
        return verdict("ALLOW", "GH_READ", name)
    if name.startswith(("create_", "add_", "update_", "rerun_", "request_", "submit_", "dismiss_", "assign_")):
        return verdict("ALLOW", "GH_PR_UPDATE", name)
    return verdict("ASK", "UNKNOWN_COMMAND", f"unknown GitHub tool: {name}", name)


def classify_user_input(text: str) -> Optional[Verdict]:
    t = text.strip().lower()
    if t == "/share" or t.startswith("/share ") or t == "/export-share":
        return verdict("DENY", "PI_SHARE", "session share uploads repository content", "/share")
    return None


# ---------------------------------------------------------------------------
# config loading for hooks
# ---------------------------------------------------------------------------


def load_context(config_path: str, cwd: str) -> PolicyContext:
    with open(config_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return PolicyContext.from_json(data, cwd)
