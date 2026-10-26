#!/usr/bin/env node
/**
 * Black-box test suite: drives the MCP server over HTTP like a real remote client.
 * Uses fake opencode shims for speed and repeatability.
 * Run: npm run build && node scripts/test-mcp.mjs
 */
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 18791;
const TOKEN = randomUUID();
const WS_PATH = "/workspace/dev/scratch-repo";
const FAKE_OK = join(ROOT, "scripts/fake-opencode.sh");
const FAKE_BLOCKED = join(ROOT, "scripts/fake-opencode-blocked.sh");

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
function resetWorkspace() {
  execSync(
    `cd ${q(WS_PATH)} && git checkout -q main && git reset -q --hard origin/main && git clean -qfd && git branch --list 'grok/*' | xargs -r git branch -q -D`,
    { cwd: ROOT }
  );
}
// Ensure a commit identity exists for the tests.
execSync(`git config --global user.name "VPS Coding MCP Tests" && git config --global user.email tests@vps.local`, { cwd: ROOT });
resetWorkspace();
mkdirSync(join(ROOT, "jobs"), { recursive: true });

function writeConfig(opencodeBin) {
  writeFileSync(
    join(ROOT, "config.json"),
    JSON.stringify(
      {
        mcpBearerToken: TOKEN,
        host: "127.0.0.1",
        port: PORT,
        jobsDir: "jobs",
        workspaces: [{ id: "scratch", path: WS_PATH, defaultBranch: "main" }],
        opencode: { bin: opencodeBin, timeoutMs: 60000 },
        git: { bin: "git" },
        gh: { bin: "gh" },
      },
      null,
      2
    )
  );
}

let server;
function startServer(bin) {
  writeConfig(bin);
  server = spawn("node", [join(ROOT, "dist/index.js")], { cwd: ROOT });
  server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
}

async function waitHealthy(timeoutMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

async function restartServer(bin, { killFirst = true } = {}) {
  if (killFirst && server && server.exitCode === null) {
    server.kill();
    await new Promise((r) => setTimeout(r, 2200)); // let the listener free the port
  }
  startServer(bin);
  await waitHealthy();
}

const BASE = `http://127.0.0.1:${PORT}`;

async function rpc(method, params, { token = TOKEN } = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token ? `Bearer ${token}` : "",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID().slice(0, 8), method, params }),
  });
  return { res, json: res.status === 200 ? await res.json() : await res.json().catch(() => ({})) };
}

function unwrap(r) {
  const c = r.result?.content?.[0];
  assert.ok(c, "tool result should have content");
  let value;
  try {
    value = JSON.parse(c.text);
  } catch {
    value = c.text;
  }
  return { isError: r.result?.isError === true, value };
}

async function tool(name, toolArgs = {}) {
  const { json } = await rpc("tools/call", { name, arguments: toolArgs });
  return unwrap(json).value;
}

async function toolRes(name, toolArgs = {}) {
  const { json } = await rpc("tools/call", { name, arguments: toolArgs });
  return unwrap(json);
}

async function expectToolError(name, toolArgs = {}) {
  const res = await toolRes(name, toolArgs);
  assert.equal(res.isError, true, `expected tool error, got: ${JSON.stringify(res.value)}`);
  return res.value;
}

