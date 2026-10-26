#!/usr/bin/env node
/**
 * Real end-to-end smoke: real `opencode` runs one tiny task end to end.
 * Usage: node scripts/e2e.mjs [workspacePath]
 * Assumes a git identity + repo checkouts are set up.finish = commit_local.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const WS_PATH = process.argv[2] ?? "/workspace/dev/scratch-repo";
const PORT = 18792;
const TOKEN = randomUUID();
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// reset workspace to a clean main
execSync(
  `cd ${q(WS_PATH)} && git checkout -q main && git reset -q --hard origin/main && git clean -qfd && git branch --list 'grok/*' | xargs -r git branch -q -D`
);

const jobsDir = "jobs-e2e";
mkdirSync(join(ROOT, jobsDir), { recursive: true });
writeFileSync(
  join(ROOT, "config.e2e.json"),
  JSON.stringify(
    {
      mcpBearerToken: TOKEN,
      host: "127.0.0.1",
      port: PORT,
      jobsDir,
      workspaces: [{ id: "e2e", path: WS_PATH, defaultBranch: "main" }],
      opencode: {
        bin: process.env.OPENCODE_BIN ?? "opencode",
        timeoutMs: 15 * 60 * 1000,
        ...(process.env.OPENCODE_MODEL ? { args: ["-m", process.env.OPENCODE_MODEL] } : {}),
      },
      git: { bin: "git" },
      gh: { bin: "gh" },
    },
    null,
    2
  )
);

const server = spawn("node", [join(ROOT, "dist/index.js")], {
  cwd: ROOT,
  env: { ...process.env, CONFIG_FILE: join(ROOT, "config.e2e.json") },
});
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
await new Promise((r) => setTimeout(r, 1200));

const BASE = `http://127.0.0.1:${PORT}`;
async function tool(name, args = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID().slice(0, 6), method: "tools/call", params: { name, arguments: args } }),
  });
  const json = await res.json();
  const c = json.result?.content?.[0];
  if (!c) throw new Error(JSON.stringify(json));
  try {
    return { parsed: JSON.parse(c.text), isError: json.result.isError === true, text: c.text };
  } catch {
    return { parsed: c.text, isError: json.result.isError === true, text: c.text };
  }
}

console.log("Submitting real OpenCode task...");
const sub = await tool("submit_job", {
  workspaceId: "e2e",
  title: "Add kebab case helper",
  prompt:
    "In src/index.ts, implement a small `kebabCase(s)` helper that converts camelCase and space-separated words to kebab-case. Add a couple of example usages as comments. Keep it under 15 lines total.",
});

console.log("submit ->", JSON.stringify(sub.parsed));
const jobId = sub.parsed.jobId;

let final;
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  const j = await tool("get_job", { jobId });
  final = j.parsed;
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  if (["done", "failed", "needs_decision", "cancelled"].includes(final.status)) {
    console.log(`job ${final.status} after ${mins} min`);
    console.log(JSON.stringify(final, null, 2).slice(0, 1500));
    break;
  }
  console.log(`... still ${final.status} (${mins} min)`);
}

const diff = await tool("get_diff", { jobId });
console.log("--- diff status ---");
console.log(diff.parsed.status);
console.log(diff.text.slice(0, 2000));

const fin = await tool("finish_job", {
  jobId,
  mode: "commit_local",
  commitMessage: "feat: add kebabCase helper (e2e via opencode)",
});
console.log("--- finish ---");
console.log(fin.text);

const log = await tool("get_job_logs", { jobId, tail: 25 });
console.log("--- agent log tail ---");
console.log(log.parsed.log ?? log.text);

server.kill();
console.log("E2E COMPLETE");
