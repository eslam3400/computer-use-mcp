# VPS Coding MCP — v1 Plan

Grok Bot plans; a small custom Node MCP on your VPS runs OpenCode against your cloned repos, with `gh` for GitHub and bearer-token auth. Built so a PC host can plug in later.

---

## Goal

**Why this exists:** Stop burning Cursor cloud-agent credits and waiting on slow remote agents. Keep files where you can see them. Grok Bot orchestrates; your VPS executes.

Grok Bot connects to a remote HTTPS MCP on your VPS. You send a coding task in chat. Grok Bot plans (and asks for plan OK only on bigger/risky work), submits a job, stays quiet until done/failed/needs a decision, then asks which finish mode to use (commit locally, push branch, or open PR).

---

## Decisions locked

| Decision | Choice |
| --- | --- |
| Host (v1) | VPS first; PC later |
| Coding agent | OpenCode now; provider adapter for others later |
| LLM | OpenCode Go plan (auth on the VPS) |
| Build approach | Small custom Node MCP from scratch |
| Repos | Already-cloned checkouts you keep updated |
| Concurrency | One job at a time |
| Auth to MCP | Bearer token in HTTP headers |
| GitHub | `gh` CLI on the VPS — Grok Bot never holds GitHub creds |
| Stack | TypeScript / Node (MCP + first repos) |
| Plan gate | Approve plan only for bigger / risky tasks |
| Finish mode | Ask each time (local commit / push branch / open PR) |
| Progress UX | Only notify on done, failed, or needs a decision |
| needs_decision detection | Marker convention: agent ends blocked runs with `[NEEDS_DECISION] <reason>` in final output; runner detects it |
| Default model/agent | `opencode run` with defaults from Go plan auth (no `--model`/`--agent` flags in v1) |
| Branch naming | Auto: `grok/<YYYY-MM-DD>-<slug>` created from workspace default branch |
| Finish staging | `finish_job` stages the whole workspace (`git add -A`) |
| Finish metadata | `finish_job` accepts `commitMessage`, optional `prTitle`/`prBody`; push/PR auto-commit staged changes when a message is given |

---

## Architecture

```
You  --task-->  Grok Bot  --MCP tools-->  Node MCP (HTTPS)
                                              |
                    +-------------------------+-------------------------+
                    |                         |                         |
                    v                         v                         v
               OpenCode                 Repo checkout                 gh CLI
            (Go plan session)           (on VPS disk)              (push / PR)
                    |                         ^                         |
                    +-------- edit -----------+                         |
                    +---------------- status / diff / read -------------+
                    +---------------- finish mode ----------------------+
```

**Critical Grok Bot constraint:** a custom MCP added as a local `command` runs on the bot box, not your machine. Your server must be a remote HTTPS MCP URL that Grok Bot connects to with the bearer token.

---

## MCP tools (v1)

| Tool | Purpose |
| --- | --- |
| `list_workspaces` | List configured repo checkouts (id, path, default branch) |
| `submit_job` | Start one coding job: workspace + prompt + optional plan + finish hint |
| `get_job` | Status, summary, error, timestamps |
| `get_job_logs` | Tail of OpenCode / runner logs (on demand) |
| `cancel_job` | Stop the active job |
| `get_diff` | Verified git status + diff for the job workspace |
| `read_file` | Read a file under an allowlisted checkout path |
| `finish_job` | Apply finish mode: `commit_local` \| `push_branch` \| `open_pr` — with `commitMessage`, optional `prTitle`/`prBody` |

Jobs are async. `submit_job` returns a `job_id` immediately. Long OpenCode runs never block a single MCP call for tens of minutes.

---

## Job lifecycle

