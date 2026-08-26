import { basename, extname } from "node:path";
import type { Chunk } from "./index.js";

/**
 * Memory chunking: turns OpenSpec procedural-context markdown into small,
 * self-contained, retrievable units.
 *
 * Unlike code (AST symbols) or generic markdown (fixed line windows), memory
 * files carry meaning at the `## heading` level: each level-2 section is one
 * memory entry. Skill files (SKILL.md) are indexed whole, since a procedure is
 * only useful as a unit.
 *
 * Entries are tagged with a `kind: "memory"` and a rich metadata payload
 * (memoryType, memoryId, whenRelevant, evidence, lastVerified) so retrieval can
 * filter by type and later detect stale entries — without re-parsing markdown.
 */

const MEMORY_TYPE_BY_FILE: Record<string, string> = {
  "architecture.md": "architecture",
  "conventions.md": "convention",
  "pitfalls.md": "pitfall",
  "decisions.md": "decision",
  "workflows.md": "workflow",
  "learnings.md": "learning",
};

export interface MemoryMetadata {
  memoryType: string;
  memoryId: string;
  title: string;
  whenRelevant?: string;
  evidence?: string[];
  lastVerified?: string;
  [key: string]: unknown;
}

export function memoryTypeForPath(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  if (name === "skill.md") return "skill";
  return MEMORY_TYPE_BY_FILE[name] ?? "note";
}

/**
 * A path is "memory" when it follows the OpenSpec procedural-context
 * conventions. `index.md` is excluded — it is a human-facing table of contents,
 * not a retrievable entry.
 */
export function isMemoryPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  const name = basename(p).toLowerCase();
  if (extname(p) !== ".md") return false;
  if (name === "index.md") return false;
  // OpenSpec scaffold skills (openspec-*, opsx-*) are tool instructions, not project memory.
  if (name === "skill.md") return !/\/skills\/(openspec-|opsx-)/.test(p);
  if (name === "learnings.md") return true;
  return p.includes("openspec/memory/");
}

/**
 * Blank out HTML comment blocks so `## ` example headings inside format
 * templates are never indexed as real entries. Newlines are preserved so
 * chunk line numbers stay accurate.
 */
function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** `## PIT-001: Title` → { id: "PIT-001", title: "Title" }; otherwise slug the heading. */
function splitHeading(heading: string): { memoryId: string; title: string } {
  const match = heading.match(/^([A-Za-z][\w-]{1,14}):\s+(.+)$/);
  if (match) {
    return { memoryId: match[1], title: match[2].trim() };
  }
  const title = heading.trim();
  return { memoryId: slug(title), title };
}

function parseFields(body: string): Pick<MemoryMetadata, "whenRelevant" | "evidence" | "lastVerified"> {
  const lines = body.split("\n");
  const fields: Pick<MemoryMetadata, "whenRelevant" | "evidence" | "lastVerified"> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const whenRelevant = line.match(/^\*\*When relevant:?\*\*\s*(.*)$/i);
    if (whenRelevant && whenRelevant[1]) {
      fields.whenRelevant = whenRelevant[1].trim();
      continue;
    }

    const lastVerified = line.match(/^\*\*Last verified:?\*\*\s*(.*)$/i);
    if (lastVerified && lastVerified[1]) {
      fields.lastVerified = lastVerified[1].trim();
      continue;
    }

    if (/^\*\*Evidence:?\*\*/i.test(line)) {
      const evidence: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const bullet = lines[j].trim().match(/^[-*]\s+(.+)$/);
        if (bullet) {
          evidence.push(bullet[1].trim());
        } else if (lines[j].trim().length > 0) {
          break;
        }
      }
      if (evidence.length > 0) fields.evidence = evidence;
    }
  }

  return fields;
}

function makeChunk(
  text: string,
  filePath: string,
  repo: string,
  commitHash: string,
  startLine: number,
  endLine: number,
  chunkIndex: number,
  metadata: MemoryMetadata,
): Chunk {
  return {
    text,
    filePath,
    repo,
    startLine,
    endLine,
    chunkIndex,
    totalChunks: 0,
    language: "markdown",
    symbolName: metadata.title,
    symbolType: metadata.memoryType,
    commitHash,
    kind: "memory",
    metadata,
  };
}

function parseFrontmatter(source: string): { name?: string; description?: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(name|description):\s*(.+)$/);
    if (kv) result[kv[1] as "name" | "description"] = kv[2].trim();
  }
  return result;
}

/** Skills are indexed as a single unit — a procedure only makes sense whole. */
function parseSkillFile(
  source: string,
  filePath: string,
  repo: string,
  commitHash: string,
): Chunk[] {
  const { name, description } = parseFrontmatter(source);
  const title = name ?? basename(filePath);
  const metadata: MemoryMetadata = {
    memoryType: "skill",
    memoryId: name ?? slug(title),
    title,
    ...parseFields(source),
  };
  if (description && !metadata.whenRelevant) metadata.whenRelevant = description;

  const lineCount = source.split("\n").length;
  return [makeChunk(source, filePath, repo, commitHash, 1, lineCount, 0, metadata)];
}

/**
 * Split a memory markdown file into one chunk per `## ` section. Content before
 * the first section (the `# Title` and any intro) is dropped — it is not an entry.
 */
export function parseMemoryFile(
  source: string,
  filePath: string,
  repo: string,
  commitHash: string,
): Chunk[] {
  if (basename(filePath).toLowerCase() === "skill.md") {
    return parseSkillFile(source, filePath, repo, commitHash);
  }

  const memoryType = memoryTypeForPath(filePath);
  const lines = stripComments(source).split("\n");
  const chunks: Chunk[] = [];

  let sectionStart = -1;
  let heading = "";

  const flush = (endLine: number) => {
    if (sectionStart < 0) return;
    const body = lines.slice(sectionStart, endLine).join("\n").trim();
    if (body.length === 0) return;
    const { memoryId, title } = splitHeading(heading);
    const metadata: MemoryMetadata = {
      memoryType,
      memoryId,
      title,
      ...parseFields(body),
    };
    chunks.push(
      makeChunk(body, filePath, repo, commitHash, sectionStart + 1, endLine, chunks.length, metadata),
    );
  };

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##\s+(.+)$/);
    if (match) {
      flush(i);
      sectionStart = i;
      heading = match[1].trim();
    }
  }
  flush(lines.length);

  for (const chunk of chunks) chunk.totalChunks = chunks.length;
  return chunks;
}
