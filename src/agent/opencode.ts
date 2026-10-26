import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";
import type { AgentHandle, CodingAgent, JobRuntime } from "./types.js";

export const NEEDS_DECISION_MARKER = "[NEEDS_DECISION]";

/** Prompt framing: keeps OpenCode in "edit files, no git ops" mode; plan embedded by runner. */
export function buildPrompt(opts: { title: string; prompt: string; plan?: string }): string {
  return [
    `Task: ${opts.title}`,
    "",
    opts.plan
      ? `Plan (follow it; adjust if facts on the ground differ):\n${opts.plan}`
      : "No explicit plan; use your judgement on approach.",
    "",
    `User request:\n${opts.prompt}`,
    "",
    "Rules:",
    "- You are working on a fresh feature branch; make your edits there.",
    "- Do NOT run `git commit`, `git push`, `git pull`, or any remote/force git operations.",
    "- Do NOT touch `.git` internals, tokens, or credentials.",
    "- Work only inside this repository.",
    `- When you FINISH normally, end the final message's last line with: [DONE] <one-line summary>`,
    `- If you are blocked or need a user decision mid-task, stop editing and end the final message's last line with: ${NEEDS_DECISION_MARKER} <what you need>`,
  ].join("\n");
}

interface LiveRun {
  proc: import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>;
  chunks: string[];
  killed: boolean;
}

export class OpencodeAgent implements CodingAgent {
  private runs = new Map<string, LiveRun>();
  private settling = new Map<string, { promise: Promise<AgentHandle>; resolve: (h: AgentHandle) => void }>();

  constructor(private cfg: AppConfig) {}

  async start(job: JobRuntime, log: (chunk: string) => void): Promise<void> {
    // --standalone: private opencode server per run, honoring the spawn cwd.
    // Without it a `run` attaches to a background service started elsewhere and
    // the agent edits the wrong working tree.
    const args = [
      "run",
      "--standalone",
      "--title", `grok:${job.jobId}`,
      "--auto",
      ...(this.cfg.opencode.args ?? []),
      job.prompt,
    ];
    const proc = spawn(this.cfg.opencode.bin, args, {
      cwd: job.cwd,
      // OpenCode resolves its project dir from $PWD, not the real cwd; keep them in sync
      // or the agent silently works on the wrong tree.
      env: { ...process.env, PWD: job.cwd },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const live: LiveRun = { proc, chunks: [], killed: false };
    this.runs.set(job.jobId, live);

    let settled = this.settling.get(job.jobId);
    if (!settled) {
      let resolve!: (h: AgentHandle) => void;
      const promise = new Promise<AgentHandle>((r) => { resolve = r; });
      settled = { promise, resolve };
      this.settling.set(job.jobId, settled);
    }
    const { resolve } = settled;

    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      live.chunks.push(s);
      log(s);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("error", (err) => {
      this.runs.delete(job.jobId);
      resolve({
        jobId: job.jobId,
        pid: proc.pid,
        exitCode: -1,
        killed: live.killed,
        output: live.chunks.join("") + `\n[runner] spawn/startup error: ${err.message}`,
      });
    });
    proc.on("close", (code, signal) => {
      this.runs.delete(job.jobId);
      resolve({
        jobId: job.jobId,
        pid: proc.pid,
        exitCode: code ?? (signal ? -1 : null),
        killed: live.killed,
        output: live.chunks.join(""),
      });
    });
  }

  async completion(jobId: string): Promise<AgentHandle> {
    let settled = this.settling.get(jobId);
    if (!settled) {
      let resolve!: (h: AgentHandle) => void;
      const promise = new Promise<AgentHandle>((r) => { resolve = r; });
      settled = { promise, resolve };
      this.settling.set(jobId, settled);
    }
    return settled.promise;
  }

  cancel(jobId: string): void {
    const live = this.runs.get(jobId);
    if (!live) return;
    live.killed = true;
    try {
      live.proc.kill("SIGTERM");
      setTimeout(() => {
        if (this.runs.has(jobId) && live.proc.exitCode === null) {
          try { live.proc.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }, 5000);
    } catch {
      /* process already gone */
    }
  }

  isRunning(jobId: string): boolean {
    return this.runs.has(jobId);
  }
}
