import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpToolError } from "./util.js";

export interface Workspace {
  id: string;
  path: string;
  defaultBranch: string;
  /** Optional explicit remote name; defaults to "origin". */
  remote?: string;
  /** Optional human note (shown by list_workspaces). */
  description?: string;
}

export interface AppConfig {
  mcpBearerToken: string;
  host: string;
  port: number;
  jobsDir: string;
  workspaces: Array<ApiWorkspace>;
  opencode: {
    bin: string;
    /** Extra args appended to `opencode run`. */
    args?: string[];
    /** Timeout for a single job run in ms (0 = unlimited). */
    timeoutMs?: number;
  };
  git: {
    /** Git binary. */
    bin: string;
    /** Fallback commit identity for repos without one (used only when repo config is unset). */
    name?: string;
    email?: string;
  };
  gh: {
    bin: string;
    /** Optional repo slug override (owner/name); normally derived from remote via gh. */
    repo?: string;
  };
}

type ApiWorkspace = Workspace;

// Raw file shape: workspaces may carry "defaultBranch" or "default_branch".
type RawConfig = {
  mcpBearerToken?: string;
  MCP_BEARER_TOKEN?: string;
  host?: string;
  port?: number;
  jobsDir?: string;
  workspaces?: Array<Record<string, unknown>>;
  opencode?: Partial<AppConfig["opencode"]>;
  git?: Partial<AppConfig["git"]>;
  gh?: Partial<AppConfig["gh"]>;
};

let cached: AppConfig | undefined;

export function loadConfig(explicitPath?: string): AppConfig {
  if (cached && !explicitPath) return cached;
  const file = explicitPath ?? process.env.CONFIG_FILE ?? "config.json";
  let raw: RawConfig = {};
  try {
    raw = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8")) as RawConfig;
  } catch {
    if (explicitPath || process.env.CONFIG_FILE) {
      throw new McpToolError(`Config file not found or invalid: ${file}`);
    }
    // Fall through to env-only config.
  }

  const token = process.env.MCP_BEARER_TOKEN ?? raw.mcpBearerToken ?? raw.MCP_BEARER_TOKEN;
  if (!token) {
    throw new McpToolError(
      "No bearer token: set MCP_BEARER_TOKEN env or mcpBearerToken in config.json"
    );
  }

  const workspaces: Workspace[] = (raw.workspaces ?? []).map((w) => ({
    id: String(w.id),
    path: resolve(String(w.path)),
    defaultBranch: String(w.defaultBranch ?? w.default_branch ?? "main"),
    remote: w.remote ? String(w.remote) : "origin",
    description: w.description ? String(w.description) : undefined,
  }));
  const seen = new Set<string>();
  for (const w of workspaces) {
    if (!w.id || !w.path) throw new McpToolError("Workspace entries need id and path");
    if (seen.has(w.id)) throw new McpToolError(`Duplicate workspace id: ${w.id}`);
    seen.add(w.id);
  }

  const cfg: AppConfig = {
    mcpBearerToken: token,
    host: process.env.HOST ?? raw.host ?? "127.0.0.1",
    port: numEnv(process.env.PORT) ?? raw.port ?? 8443,
    jobsDir: process.env.JOBS_DIR ?? raw.jobsDir ?? "jobs",
    workspaces,
    opencode: {
      bin: process.env.OPENCODE_BIN ?? raw.opencode?.bin ?? "opencode",
      args: raw.opencode?.args ?? [],
      timeoutMs: raw.opencode?.timeoutMs ?? 60 * 60 * 1000,
    },
    git: {
      bin: process.env.GIT_BIN ?? raw.git?.bin ?? "git",
      name: raw.git?.name ?? "VPS Coding MCP",
      email: raw.git?.email ?? "mcp-bot@vps.local",
    },
    gh: { bin: process.env.GH_BIN ?? raw.gh?.bin ?? "gh", repo: raw.gh?.repo },
  };
  cached = cfg;
  return cfg;
}

export function resetConfigCache(): void {
  cached = undefined;
}

function numEnv(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
