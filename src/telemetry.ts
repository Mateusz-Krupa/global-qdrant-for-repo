import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Append-only JSONL telemetry for memory retrieval. One line per search_memory
 * call: query, filters, and the hits with scores. This is the raw data for the
 * only metric that matters — does captured knowledge actually get retrieved
 * and used by later changes?
 *
 * Telemetry must never break retrieval: every failure is swallowed.
 */
const TELEMETRY_DIR = path.join(homedir(), ".qdrant-code-mcp");
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, "memory-telemetry.jsonl");

export function logMemoryRetrieval(entry: Record<string, unknown>): void {
  try {
    mkdirSync(TELEMETRY_DIR, { recursive: true });
    appendFileSync(TELEMETRY_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // never let telemetry break the tool
  }
}
