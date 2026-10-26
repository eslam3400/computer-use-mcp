#!/usr/bin/env node
// Writes/refreshes a local config.json with a fresh random bearer token.
// Usage: node scripts/gen-config.mjs [workspacePath] [configPath]
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const wsPath = process.argv[2] ?? "/workspace/dev/scratch-repo";
const cfgPath = process.argv[3] ?? "config.json";

let cfg = {
  mcpBearerToken: randomBytes(32).toString("hex"),
  host: process.env.HOST ?? "127.0.0.1",
  port: 8443,
  jobsDir: "jobs",
  workspaces: [{ id: "scratch", path: wsPath, defaultBranch: "main" }],
  opencode: { bin: "opencode", timeoutMs: 3600000 },
};

if (existsSync(cfgPath)) {
  try {
    const prev = JSON.parse(readFileSync(cfgPath, "utf8"));
    // Preserve settings; only rotate the token.
    cfg = { ...prev, mcpBearerToken: randomBytes(32).toString("hex") };
  } catch {
    /* start over */
  }
}
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
process.stdout.write(cfg.mcpBearerToken);
console.error(`config written to ${cfgPath} (token: first 8 chars ${cfg.mcpBearerToken.slice(0, 8)}...)`);
