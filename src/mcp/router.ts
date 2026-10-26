import type { AppConfig } from "../config.js";
import { cancelGuard, finishJob, getDiff, readFileInWorkspace, resolveWorkspace, workspaceRoot } from "../git.js";
import type { JobQueue } from "../jobs/queue.js";

export class ToolError extends Error {}

export class ToolRouter {
  constructor(
    private cfgProvider: () => AppConfig,
    private queue: JobQueue
  ) {}

  async call(name: string, rawArgs: unknown): Promise<{ text: string; isError?: boolean }> {
    try {
      const result = await this.dispatch(name, (rawArgs ?? {}) as Record<string, unknown>);
      return { text: JSON.stringify(result, null, 2) };
    } catch (e) {
      const err = e as Error;
      // Uniform message: strip wrapper names for a clean McpToolError/ToolError message.
      const msg =
        e instanceof ToolError || err.name === "McpToolError" ? err.message : `${err.name}: ${err.message}`;
      return { text: `Error: ${msg}`, isError: true };
    }
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    const cfg = this.cfgProvider();
    switch (name) {
      case "list_workspaces": {
        const workspaces = cfg.workspaces.map((w) => {
          let accessible = false;
          try {
            workspaceRoot(cfg, w);
            accessible = true;
          } catch { /* unavailable */ }
          return {
            id: w.id,
            path: w.path,
            defaultBranch: w.defaultBranch,
            description: w.description,
            accessible,
          };
        });
        const active = this.queue.active;
        return {
          workspaces,
          activeJob: active
            ? { id: active.id, status: active.status, workspaceId: active.workspaceId, branch: active.branch }
            : null,
        };
      }
      case "submit_job": {
        const job = this.queue.submit({
          workspaceId: str(args, "workspaceId"),
          title: str(args, "title"),
          prompt: str(args, "prompt"),
          plan: optStr(args, "plan"),
          finishHint: optStr(args, "finishHint"),
        });
        return {
          jobId: job.id,
          status: job.status,
          workspaceId: job.workspaceId,
          finishHint: job.finishHint,
          message:
            "Job submitted; it runs in the background. Poll get_job. Per protocol, only ping the user on done / failed / needs_decision.",
        };
      }
      case "get_job": {
        const job = this.requireJob(str(args, "jobId"));
        return {
          jobId: job.id,
          workspaceId: job.workspaceId,
          status: job.status,
          title: job.title,
          branch: job.branch,
          baseCommit: job.baseCommit,
          finishHint: job.finishHint,
          summary: job.summary,
          error: job.error,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
        };
      }
      case "get_job_logs": {
        const jobId = str(args, "jobId");
        this.requireJob(jobId);
        return { jobId, log: await this.queue.logs(jobId, numOr(args.tail, 200)) };
      }
      case "cancel_job": {
        const jobId = str(args, "jobId");
        this.requireJob(jobId);
        return { jobId, ...this.queue.cancel(jobId) };
      }
      case "get_diff": {
        const job = this.requireJob(str(args, "jobId"));
        if (!job.branch) {
          throw new ToolError(`Job ${job.id} has no branch yet (status ${job.status})`);
        }
        const ws = resolveWorkspace(cfg, job.workspaceId);
        const root = workspaceRoot(cfg, ws);
        cancelGuard(cfg, root);
        const diff = await getDiff(cfg, ws);
        return { jobId: job.id, expectedBranch: job.branch, ...diff };
      }
      case "read_file": {
        const ws = resolveWorkspace(cfg, str(args, "workspaceId"));
        return readFileInWorkspace(cfg, ws, str(args, "path"));
      }
      case "finish_job": {
        const job = this.requireJob(str(args, "jobId"));
        if (job.status !== "done" && job.status !== "needs_decision") {
          throw new ToolError(`finish_job only applies after a job reaches done/needs_decision (current: ${job.status})`);
        }
        if (!job.branch) throw new ToolError(`Job ${job.id} has no branch to finish`);
        const ws = resolveWorkspace(cfg, job.workspaceId);
        const modeStr = str(args, "mode");
        if (modeStr !== "commit_local" && modeStr !== "push_branch" && modeStr !== "open_pr") {
          throw new ToolError(`Invalid mode '${modeStr}'`);
        }
        const result = await finishJob(cfg, ws, job.branch, {
          mode: modeStr,
          commitMessage: optStr(args, "commitMessage"),
          prTitle: optStr(args, "prTitle"),
          prBody: optStr(args, "prBody"),
        });
        return { jobId: job.id, mode: modeStr, branch: job.branch, result };
      }
      default:
        throw new ToolError(`Unknown tool '${name}'`);
    }
  }

  private requireJob(jobId: string) {
    const job = this.queue.get(jobId);
    if (!job) throw new ToolError(`Unknown job '${jobId}'`);
    return job;
  }
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`Missing required argument '${key}'`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

function numOr(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
