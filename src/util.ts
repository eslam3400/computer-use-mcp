import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Escape user text so it can never be interpreted as a shell control character. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function slugify(s: string, maxLen = 32): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLen)
      .replace(/-+$/, "") || "task"
  );
}

export function todaySlug(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Last `n` lines of s. */
export function tailLines(s: string, n: number): string {
  if (n <= 0) return "";
  const lines = s.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

/** Constant-time string compare that tolerates different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Burn time anyway to avoid trivial length-oracle on failure path.
    Buffer.compare(bBuf, bBuf);
    return false;
  }
  return Buffer.compare(aBuf, bBuf) === 0;
}

export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new McpToolError(message);
}
