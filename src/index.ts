import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import fs from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensureCollection, search, getQdrantClient, type SearchFilters } from "./qdrant.js";
import { embed } from "./embedder.js";
import { createSparseVector } from "./sparse.js";
import { readIndexState } from "./state.js";
import { reindexCommand } from "./reindex.js";
import { rerank } from "./reranker.js";
import { parseRuntimeArgs, type RuntimeConfig } from "./config.js";
import { logMemoryRetrieval } from "./telemetry.js";

const runtime = parseRuntimeArgs(process.argv.slice(2));
const RUNTIME_CONFIG: RuntimeConfig = runtime.config;
process.env.WORKSPACE_ROOT = RUNTIME_CONFIG.workspaceRoot;
process.env.QDRANT_COLLECTION = RUNTIME_CONFIG.collectionName;

const TOOLS = [
  {
    name: "search_code",
    description:
      "Semantically search the indexed codebase. Returns matching code chunks with file paths, line numbers, and relevance scores.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        repo: {
          type: "string",
          description: "Optional: filter to a specific repository",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "Maximum number of results",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_memory",
    description:
      "Search project memory: distilled learnings, conventions, pitfalls, decisions, and reusable skills captured from previous OpenSpec changes. Use at the start of a task to retrieve relevant context before implementing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Task summary or natural language query describing what you are about to work on",
        },
        type: {
          type: "string",
          enum: ["architecture", "convention", "pitfall", "decision", "workflow", "learning", "skill"],
          description: "Optional: restrict to a single memory type",
        },
        repo: {
          type: "string",
          description: "Optional: filter to a specific repository",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "Maximum number of results",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_file",
    description: "Read a file from disk. Optionally slice to a line range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative file path from workspace root (e.g., 'sdgFrontend/src/components/Login.tsx')",
        },
        startLine: {
          type: "number",
          description: "Optional: starting line (1-indexed, inclusive)",
        },
        endLine: {
          type: "number",
          description: "Optional: ending line (1-indexed, inclusive)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "reindex",
    description:
      "Re-index the codebase into Qdrant. Use --full to re-index everything, or incremental by default.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Optional: target a specific repository",
        },
        full: {
          type: "boolean",
          default: false,
          description: "If true, re-index all files. Otherwise only changed files.",
        },
      },
      required: [],
    },
  },
  {
    name: "index_status",
    description: "Show indexing status for all repositories.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

function textBlock(text: string) {
  return { type: "text" as const, text };
}

function clampLimit(raw: unknown): number {
  return typeof raw === "number" ? Math.max(1, Math.min(50, raw)) : 10;
}

/** Embed the query, run hybrid (dense + BM25) search, then rerank down to `limit`. */
async function retrieve(
  query: string,
  filters: SearchFilters,
  limit: number,
): Promise<Awaited<ReturnType<typeof search>>> {
  const vectors = await embed([query]);
  const sparseVector = createSparseVector(query);

  // Hybrid search with a wider window (3x limit) gives the reranker more candidates.
  const searchLimit = Math.min(limit * 3, 50);
  const results = await search(vectors[0], sparseVector, filters, searchLimit);
  if (results.length === 0) return results;

  const documents = results.map((point, i) => ({
    text: String((point.payload as Record<string, unknown>).text ?? ""),
    index: i,
  }));
  const rerankedIndices = await rerank(query, documents, limit);
  return rerankedIndices.map((idx) => results[idx]).filter(Boolean);
}

async function handleSearchCode(args: Record<string, unknown>) {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    return { content: [textBlock("Error: query must be a non-empty string.")] };
  }

  const repo = args.repo as string | undefined;
  if (repo !== undefined && !RUNTIME_CONFIG.repoPaths[repo]) {
    return {
      content: [
        textBlock(
          `Error: unknown repo '${repo}'. Configured repos: ${Object.keys(RUNTIME_CONFIG.repoPaths).join(", ")}`,
        ),
      ],
    };
  }

  const limit = clampLimit(args.limit);
  const results = await retrieve(query, { repo, excludeMemory: true }, limit);

  if (results.length === 0) {
    return {
      content: [
        textBlock(
          "No results found. The codebase may not be indexed yet. Run reindex first.",
        ),
      ],
    };
  }

  const content = results.map((point) => {
    const p = point.payload as Record<string, unknown>;
    const filePath = String(p.filePath ?? "");
    const pointRepo = String(p.repo ?? "");
    const startLine = p.startLine;
    const endLine = p.endLine;
    const symbolName = p.symbolName ?? "unknown";
    const symbolType = p.symbolType ?? "unknown";
    const score = point.score ?? 0;
    const snippet = String(p.text ?? "");

    return textBlock(
      [
        `File: ${filePath}`,
        `Repository: ${pointRepo}`,
        `Lines: ${startLine}-${endLine}`,
        `Symbol: ${symbolName} (${symbolType})`,
        `Score: ${score.toFixed(4)}`,
        "",
        snippet,
      ].join("\n"),
    );
  });

  return { content };
}

