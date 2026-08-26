import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { parseTsFile } from "./ts-parser.js";
import { parseJsFile } from "./js-parser.js";
import { isMemoryPath, parseMemoryFile } from "./md-memory.js";

export interface Chunk {
  text: string;
  filePath: string;
  repo: string;
  startLine: number;
  endLine: number;
  chunkIndex: number;
  totalChunks: number;
  language: string;
  symbolName: string | null;
  symbolType: string | null;
  commitHash: string;
  /** Partition within the collection. Defaults to code when unset. */
  kind?: "code" | "memory";
  /** Extra payload for non-code chunks (memory entries), spread verbatim into Qdrant. */
  metadata?: Record<string, unknown>;
}

const SKIP_PATTERNS = [
  /(^|[/\\])node_modules[/\\]/,
  /(^|[/\\])\.git[/\\]/,
  /(^|[/\\])dist[/\\]/,
  /(^|[/\\])build[/\\]/,
  /(^|[/\\])\.next[/\\]/,
  /(^|[/\\])\.tmp[/\\]/,
  /(^|[/\\])coverage[/\\]/,
  /(^|[/\\])__tests__[/\\]/,
  /(^|[/\\])\.cache[/\\]/,
  /\.min\.(js|css|mjs)$/,
  /\.d\.ts$/,
  /\.bundle\.(js|mjs)$/,
  /(^|[/\\])vendor[/\\]/,
  /(^|[/\\])\.turbo[/\\]/,
];

const LINE_BASED_EXTENSIONS = new Set([
  ".json",
  ".css",
  ".scss",
  ".md",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".svg",
]);

const LANGUAGE_MAP: Record<string, string> = {
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".html": "html",
  ".svg": "svg",
};

function shouldSkip(filePath: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(filePath));
}

export function makePointId(
  repo: string,
  filePath: string,
  chunkIndex: number,
): string {
  const hash = createHash("md5")
    .update(`${repo}:${filePath}:${chunkIndex}`)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

export function lineBasedChunk(
  source: string,
  filePath: string,
  repo: string,
  commitHash: string,
  language: string,
  maxLines: number = 100,
  overlap: number = 20,
): Chunk[] {
  const lines = source.split("\n");
  const totalLines = lines.length;
  if (totalLines === 0) return [];

  const chunks: Chunk[] = [];
  let startLine = 1;

  while (startLine <= totalLines) {
    const endLine = Math.min(startLine + maxLines - 1, totalLines);
    const codeLines = lines.slice(startLine - 1, endLine);
    chunks.push({
      text: codeLines.join("\n"),
      filePath,
      repo,
      startLine,
      endLine,
      chunkIndex: chunks.length,
      totalChunks: 0,
      language,
      symbolName: null,
      symbolType: null,
      commitHash,
    });

    if (endLine >= totalLines) break;
    startLine = endLine - overlap + 1;
  }

  for (const chunk of chunks) {
    chunk.totalChunks = chunks.length;
  }

  return chunks;
}

function addContextPrefix(chunk: Chunk): Chunk {
  const parts: string[] = [`// ${chunk.filePath}`];

  if (chunk.symbolName) {
    const typeLabel = chunk.symbolType ?? "symbol";
    parts.push(
      `// ${typeLabel}: ${chunk.symbolName} (lines ${chunk.startLine}-${chunk.endLine})`,
    );
  }

  parts.push(chunk.text);

  return {
    ...chunk,
    text: parts.join("\n"),
  };
}

export function chunkFile(
  filePath: string,
  repo: string,
  commitHash: string,
): Chunk[] {
  if (shouldSkip(filePath)) return [];

  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  const fullPath = join(workspaceRoot, filePath);

  let source: string;
  try {
    source = readFileSync(fullPath, "utf-8");
  } catch (err) {
    console.error(`[chunker] Failed to read ${fullPath}:`, err);
    return [];
  }

  if (isMemoryPath(filePath)) {
    return parseMemoryFile(source, filePath, repo, commitHash);
  }

  const ext = extname(filePath);
  let chunks: Chunk[];

  if (ext === ".ts" || ext === ".tsx") {
    try {
      chunks = parseTsFile(source, filePath, repo, commitHash);
      if (chunks.length === 0 && source.trim().length > 0) {
        chunks = lineBasedChunk(
          source,
          filePath,
          repo,
          commitHash,
          ext === ".tsx" ? "tsx" : "typescript",
        );
      }
    } catch {
      chunks = lineBasedChunk(
        source,
        filePath,
        repo,
        commitHash,
        ext === ".tsx" ? "tsx" : "typescript",
      );
    }
  } else if (ext === ".js" || ext === ".jsx") {
    try {
      chunks = parseJsFile(source, filePath, repo, commitHash);
      if (chunks.length === 0 && source.trim().length > 0) {
        chunks = lineBasedChunk(
          source,
          filePath,
          repo,
          commitHash,
          ext === ".jsx" ? "jsx" : "javascript",
        );
      }
    } catch {
      chunks = lineBasedChunk(
        source,
        filePath,
        repo,
        commitHash,
        ext === ".jsx" ? "jsx" : "javascript",
      );
    }
  } else if (LINE_BASED_EXTENSIONS.has(ext)) {
    const lang = LANGUAGE_MAP[ext] ?? ext.slice(1);
    chunks = lineBasedChunk(source, filePath, repo, commitHash, lang);
  } else {
    return [];
  }

  return chunks.map(addContextPrefix);
}