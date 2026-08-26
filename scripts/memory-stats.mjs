#!/usr/bin/env node
/**
 * memory-stats.mjs — is the memory system paying off?
 *
 * Usage: node memory-stats.mjs [--collection <name>] [--days <N>] [--repo <path>]
 *
 * Reads ~/.qdrant-code-mcp/memory-telemetry.jsonl and reports:
 *  - retrieval volume (are the opsx steps actually firing?)
 *  - top retrieved entries (which knowledge works)
 *  - empty-hit queries (gaps — knowledge that was looked for but missing)
 *  - with --collection: dead entries (indexed but never retrieved)
 *  - with --repo: "Memory impact" verdicts collected from learnings.md files
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const TELEMETRY = path.join(homedir(), ".qdrant-code-mcp", "memory-telemetry.jsonl");
const QDRANT = process.env.QDRANT_URL || "http://localhost:6333";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const collection = opt("--collection");
const days = opt("--days") ? parseInt(opt("--days"), 10) : null;
const repo = opt("--repo");

// ---- load telemetry ----------------------------------------------------------
if (!fs.existsSync(TELEMETRY)) {
  console.log(`No telemetry yet (${TELEMETRY}). Run some /opsx-propose|apply sessions first.`);
  process.exit(0);
}
const cutoff = days ? Date.now() - days * 86_400_000 : null;
const events = fs
  .readFileSync(TELEMETRY, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .filter((e) => !collection || e.collection === collection)
  .filter((e) => !cutoff || Date.parse(e.ts) >= cutoff);

if (events.length === 0) {
  console.log("No matching telemetry events.");
  process.exit(0);
}

// ---- volume -------------------------------------------------------------------
const byDay = new Map();
for (const e of events) {
  const day = e.ts.slice(0, 10);
  byDay.set(day, (byDay.get(day) ?? 0) + 1);
}
console.log(`# Memory retrieval stats${collection ? ` — ${collection}` : ""}${days ? ` (last ${days}d)` : ""}\n`);
console.log(`Calls: ${events.length} across ${byDay.size} day(s)  (${events[0].ts.slice(0, 10)} → ${events[events.length - 1].ts.slice(0, 10)})`);
for (const [day, n] of [...byDay.entries()].sort()) console.log(`  ${day}: ${"█".repeat(Math.min(n, 40))} ${n}`);

// ---- top hits -------------------------------------------------------------------
const hitCounts = new Map();
let emptyQueries = [];
for (const e of events) {
  if (!e.hits || e.hits.length === 0) { emptyQueries.push(e.query); continue; }
  for (const h of e.hits) {
    if (!h.id) continue;
    const cur = hitCounts.get(h.id) ?? { n: 0, type: h.type };
    cur.n++;
    hitCounts.set(h.id, cur);
  }
}
console.log(`\n## Top retrieved entries`);
const top = [...hitCounts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15);
if (top.length === 0) console.log("  (none)");
for (const [id, { n, type }] of top) console.log(`  ${String(n).padStart(4)}×  [${type ?? "?"}] ${id}`);

console.log(`\n## Empty-hit queries (knowledge gaps): ${emptyQueries.length}`);
for (const q of [...new Set(emptyQueries)].slice(0, 10)) console.log(`  - "${q}"`);

// ---- dead entries (needs qdrant) -------------------------------------------------
if (collection) {
  try {
    const res = await fetch(`${QDRANT}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: { must: [{ key: "kind", match: { value: "memory" } }] },
        limit: 500,
        with_payload: ["memoryId", "memoryType"],
        with_vector: false,
      }),
    });
    const data = await res.json();
    const indexed = new Map(
      (data.result?.points ?? [])
        .map((p) => [p.payload?.memoryId, p.payload?.memoryType])
        .filter(([id]) => id),
    );
    const dead = [...indexed.entries()].filter(([id]) => !hitCounts.has(id));
    console.log(`\n## Dead entries (indexed, never retrieved): ${dead.length}/${indexed.size}`);
    for (const [id, type] of dead.slice(0, 20)) console.log(`  - [${type ?? "?"}] ${id}`);
    if (dead.length > 5) console.log("  → consolidation candidates: consider MERGE/IGNORE on the next archive.");
  } catch (e) {
    console.log(`\n(dead-entry check skipped — Qdrant unreachable: ${e.message})`);
  }
}

// ---- memory-impact verdicts from learnings ---------------------------------------
if (repo) {
  const verdicts = [];
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(p);
      else if (entry.name === "learnings.md") {
        const lines = fs.readFileSync(p, "utf-8").split("\n").filter((l) => /memory impact/i.test(l));
        for (const l of lines) verdicts.push({ change: path.basename(path.dirname(p)), line: l.trim() });
      }
    }
  };
  scan(path.join(repo, "openspec", "changes"));
  console.log(`\n## Memory-impact verdicts from learnings.md: ${verdicts.length}`);
  for (const v of verdicts.slice(0, 20)) console.log(`  [${v.change}] ${v.line}`);
  if (verdicts.length === 0) console.log("  (none yet — they appear after archives run with the Memory impact step)");
}