1. **You send a task** — Grok Bot picks the workspace and drafts a short plan.
2. **Plan gate (conditional)** — Only for bigger/risky work: show plan, wait for OK. Small tasks skip this.
3. **`submit_job`** — MCP refuses if another job is running. Pulls latest on the checkout (safe pull, refuses on dirty tree), creates a feature branch `grok/<date>-<slug>`, spawns OpenCode against the plan/prompt with the `[NEEDS_DECISION]` convention appended.
4. **Quiet run** — Grok Bot does not spam progress. You can ask status anytime via `get_job` / `get_job_logs`.
5. **Terminal event** — Done, failed, or needs a decision (clarification / blocked). Grok Bot pings you with summary + diff highlights.
6. **Finish mode** — You choose: commit locally only, push branch, or open PR via `gh`. Then job closes.

---

## Safety rules

- Never commit or push directly to `main` or `master`.
- Never force-push.
- Never run destructive git (`reset --hard`, `clean -fd`) without an explicit ask.
- Only operate inside configured workspace paths (path allowlist in config).
- Bearer token required on every MCP request; no anonymous access.
- GitHub credentials stay on the VPS inside `gh`; never returned through MCP tools.

---

## Config shape

A single config file on the VPS (e.g. `config.json` or env + JSON) registers workspaces and secrets. Suggested fields:

| Field | Meaning |
| --- | --- |
| `MCP_BEARER_TOKEN` | Shared secret for Grok Bot headers |
| `PORT` / `HOST` | HTTPS terminated at Caddy/nginx or Cloudflare |
| `workspaces[]` | `{ id, path, defaultBranch, remote? }` — already cloned |
| `opencode` | Binary/path + any flags; uses Go plan auth already on machine |
| `jobsDir` | Where job state + logs are stored |

Host-agnostic design: the same Node process runs on a PC later; only URL, TLS, and workspace paths change.

---

## Build plan (few days)

- [x] **Day 1 — Skeleton** — HTTPS MCP server, bearer auth, `list_workspaces`, health
- [x] **Day 1 — Job queue** — One-at-a-time store: submit / get / cancel + persisted status
- [x] **Day 2 — OpenCode runner** — Spawn session, feed prompt/plan, capture logs, mark done/failed
- [x] **Day 2 — Git helpers** — Safe branch create, status/diff, `read_file` with path jail
- [x] **Day 3 — Finish modes** — `commit_local` / `push_branch` / `open_pr` via `gh` + safety checks
- [x] **Day 3 — Wire Grok Bot** — Add remote MCP URL + bearer header; run one real TypeScript task end-to-end
- [x] **Buffer — Polish** — Clearer errors, log tails, `needs_decision` state, README

**Provider adapter:** Keep OpenCode behind a tiny interface (`start`, `cancel`, `isRunning`) so a second agent can plug in later without rewriting the MCP tools.

---

## Out of scope for v1

- PC host / tunnels (design for it; do not ship it).
- Parallel jobs or git worktrees.
- Fresh clone-per-task workspaces.
- OAuth for the MCP (bearer is enough).
- Streaming token-by-token progress to chat.
- Grok Bot holding GitHub tokens.

---

## Existing projects we considered

Useful references, not drop-ins for Grok Bot (most are local stdio; we need remote HTTPS):

- [opencode-mcp-bridge](https://github.com/teodorgross/opencode-mcp-bridge)
- [opencode-agent-mcp](https://github.com/define9/opencode-agent-mcp)
- [localagent-box](https://github.com/dkarzon/localagent-box)
- [multicode](https://github.com/joshiojas/multicode)

Closest remote shape is localagent-box (HTTP + OpenCode + git). Closest MCP job shape is multicode / opencode-mcp-bridge. We still build custom so the tool surface and safety rules match exactly what you want.

---

## Success criteria

v1 is done when: from Grok Bot chat, you can point at a configured TypeScript repo on the VPS, get a coding change via OpenCode without a Cursor cloud agent, see a diff, and choose commit / push / PR — with GitHub auth never leaving the VPS.

**Status:** v1 implemented and tested on the dev box (22 black-box MCP/HTTP tests + real OpenCode e2e, job lifecycle, dirty-tree and jail guards, restart recovery). Remaining: deploy on the actual VPS (config paths + TLS domain), wire the Grok Bot remote MCP entry, and verify push/PR against a real GitHub remote.
