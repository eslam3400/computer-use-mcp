import { execFile } from "node:child_process";
import { realpathSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { McpToolError, slugify, todaySlug, truncate } from "./util.js";
import type { AppConfig, Workspace } from "./config.js";

type Opts = { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv };

export function run(
  bin: string,
  args: string[],
  opts: Opts = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    // execFile never touches a shell, so quoting/quoting bugs are impossible.
    execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...(opts.env ?? process.env), ...(opts.cwd ? { PWD: opts.cwd } : {}) },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        // execFile reports non-zero exits via err; we still want code/stdout/stderr.
        const code = err && typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : err && (err as { signal?: string }).signal
            ? -1
            : err
              ? -1
              : 0;
        if (err && code === 0) {
          // Non-number failure (spawn error, timeout kill). Coerce.
          resolveP({ code: -1, stdout: String(stdout), stderr: String(stderr || err.message) });
          return;
        }
        resolveP({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

export async function git(cfg: AppConfig, args: string[], opts: Opts = {}) {
  return run(cfg.git.bin, args, opts);
}

async function gitOut(cfg: AppConfig, args: string[], opts: Opts = {}): Promise<string> {
  const r = await git(cfg, args, opts);
  if (r.code !== 0) {
    throw new McpToolError(`git ${args[0]} failed (exit ${r.code}): ${truncate((r.stderr || r.stdout).trim(), 600)}`);
  }
  return r.stdout;
}

export function resolveWorkspace(cfg: AppConfig, id: string): Workspace {
  const ws = cfg.workspaces.find((w) => w.id === id);
  if (!ws) {
    const ids = cfg.workspaces.map((w) => w.id).join(", ") || "(none configured)";
    throw new McpToolError(`Unknown workspace '${id}'. Configured: ${ids}`);
  }
  return ws;
}

/** Workspace root as a resolved, canonical path (no symlinks escaping). */
export function workspaceRoot(cfg: AppConfig, ws: Workspace): string {
  try {
    const st = statSync(ws.path);
    if (!st.isDirectory()) throw new McpToolError(`Workspace path is not a directory: ${ws.path}`);
    return realpathSync(ws.path);
  } catch (e) {
    if (e instanceof McpToolError) throw e;
    throw new McpToolError(`Workspace path not accessible: ${ws.path} (${(e as Error).message})`);
  }
}

function assertInsideWorkspace(root: string, candidate: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    resolved = candidate; // file may not exist yet; jail check still applies on prefix
  }
  if (resolved !== root && !resolved.startsWith(root + "/")) {
    throw new McpToolError(`Path escapes workspace jail: ${candidate}`);
  }
  return resolved;
}

export async function currentBranch(cfg: AppConfig, root: string): Promise<string> {
  const out = await gitOut(cfg, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
  return out.trim();
}

async function isDirty(cfg: AppConfig, root: string): Promise<boolean> {
  const out = await gitOut(cfg, ["status", "--porcelain"], { cwd: root });
  return out.trim().length > 0;
}

const PROTECTED = new Set(["main", "master"]);

/**
 * Safe pull + branch create before a job runs.
 * Refuses: dirty trees, protected-checkout edge cases, failed ff pulls.
 * Returns the created branch name.
 */
export async function prepareJobWorkspace(
  cfg: AppConfig,
  ws: Workspace,
  taskTitle: string
): Promise<{ root: string; branch: string; baseCommit: string }> {
  const root = workspaceRoot(cfg, ws);
  const remote = ws.remote ?? "origin";
  const gitOpts = { cwd: root };

  const out = await gitOut(cfg, ["rev-parse", "--is-inside-work-tree"], gitOpts);
  if (out.trim() !== "true") throw new McpToolError(`${ws.path} is not a git work tree`);

  if (await isDirty(cfg, root)) {
    throw new McpToolError(
      `Workspace '${ws.id}' has uncommitted changes. Commit or clean (manually) before submitting a job.`
    );
  }

  const base = await gitOut(cfg, ["rev-parse", "--verify", `refs/remotes/${remote}/${ws.defaultBranch}`], gitOpts)
    .catch(async () => gitOut(cfg, ["rev-parse", "--verify", `refs/heads/${ws.defaultBranch}`], gitOpts));

  // ff-only pull of the default branch; never a hard reset.
  const cur = await currentBranch(cfg, root);
  if (cur !== ws.defaultBranch) {
    await gitOut(cfg, ["switch", "--no-guess", ws.defaultBranch], gitOpts);
  }
  const pull = await git(cfg, ["pull", "--ff-only", remote, ws.defaultBranch], gitOpts);
  if (pull.code !== 0) {
    throw new McpToolError(
      `Safe pull failed on '${ws.id}' (branch ${ws.defaultBranch}). Update this checkout manually. ${truncate(pull.stderr.trim(), 400)}`
    );
  }

  const branch = `grok/${todaySlug()}-${slugify(taskTitle)}`;
  const branches = await gitOut(cfg, ["for-each-ref", "refs/heads/", "--format=%(refname:short)"], gitOpts);
  let name = branch;
  let n = 2;
  while (branches.split("\n").includes(name)) {
    name = `${branch}-${n++}`;
  }
  await gitOut(cfg, ["switch", "--no-guess", "-c", name], gitOpts);

  const baseCommit = (await gitOut(cfg, ["rev-parse", "HEAD"], gitOpts)).trim();
  return { root, branch: name, baseCommit };
}

export interface DiffReport {
  branch: string;
  status: string;
  diff: string;
  commits: string[];
}

export async function getDiff(cfg: AppConfig, ws: Workspace): Promise<DiffReport> {
  const root = workspaceRoot(cfg, ws);
  const gitOpts = { cwd: root };
  const branch = await currentBranch(cfg, root);
  const status = await gitOut(cfg, ["status", "--porcelain=v1"], gitOpts);
  const d = await git(cfg, ["diff", "-M", "HEAD"], gitOpts);
  const diff = d.stdout || d.stderr;
  const commits = (await gitOut(cfg, ["log", "--oneline", "-5"], gitOpts)).trim().split("\n");
  return { branch, status, diff: truncate(diff, 400_000), commits };
}

/** Path-jail file read. */
export function readFileInWorkspace(
  cfg: AppConfig,
  ws: Workspace,
  relPath: string
): { path: string; content: string; bytes: number } {
  const root = workspaceRoot(cfg, ws);
  if (relPath.includes("\0")) throw new McpToolError("Invalid path");
  const rel = relPath.replace(/^\/+/, "");
  const full = assertInsideWorkspace(root, join(root, rel));
  // Block the .git directory entirely.
  const relCheck = posix.relative(root, full);
  if (relCheck === ".git" || relCheck.startsWith(".git/")) {
    throw new McpToolError("Reading .git internals is not allowed");
  }
  let content: string;
  try {
    const st = statSync(full);
    if (st.size > 512 * 1024) throw new McpToolError(`File too large to read (${st.size} bytes): ${rel}`);
    content = readFileSync(full, "utf8");
  } catch (e) {
    if (e instanceof McpToolError) throw e;
    throw new McpToolError(`Cannot read '${rel}': ${(e as Error).message}`);
  }
  return { path: full, content, bytes: Buffer.byteLength(content) };
}

export async function assertJobBranch(cfg: AppConfig, ws: Workspace, jobBranch: string): Promise<void> {
  const root = workspaceRoot(cfg, ws);
  const cur = await currentBranch(cfg, root);
  if (cur !== jobBranch) {
    throw new McpToolError(
      `Workspace '${ws.id}' is now on '${cur}' but job ran on '${jobBranch}'. Finish modes only apply to the job branch.`
    );
  }
  if (PROTECTED.has(cur.toLowerCase())) {
    throw new McpToolError(`Refusing finish mode directly on protected branch '${cur}'.`);
  }
}

async function stageAllAndCommit(cfg: AppConfig, root: string, message: string): Promise<boolean> {
  await gitOut(cfg, ["add", "-A"], { cwd: root });
  const staged = await gitOut(cfg, ["diff", "--cached", "--name-only"], { cwd: root });
  if (!staged.trim()) return false;
  // Use the repo's own identity when present; otherwise the configured fallback.
  const identity = await git(cfg, ["config", "user.name"], { cwd: root });
  const identArgs =
    identity.code !== 0 || !identity.stdout.trim()
      ? ["-c", `user.name=${cfg.git.name}`, "-c", `user.email=${cfg.git.email}`]
      : [];
  await gitOut(cfg, [...identArgs, "-c", "commit.gpgsign=false", "commit", "-m", message], { cwd: root });
  return true;
}

export interface FinishOptions {
  mode: "commit_local" | "push_branch" | "open_pr";
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
}

export async function finishJob(
  cfg: AppConfig,
  ws: Workspace,
  jobBranch: string,
  opts: FinishOptions
): Promise<string> {
  const root = workspaceRoot(cfg, ws);
  await assertJobBranch(cfg, ws, jobBranch);

  if (opts.mode === "commit_local") {
    if (!opts.commitMessage || !opts.commitMessage.trim()) {
      throw new McpToolError("commit_local requires commitMessage");
    }
    const committed = await stageAllAndCommit(cfg, root, opts.commitMessage.trim());
    return committed
      ? "Committed locally on branch " + jobBranch
      : "Nothing to commit — workspace was already clean.";
  }

  // push_branch / open_pr: commit outstanding changes if a message was provided,
  // then push with plain (never-force) push.
  if (!opts.commitMessage || !opts.commitMessage.trim()) {
    const dirty = await isDirty(cfg, root);
    if (dirty) {
      throw new McpToolError(
        "Uncommitted changes and no commitMessage. Pass commitMessage so the changes can be committed before push."
      );
    }
  } else {
    await stageAllAndCommit(cfg, root, opts.commitMessage.trim());
  }

  const remote = ws.remote ?? "origin";
  const push = await git(cfg, ["push", "-u", remote, `${jobBranch}:${jobBranch}`], { cwd: root, timeoutMs: 300_000 });
  if (push.code !== 0) {
    throw new McpToolError(
      `Push failed for '${jobBranch}' (exit ${push.code}). ${truncate(push.stderr.trim() || push.stdout.trim(), 800)}`
    );
  }
  const result: string[] = ["Pushed branch " + jobBranch];
  if (opts.mode === "open_pr") {
    const base = ws.defaultBranch;
    // gh resolves auth + repo from the remote; token never leaves the VPS.
    const args = [cfg.gh.bin];
    const ghBin = cfg.gh.bin;
    const prArgs = [
      "pr",
      "create",
      "--base",
      base,
      "--head",
      jobBranch,
      "--title",
      opts.prTitle?.trim() || opts.commitMessage?.trim() || jobBranch,
      ...(opts.prBody?.trim() ? ["--body", opts.prBody.trim()] : []),
      ...(cfg.gh.repo ? ["--repo", cfg.gh.repo] : []),
    ];
    const pr = await run(ghBin, prArgs, { cwd: root, timeoutMs: 300_000 });
    if (pr.code !== 0) {
      throw new McpToolError(
        `gh pr create failed (exit ${pr.code}). Branch still pushed locally/remotely. ${truncate(pr.stderr.trim() || pr.stdout.trim(), 800)}`
      );
    }
    result.push("PR: " + pr.stdout.trim());
  }
  return result.join("\n");
}

export async function cancelGuard(cfg: AppConfig, root: string): Promise<void> {
  if (!(await isDirty(cfg, root))) return;
  // Cancel never touches the working tree; dirty state is simply reported.
}
