import type { McpToolError } from "../util.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const toolDefs: ToolDef[] = [
  {
    name: "list_workspaces",
    description:
      "List configured repo checkouts the MCP may operate on (id, path, default branch). Call this first to pick a workspace for submit_job.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "submit_job",
    description:
      "Start ONE coding job (async). Performs a safe pull on the workspace default branch, creates feature branch 'grok/<date>-<slug>', and spawns the coding agent with the prompt/plan. Returns job_id immediately. Refuses if another job is active. Never submits without workspace confirmation when unsure which repo.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace id from list_workspaces" },
        title: { type: "string", description: "Short task title (2-8 words, becomes part of the branch name)" },
        prompt: { type: "string", description: "Full task description for the agent" },
        plan: { type: "string", description: "Optional reviewed plan the agent should follow" },
        finishHint: {
          type: "string",
          enum: ["commit_local", "push_branch", "open_pr", "decide_later"],
          description: "Optional hint of intended finish mode; informational only",
        },
      },
      required: ["workspaceId", "title", "prompt"],
    },
  },
  {
    name: "get_job",
    description:
      "Get job status: one of queued | preparing | running | done | failed | needs_decision | cancelled, with summary/error, branch, timestamps.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
  },
  {
    name: "get_job_logs",
    description: "Tail the agent/runner log for a job (default last 200 lines).",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        tail: { type: "number", description: "Number of trailing lines (default 200)" },
      },
      required: ["jobId"],
    },
  },
  {
    name: "cancel_job",
    description: "Cancel a job. Queued jobs are cancelled outright; running jobs get SIGTERM to the agent.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
  },
  {
    name: "get_diff",
    description:
      "Verified git status + diff for the workspace of a job. Safe to call for running or finished jobs.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a single file under a workspace checkout (path jail enforced; .git blocked; 512KB max).",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        path: { type: "string", description: "Path relative to the workspace root" },
      },
      required: ["workspaceId", "path"],
    },
  },
  {
    name: "finish_job",
    description:
      "Apply a finish mode to a DONE/needs_decision job: commit_local | push_branch | open_pr. push_branch/open_pr require that changes fit in the job branch; refuses protected branches (main/master) and never force-pushes. Provide commitMessage when committing; prTitle/prBody for PRs.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        mode: { type: "string", enum: ["commit_local", "push_branch", "open_pr"] },
        commitMessage: { type: "string", description: "Commit message (required for commit_local)" },
        prTitle: { type: "string" },
        prBody: { type: "string" },
      },
      required: ["jobId", "mode"],
    },
  },
];
