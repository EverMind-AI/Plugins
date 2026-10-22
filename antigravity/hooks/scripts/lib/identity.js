import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { APP_ID, AGENT_ID, ID_MAX_LEN } from "./constants.js";

const PATH_SAFE = /[^A-Za-z0-9_.@+-]/g;

/**
 * EverOS turns app_id / project_id / sender_id into directory segments, so it
 * enforces a charset whitelist and rejects "." and "..". Mirror that here - a
 * rejected id would fail the whole /add with a 422.
 */
export function sanitizeId(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  const cleaned = trimmed.replace(PATH_SAFE, "_").slice(0, ID_MAX_LEN);
  if (cleaned === "" || cleaned === "." || cleaned === "..") return fallback;

  // Sanitizing can erase distinct names: e.g. 项目 becomes "__", and so does 测试.
  // Whenever a character was actually lost outside the whitelist, keep the readable
  // part and append a short digest of the original so distinct partitions stay distinct.
  if (cleaned !== trimmed) {
    const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
    const maxPrefixLen = ID_MAX_LEN - digest.length - 1;
    return `${cleaned.slice(0, maxPrefixLen)}_${digest}`;
  }
  return cleaned;
}

/**
 * Sanitize branch string: prevent control character and tag injection, limit length.
 * Strips `<` and `>` to avoid breaking XML tags in prompt injection (<everos_memory>).
 */
export function sanitizeBranch(raw, fallback = "unknown") {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.replace(/[<>]/g, "").replace(/[\r\n\t]/g, " ").trim();
  if (!cleaned) return fallback;
  if (cleaned === "HEAD") return "detached";
  return cleaned.slice(0, ID_MAX_LEN);
}

/** Run a git subcommand, returning trimmed stdout or null. Never throws. */
function defaultGitRunner(args, cwd, timeout = 1000) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: Math.min(Math.max(Number(timeout) || 1000, 100), 1000),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Turn a git remote URL into host + owner + repo.
 * Host is case-folded to lowercase to prevent DNS casing partition splits.
 * Explicit ports (e.g. :2222 or :8080) are safely stripped so host is never lost.
 */
function repoNameFromRemote(url) {
  const trimmed = url.trim().replace(/\.git\/?$/, "");
  if (!trimmed) return null;

  // 1. Try standard URL with scheme (e.g. ssh://git@gitlab.com:2222/org/repo, https://github.com/a/b)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const host = (parsed.hostname || "").toLowerCase();
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length === 0) return host || null;
      const tail = segments.slice(-2);
      return host ? [host, ...tail].join("_") : tail.join("_");
    } catch {}
  }

  // 2. SCP-like syntax: [user@]host:path or [user@]host:port/path
  const withoutUser = trimmed.replace(/^[^/@]+@/, "");
  if (withoutUser.includes(":")) {
    const colonIdx = withoutUser.indexOf(":");
    let host = withoutUser.slice(0, colonIdx).toLowerCase();
    let rest = withoutUser.slice(colonIdx + 1);
    const segments = rest.split("/").filter(Boolean);
    // If the segment immediately following colon is purely digits (port), strip it
    if (segments.length > 1 && /^\d+$/.test(segments[0])) {
      segments.shift();
    }
    const tail = segments.slice(-2);
    return host ? [host, ...tail].join("_") : tail.join("_");
  }

  // 3. Fallback for bare paths like /srv/git/bare-repo
  const segments = withoutUser.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const tail = segments.slice(-3);
  if (tail.length === 3) tail[0] = tail[0].toLowerCase();
  return tail.join("_");
}

/**
 * Extract directory basename and normalize Windows path case to avoid drift
 * (e.g., C:\Project vs c:\project or /c/Project).
 */
function extractLocalBasename(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return "";
  const normalized = rawPath.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const base = segments.pop() || "";
  // Check if Windows platform or Windows path (drive letter)
  const isWindows =
    process.platform === "win32" ||
    /^[a-zA-Z]:[\\/]/.test(rawPath);
  return isWindows ? base.toLowerCase() : base;
}

/**
 * Resolve current git branch name. Returns "unknown" or "detached" if unavailable.
 */
export function resolveBranch(cwd, gitRunner = defaultGitRunner) {
  const current = gitRunner(["branch", "--show-current"], cwd);
  if (current) return sanitizeBranch(current);

  const rev = gitRunner(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (rev && rev !== "HEAD") return sanitizeBranch(rev);
  if (rev === "HEAD") return "detached";

  return "unknown";
}

/**
 * Project partition resolver.
 * Priority:
 * 1. projectIdOverride
 * 2. remote.origin.url (host_owner_repo, host lowercased, ports stripped)
 * 3. git rev-parse --show-toplevel (basename, Windows path case normalized)
 * 4. cwd basename (Windows path case normalized)
 */
export function resolveProjectId(cwd, config = {}, gitRunner = defaultGitRunner) {
  if (config.projectIdOverride) return sanitizeId(config.projectIdOverride, "default");

  const remote = gitRunner(["config", "--get", "remote.origin.url"], cwd);
  if (remote) {
    const name = repoNameFromRemote(remote);
    if (name) return sanitizeId(name, "default");
  }

  const toplevel = gitRunner(["rev-parse", "--show-toplevel"], cwd);
  if (toplevel) return sanitizeId(extractLocalBasename(toplevel), "default");

  return sanitizeId(extractLocalBasename(cwd), "default");
}

export function resolveIdentity(cwdOrOptions, maybeConfig = {}, gitRunner = defaultGitRunner) {
  let cwd = cwdOrOptions;
  let config = maybeConfig;
  if (cwdOrOptions && typeof cwdOrOptions === "object" && !Array.isArray(cwdOrOptions)) {
    cwd =
      cwdOrOptions.cwd ||
      (Array.isArray(cwdOrOptions.workspacePaths) ? cwdOrOptions.workspacePaths[0] : null) ||
      process.cwd();
    config = {
      ...maybeConfig,
      projectIdOverride:
        cwdOrOptions.projectIdOverride ??
        cwdOrOptions.config?.projectIdOverride ??
        maybeConfig.projectIdOverride,
      userId:
        cwdOrOptions.userId ??
        cwdOrOptions.config?.userId ??
        maybeConfig.userId,
    };
  }

  const startTime = Date.now();
  const maxGitBudgetMs = 1500;
  const boundedGitRunner = (args, targetCwd) => {
    const remaining = maxGitBudgetMs - (Date.now() - startTime);
    if (remaining <= 50) return null;
    return gitRunner(args, targetCwd, remaining);
  };

  return {
    appId: APP_ID,
    projectId: resolveProjectId(cwd, config, boundedGitRunner),
    branch: resolveBranch(cwd, boundedGitRunner),
    userId: config.userId ? sanitizeId(config.userId, "default") : null,
    agentId: AGENT_ID,
  };
}
