#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { OpencodeAgent } from "./agent/opencode.js";
import { JobQueue } from "./jobs/queue.js";
import { ToolRouter } from "./mcp/router.js";
import { startMcpServer } from "./mcp/server.js";

const cfg = loadConfig();
mkdirSync(resolve(process.cwd(), cfg.jobsDir), { recursive: true });

const queue = new JobQueue(
  () => loadConfig(),
  new OpencodeAgent(cfg),
  resolve(process.cwd(), cfg.jobsDir)
);
const router = new ToolRouter(() => loadConfig(), queue);
const server = startMcpServer({ cfgProvider: () => loadConfig(), router });

server.listen(cfg.port, cfg.host, () => {
  console.log(`vps-coding-mcp listening on http://${cfg.host}:${cfg.port}/mcp`);
  console.log(`workspaces: ${cfg.workspaces.map((w) => w.id).join(", ") || "(none)"}`);
  console.log(`jobs dir: ${cfg.jobsDir}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} received; shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}
