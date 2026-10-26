# VPS Coding MCP

A small, dependency-light remote MCP server that runs **OpenCode** coding jobs against already-cloned repo checkouts on your VPS — so a chat agent (e.g. Grok Bot) can orchestrate coding work while files stay on your machine. GitHub finishing moves (`push` / `open PR`) go through the `gh` CLI that lives on the VPS; **the bot never holds GitHub credentials**.

> See `vps-coding-mcp-v1-plan.md` for the full design and decisions.

## How it works

```
You --task--> Grok Bot --MCP tools (HTTPS + bearer)--> Node MCP on VPS
                                                        |
                          +-----------------------------+---------------------------+
                          v                             v                           v
                    OpenCode run                 repo checkout (disk)           gh CLI
                    (one job at a time)          branch: grok/<date>-<slug>     (push / PR)
```

- **Submit is async** — `submit_job` returns a `job_id` immediately; long runs never block an MCP call.
- **Quiet run** — the bot only pings you when a job reaches `done`, `failed`, or `needs_decision` (agent blocked and ended with the `[NEEDS_DECISION] <reason>` marker).
- **Finish modes** — after reviewing `get_diff`, you choose: `commit_local`, `push_branch`, or `open_pr`.

## Tools (v1)

| Tool | Purpose |
| --- | --- |
| `list_workspaces` | Configured checkouts (id, path, default branch) + active job |
| `submit_job` | workspace + title + prompt (+ optional plan, finish hint) → `jobId` |
| `get_job` | status, summary/error, branch, timestamps |
| `get_job_logs` | tail of agent stdout/err (default 200 lines) |
| `cancel_job` | cancels queued jobs; SIGTERMs running ones |
| `get_diff` | git status + diff for the job's workspace/branch |
| `read_file` | read a single file inside the workspace path jail (`.git` blocked, 512 KB max) |
| `finish_job` | `commit_local` \| `push_branch` \| `open_pr` (+ commitMessage, prTitle, prBody) |

### Job lifecycle

`queued → preparing (safe pull + feature branch) → running → done | failed | needs_decision | cancelled`

`submit_job` refuses when another job is active (one job at a time) and when a workspace has uncommitted changes (checked during prepare). Branch names are `grok/<YYYY-MM-DD>-<slug>`.

## Setup (VPS)

Requirements: **Node ≥ 22**, `git` identity configured (or use `git.name`/`git.email` fallbacks in config), `gh` authenticated (`gh auth login`) for push/PR modes, and `opencode` installed with your OpenCode Go plan auth already done on the machine.

```bash
npm install
npm run build

# Create config with a fresh bearer token (workspace defaults to your repo path):
node scripts/gen-config.mjs /path/to/your/repo ./config.json
# prints the token; keep it secret

node dist/index.js
```

Config shape (`config.json`; everything can also come from env — `MCP_BEARER_TOKEN`, `PORT`, `HOST`, `JOBS_DIR`):

```json
{
  "mcpBearerToken": "<random hex>",
  "host": "127.0.0.1",
  "port": 8443,
  "jobsDir": "jobs",
  "workspaces": [
    { "id": "myapp", "path": "/srv/repos/myapp", "defaultBranch": "main", "description": "main TS repo" }
  ],
  "opencode": {
    "bin": "opencode",
    "args": [],
    "timeoutMs": 3600000
  },
  "gh": { "bin": "gh" }
}
```

Notes:

- `opencode.args` is appended to `opencode run` and is the place to pin a model, e.g. `["-m", "opencode/glm-5.3-flash-free"]` (or your workspace's preferred Go-plan model).
- The runner always spawns `opencode run --standalone` so each job gets a private server that honors the workspace directory.
- Env overrides win over the config file.

### TLS

The Node server speaks plain HTTP and expects TLS termination upstream (plan decision). Example Caddyfile:

```caddy
mcp.example.com {
  reverse_proxy 127.0.0.1:8443
}
```

Then the MCP base URL for clients is `https://mcp.example.com/mcp`.

## Wiring a remote MCP client (e.g. Grok Bot)

Add a **remote MCP (URL-based)** entry — not a local `command` (a local command would run on the bot box, not your VPS):

```json
{
  "mcpServers": {
    "vps-coding-mcp": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }
    }
  }
}
```

Bot flow per task:

1. `list_workspaces` → pick the workspace
2. (bigger/risky work only) propose a plan → wait for your OK
3. `submit_job` → stay quiet, then `get_job` polling — ping only on done / failed / needs_decision
4. `get_diff` → show change highlights → ask: commit locally / push branch / open PR?
5. `finish_job` with the chosen mode + `commitMessage` (+ `prTitle`/`prBody` for PRs)

## Safety rules (enforced in code)

- Bearer token required on every `/mcp` request (constant-time compare).
- Never commit/push to `main`/`master`; jobs always run on a fresh `grok/<date>-<slug>` branch.
- No force-push; pulls are `--ff-only` only; no destructive git commands.
- Operation is jailable to configured workspace paths; `read_file` can't traverse out or read `.git`.
- GitHub credentials stay inside `gh` on the VPS.

## Tests

```bash
npm run build
node scripts/test-mcp.mjs   # 22 black-box tests over HTTP using fake agents (fast)
node scripts/e2e.mjs        # real `opencode` end-to-end against the sample workspace
```

Set `OPENCODE_MODEL=<provider/model>` to pin the model for e2e, e.g. `OPENCODE_MODEL=opencode/glm-5.3-flash-free node scripts/e2e.mjs`.

## Provider adapter

OpenCode sits behind `src/agent/types.ts` (`start` / `completion` / `cancel` / `isRunning`). A second agent later plugs in without touching the MCP tool surface.

## Out of scope (v1)

PC host / tunnels (designed, not shipped), parallel jobs / worktrees, fresh clone-per-task workspaces, MCP OAuth, streaming token-by-token progress, and the bot holding GitHub tokens.