/** Entries unverified for longer than this get a stale warning in results. */
const STALE_AFTER_DAYS = 60;

const MEMORY_TYPES = new Set([
  "architecture",
  "convention",
  "pitfall",
  "decision",
  "workflow",
  "learning",
  "skill",
]);

async function handleSearchMemory(args: Record<string, unknown>) {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    return { content: [textBlock("Error: query must be a non-empty string.")] };
  }

  const repo = args.repo as string | undefined;
  if (repo !== undefined && !RUNTIME_CONFIG.repoPaths[repo]) {
    return {
      content: [
        textBlock(
          `Error: unknown repo '${repo}'. Configured repos: ${Object.keys(RUNTIME_CONFIG.repoPaths).join(", ")}`,
        ),
      ],
    };
  }

  const memoryType = args.type as string | undefined;
  if (memoryType !== undefined && !MEMORY_TYPES.has(memoryType)) {
    return {
      content: [
        textBlock(
          `Error: unknown type '${memoryType}'. Valid types: ${[...MEMORY_TYPES].join(", ")}`,
        ),
      ],
    };
  }

  const limit = clampLimit(args.limit);
  const results = await retrieve(query, { repo, kind: "memory", memoryType }, limit);

  logMemoryRetrieval({
    ts: new Date().toISOString(),
    collection: RUNTIME_CONFIG.collectionName,
    query,
    type: memoryType ?? null,
    hits: results.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return { id: p.memoryId ?? p.filePath ?? null, type: p.memoryType ?? null, score: r.score ?? null };
    }),
  });

  if (results.length === 0) {
    return {
      content: [
        textBlock(
          "No project memory found. Either nothing relevant has been captured yet, or memory has not been indexed (run reindex).",
        ),
      ],
    };
  }

  const content = results.map((point) => {
    const p = point.payload as Record<string, unknown>;
    const type = String(p.memoryType ?? "note");
    const id = String(p.memoryId ?? "");
    const title = String(p.title ?? p.symbolName ?? "");
    const whenRelevant = p.whenRelevant ? String(p.whenRelevant) : undefined;
    const lastVerified = p.lastVerified ? String(p.lastVerified) : undefined;
    const evidence = Array.isArray(p.evidence) ? (p.evidence as unknown[]).map(String) : [];
    const score = point.score ?? 0;
    const body = String(p.text ?? "");

    const header = id ? `[${type}] ${id} — ${title}` : `[${type}] ${title}`;
    const meta: string[] = [];
    if (whenRelevant) meta.push(`When relevant: ${whenRelevant}`);
    if (lastVerified) {
      meta.push(`Last verified: ${lastVerified}`);
      const ageDays = Math.floor((Date.now() - Date.parse(lastVerified)) / 86_400_000);
      if (Number.isFinite(ageDays) && ageDays > STALE_AFTER_DAYS) {
        meta.push(`⚠ stale: unverified for ${ageDays} days — confirm it still holds before relying on it`);
      }
    } else {
      meta.push("⚠ no verification date — confirm it still holds before relying on it");
    }
    if (evidence.length > 0) meta.push(`Evidence: ${evidence.join(", ")}`);
    meta.push(`Score: ${score.toFixed(4)}`);

    return textBlock([header, ...meta, "", body].join("\n"));
  });

  return { content };
}

async function handleGetFile(args: Record<string, unknown>) {
  const filePath = args.path;
  if (typeof filePath !== "string") {
    return { content: [textBlock("Error: path is required.")] };
  }

  const workspaceRoot = path.resolve(RUNTIME_CONFIG.workspaceRoot);
  const resolved = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(workspaceRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      content: [
        textBlock(`Error: path must resolve under workspace root (${workspaceRoot}).`),
      ],
    };
  }

  try {
    const content = await fs.readFile(resolved, "utf-8");

    const startLine = args.startLine;
    const endLine = args.endLine;

    if (typeof startLine === "number" || typeof endLine === "number") {
      const lines = content.split("\n");
      const start = typeof startLine === "number" ? Math.max(1, startLine) - 1 : 0;
      const end = typeof endLine === "number" ? Math.min(lines.length, endLine) : lines.length;
      return { content: [textBlock(lines.slice(start, end).join("\n"))] };
    }

    return { content: [textBlock(content)] };
  } catch {
    return { content: [textBlock(`File not found: ${filePath}`)] };
  }
}