async function waitForJob(id, ...statuses) {
  for (let i = 0; i < 200; i++) {
    const j = await tool("get_job", { jobId: id });
    if (statuses.includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${id} -> ${statuses.join("|")}`);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

startServer(FAKE_OK);
await new Promise((r) => setTimeout(r, 800));

test("health endpoint", async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
});

test("missing auth -> 401", async () => {
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("wrong token -> 401", async () => {
  const { res } = await rpc("initialize", {}, { token: "bogus-token" });
  assert.equal(res.status, 401);
});

test("initialize handshake", async () => {
  const { json } = await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test" } });
  assert.equal(json.result.protocolVersion, "2025-06-18");
  assert.equal(json.result.serverInfo.name, "vps-coding-mcp");
});

test("tools/list has exactly the 8 v1 tools", async () => {
  const { json } = await rpc("tools/list");
  const names = json.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "cancel_job", "finish_job", "get_diff", "get_job", "get_job_logs",
    "list_workspaces", "read_file", "submit_job",
  ]);
});

test("notification (no id) accepted with 202", async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(res.status, 202);
});

test("list_workspaces shows scratch", async () => {
  const w = await tool("list_workspaces");
  const s = w.workspaces.find((x) => x.id === "scratch");
  assert.ok(s && s.accessible, JSON.stringify(w));
  assert.equal(w.activeJob, null);
});

test("unknown workspace rejected", async () => {
  const r = await tool("submit_job", { workspaceId: "nope", title: "x", prompt: "y" });
  assert.ok(/Unknown workspace/i.test(r), JSON.stringify(r));
});

let jobId;
test("submit_job returns jobId immediately (queued)", async () => {
  const r = await tool("submit_job", {
    workspaceId: "scratch",
    title: "Add reverse words utility",
    prompt: "Implement a reverseWords helper following the repo TODO.",
    finishHint: "commit_local",
  });
  assert.ok(/^job_/.test(r.jobId), JSON.stringify(r));
  jobId = r.jobId;
});

test("concurrent submit refused one-at-a-time", async () => {
  const r = await tool("submit_job", { workspaceId: "scratch", title: "Second task", prompt: "p" });
  assert.ok(/is active/i.test(r), JSON.stringify(r));
});

test("job reaches done with summary", async () => {
  const j = await waitForJob(jobId, "done");
  assert.equal(j.status, "done");
  assert.match(j.summary, /reverseWords/);
  assert.match(j.branch, /^grok\/\d{4}-\d{2}-\d{2}-add-reverse-words/);
});

test("get_job_logs shows agent output", async () => {
  const r = await tool("get_job_logs", { jobId, tail: 5 });
  assert.match(r.log, /fake opencode completed/);
});

test("get_diff shows the change", async () => {
  const d = await tool("get_diff", { jobId });
  assert.match(d.diff, /reverseWords/);
  assert.equal(d.branch, (await tool("get_job", { jobId })).branch);
});

test("read_file in jail works", async () => {
  const f = await tool("read_file", { workspaceId: "scratch", path: "src/index.ts" });
  assert.match(f.content, /reverseWords/);
});

test("read_file refuses jail escape", async () => {
  const r = await expectToolError("read_file", { workspaceId: "scratch", path: "../../../../etc/shadow" });
  assert.match(r, /escapes/i);
});

test("read_file blocks .git internals", async () => {
  const r = await expectToolError("read_file", { workspaceId: "scratch", path: ".git/config" });
  assert.match(r, /\.git/i);
});

test("finish_job commit_local persists the change", async () => {
  const r = await tool("finish_job", { jobId, mode: "commit_local", commitMessage: "feat: add reverseWords" });
  assert.match(r.result, /Committed locally/);
});

test("workspace has one new commit on job branch", () => {
  const out = execSync(`cd ${q(WS_PATH)} && git log --oneline -2`, { encoding: "utf8" });
  assert.match(out, /feat: add reverseWords/);
});

test("submit on dirty workspace fails during prepare", async () => {
  writeFileSync(join(WS_PATH, "dirty.txt"), "dirty\n");
  try {
    const r = await tool("submit_job", { workspaceId: "scratch", title: "Dirty test", prompt: "p" });
    const j = await waitForJob(r.jobId, "failed");
    assert.match(j.error, /uncommitted/i, JSON.stringify(j));
  } finally {
    execSync(`rm -f ${q(join(WS_PATH, "dirty.txt"))}`);
  }
  resetWorkspace();
});

test("blocked run -> needs_decision with question surfaced", async () => {
  await restartServer(FAKE_BLOCKED);
  const r = await tool("submit_job", { workspaceId: "scratch", title: "Blocked task", prompt: "p" });
  const j = await waitForJob(r.jobId, "needs_decision");
  assert.equal(j.status, "needs_decision");
  assert.match(j.summary, /OPENAI_API_KEY/);
});

test("finish_job works from needs_decision", async () => {
  const jobs = JSON.parse(execSync(`cat ${q(join(ROOT, "jobs/jobs.json"))}`, { encoding: "utf8" }));
  const blocked = jobs.filter((j) => j.status === "needs_decision").at(-1);
  const r = await tool("finish_job", { jobId: blocked.id, mode: "commit_local", commitMessage: "wip: blocked work" });
  assert.ok(/Committed|Nothing to commit/.test(r.result), JSON.stringify(r));
  await restartServer(FAKE_OK); // fresh config + clean port for the next test
});

test("restart marks interrupted job failed", async () => {
  // submit against a shim that sleeps long, then kill the server mid-run
  const r = await tool("submit_job", { workspaceId: "scratch", title: "Long task", prompt: "p" });
  await new Promise((r2) => setTimeout(r2, 800)); // still running
  server.kill("SIGKILL");
  await new Promise((r2) => setTimeout(r2, 600));
  startServer(FAKE_OK);
  await waitHealthy();
  const j = await waitForJob(r.jobId, "failed");
  assert.match(j.error, /restart/i);
  server.kill();
});

let pass = 0;
let fail = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.error(`FAIL  ${name}: ${e.message}`);
    break;
  }
}
if (server && server.exitCode === null) server.kill();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
