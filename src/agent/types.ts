export interface JobRuntime {
  jobId: string;
  cwd: string;
  /** Fully composed prompt (task + plan + conventions). The runner builds it. */
  prompt: string;
}

export interface AgentHandle {
  jobId: string;
  pid: number | undefined;
  exitCode: number | null;
  killed: boolean;
  /** Full captured stdout+stderr. */
  output: string;
}

/**
 * Minimal provider adapter (plan contract: `start`, `cancel`, `isRunning`).
 * A future agent plugs in behind these without any MCP-tool changes.
 */
export interface CodingAgent {
  /** Spawn and attach; resolves immediately after spawn (or throws on spawn failure). */
  start(job: JobRuntime, log: (chunk: string) => void): Promise<void>;
  /** Resolves when the run exits, with captured output. */
  completion(jobId: string): Promise<AgentHandle>;
  cancel(jobId: string): void;
  isRunning(jobId: string): boolean;
}