async function handleReindex(args: Record<string, unknown>) {
  const repo = args.repo as string | undefined;
  if (repo !== undefined && !RUNTIME_CONFIG.repoPaths[repo]) {
    return {
      content: [
        textBlock(
          `Error: unknown repo '${repo}'. Configured repos: ${Object.keys(RUNTIME_CONFIG.repoPaths).join(", ")}`,
        ),
      ],
    };
  }
  const full = args.full === true;

  const result = await reindexCommand(
    RUNTIME_CONFIG.repoPaths,
    repo,
    full,
    RUNTIME_CONFIG.excludePatterns,
  );

  const lines: string[] = [];
  lines.push(`Files processed: ${result.filesProcessed}`);
  lines.push(`Chunks created: ${result.chunksCreated}`);
  lines.push(`Points upserted: ${result.pointsUpserted}`);
  lines.push(`Points deleted: ${result.pointsDeleted}`);
  lines.push(`Errors: ${result.errors.length}`);
  for (const err of result.errors) {
    lines.push(`  - ${err}`);
  }

  return { content: [textBlock(lines.join("\n"))] };
}

async function handleIndexStatus() {
  const state = readIndexState();

  const lines: string[] = [];

  const configuredRepos = Object.keys(RUNTIME_CONFIG.repoPaths);
  for (const repo of configuredRepos) {
    const repoState = state[repo];
    if (repoState) {
      lines.push(`Repository: ${repo}`);
      lines.push(`  Last commit: ${repoState.lastCommit}`);
      lines.push(`  Last indexed: ${repoState.lastIndexed}`);
      lines.push(`  Total chunks: ${repoState.totalChunks}`);
    } else {
      lines.push(`Repository: ${repo}`);
      lines.push("  Not yet indexed");
    }
    lines.push("");
  }

  try {
    const client = getQdrantClient();
    const countResult = await client.count(RUNTIME_CONFIG.collectionName);
    lines.push(`Total Qdrant points: ${countResult.count}`);
  } catch {
    lines.push("Total Qdrant points: unable to retrieve");
  }

  return { content: [textBlock(lines.join("\n"))] };
}

async function startMcpServer() {
  const server = new Server(
    { name: "qdrant-code-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = args ?? {};

    try {
      switch (name) {
        case "search_code":
          return await handleSearchCode(toolArgs);
        case "search_memory":
          return await handleSearchMemory(toolArgs);
        case "get_file":
          return await handleGetFile(toolArgs);
        case "reindex":
          return await handleReindex(toolArgs);
        case "index_status":
          return await handleIndexStatus();
        default:
          return { content: [textBlock(`Unknown tool: ${name}`)] };
      }
    } catch (err) {
      return {
        content: [
          textBlock(`Error: ${(err as Error).message ?? String(err)}`),
        ],
      };
    }
  });

  await ensureCollection();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("qdrant-code-mcp server running on stdio");
}

async function runCli(args: string[]) {
  const command = runtime.command || args[0];

  if (command === "reindex") {
    let repo: string | undefined;
    let full = false;

    const commandArgs = runtime.command ? runtime.commandArgs : args.slice(1);

    for (let i = 0; i < commandArgs.length; i++) {
      if (commandArgs[i] === "--repo" && commandArgs[i + 1]) {
        repo = commandArgs[i + 1];
        i++;
      } else if (commandArgs[i] === "--full") {
        full = true;
      }
    }

    if (repo && !RUNTIME_CONFIG.repoPaths[repo]) {
      console.error(
        `Unknown repo '${repo}'. Configured repos: ${Object.keys(RUNTIME_CONFIG.repoPaths).join(", ")}`,
      );
      process.exit(1);
    }

    const result = await reindexCommand(
      RUNTIME_CONFIG.repoPaths,
      repo,
      full,
      RUNTIME_CONFIG.excludePatterns,
    );
    console.log(`Reindex complete`);
    console.log(`  Files processed: ${result.filesProcessed}`);
    console.log(`  Chunks created: ${result.chunksCreated}`);
    console.log(`  Points upserted: ${result.pointsUpserted}`);
    console.log(`  Points deleted: ${result.pointsDeleted}`);
    console.log(`  Errors: ${result.errors.length}`);
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.log(`    - ${err}`);
      }
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

const args = process.argv.slice(2);

if (runtime.command) {
  runCli(args).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  startMcpServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
