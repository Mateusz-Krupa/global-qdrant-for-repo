import { execSync } from "node:child_process";

import {
  ensureCollection,
  upsertChunks,
  deleteByRepo,
  deleteByRepoAndFilePath,
  countByRepoAndFilePath,
} from "./qdrant.js";
import { embed } from "./embedder.js";
import { createSparseVector } from "./sparse.js";
import { chunkFile, makePointId } from "./chunker/index.js";
import type { Chunk } from "./chunker/index.js";
import { getRepoState, updateRepoState } from "./state.js";

export interface ReindexResult {
  filesProcessed: number;
  chunksCreated: number;
  pointsUpserted: number;
  pointsDeleted: number;
  errors: string[];
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
  /\.min\.(js|css|mjs)$/,
  /\.d\.ts$/,
  /\.bundle\.(js|mjs)$/,
  /(^|[/\\])vendor[/\\]/,
  /(^|[/\\])\.turbo[/\\]/,
];

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let regex = normalized.includes("/") ? "^" : "(^|/)";

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        regex += ".*";
        i += 1;
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(char);
    }
  }

  regex += "$";
  return new RegExp(regex);
}

function shouldSkip(filePath: string, excludePatterns: string[] = []): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");
  return (
    SKIP_PATTERNS.some((p) => p.test(filePath)) ||
    excludePatterns.some((pattern) => globToRegExp(pattern).test(normalizedPath))
  );
}

export async function getChangedFiles(
  repoPath: string,
  full: boolean,
  lastCommit?: string,
  excludePatterns: string[] = [],
): Promise<Array<{ path: string; status: "A" | "M" | "D" | "R"; oldPath?: string }>> {
  if (full) {
    const output = execSync("git ls-files", {
      cwd: repoPath,
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0 && !shouldSkip(line, excludePatterns))
      .map((filePath) => ({ path: filePath, status: "A" as const }));
  }

  const cmd = lastCommit
    ? `git diff --name-status ${lastCommit}..HEAD`
    : "git diff --name-status HEAD~1..HEAD";

  try {
    const output = execSync(cmd, {
      cwd: repoPath,
      encoding: "utf-8",
    });
    return parseDiffOutput(output, excludePatterns);
  } catch {
    return getChangedFiles(repoPath, true, undefined, excludePatterns);
  }
}

function parseDiffOutput(
  output: string,
  excludePatterns: string[] = [],
): Array<{ path: string; status: "A" | "M" | "D" | "R"; oldPath?: string }> {
  const lines = output.trim().split("\n").filter((l) => l.length > 0);
  const result: Array<{ path: string; status: "A" | "M" | "D" | "R"; oldPath?: string }> = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const statusCode = parts[0].trim();

    let status: "A" | "M" | "D" | "R";
    let filePath: string;

    if (statusCode.startsWith("R")) {
      status = "R";
      filePath = parts[2];
      const oldPath = parts[1];
      if (!shouldSkip(filePath, excludePatterns)) {
        result.push({ path: filePath, status, oldPath });
      }
      continue;
    } else {
      status = statusCode.charAt(0) as "A" | "M" | "D" | "R";
      filePath = parts[1];
    }

    if (!shouldSkip(filePath, excludePatterns)) {
      result.push({ path: filePath, status });
    }
  }

  return result;
}

function getHeadCommit(repoPath: string): string {
  return execSync("git rev-parse HEAD", {
    cwd: repoPath,
    encoding: "utf-8",
  }).trim();
}

function withRepoPrefix(repo: string, filePath: string): string {
  return `${repo}/${filePath}`;
}

async function processFiles(
  repo: string,
  repoPath: string,
  commitHash: string,
  filePaths: string[],
): Promise<{ chunks: Chunk[]; pointsUpserted: number; errors: string[] }> {
  const allChunks: Chunk[] = [];
  const errors: string[] = [];

  const prevWorkspaceRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = repoPath;

  try {
    for (const filePath of filePaths) {
      try {
        const chunks = chunkFile(filePath, repo, commitHash);
        allChunks.push(...chunks);
      } catch (err) {
        const msg = `Failed to chunk ${filePath}: ${(err as Error).message}`;
        console.error(`[ERROR] ${msg}`);
        errors.push(msg);
      }
    }

    if (allChunks.length === 0) {
      return { chunks: [], pointsUpserted: 0, errors };
    }

    const texts = allChunks.map((c) => c.text);
    const vectors = await embed(texts);

    const points = allChunks.map((chunk, i) => ({
      id: makePointId(repo, withRepoPrefix(repo, chunk.filePath), chunk.chunkIndex),
      vector: vectors[i],
      sparseVector: createSparseVector(chunk.text),
      payload: {
        repo: chunk.repo,
        filePath: withRepoPrefix(repo, chunk.filePath),
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        language: chunk.language,
        symbolName: chunk.symbolName,
        symbolType: chunk.symbolType,
        commitHash: chunk.commitHash,
        kind: chunk.kind ?? "code",
        ...(chunk.metadata ?? {}),
      },
    }));

    await upsertChunks(points);

    return { chunks: allChunks, pointsUpserted: points.length, errors };
  } finally {
    if (prevWorkspaceRoot !== undefined) {
      process.env.WORKSPACE_ROOT = prevWorkspaceRoot;
    } else {
      delete process.env.WORKSPACE_ROOT;
    }
  }
}

export async function fullReindex(
  repo: string,
  repoPath: string,
  excludePatterns: string[] = [],
): Promise<ReindexResult> {
  await ensureCollection();

  const commitHash = getHeadCommit(repoPath);

  const prevState = getRepoState(repo);
  const pointsDeleted = prevState?.totalChunks ?? 0;

  await deleteByRepo(repo);

  const changedFiles = await getChangedFiles(repoPath, true, undefined, excludePatterns);
  const filePaths = changedFiles.map((f) => f.path);

  const { chunks, pointsUpserted, errors } = await processFiles(
    repo,
    repoPath,
    commitHash,
    filePaths,
  );

  await updateRepoState(repo, commitHash, chunks.length);

  return {
    filesProcessed: filePaths.length,
    chunksCreated: chunks.length,
    pointsUpserted,
    pointsDeleted,
    errors,
  };
}

export async function incrementalReindex(
  repo: string,
  repoPath: string,
  excludePatterns: string[] = [],
): Promise<ReindexResult> {
  await ensureCollection();

  const commitHash = getHeadCommit(repoPath);
  const state = getRepoState(repo);

  if (!state) {
    return fullReindex(repo, repoPath, excludePatterns);
  }

  const changedFiles = await getChangedFiles(repoPath, false, state.lastCommit, excludePatterns);

  const addedOrModified = changedFiles.filter(
    (f) => f.status === "A" || f.status === "M" || f.status === "R",
  );
  const deleted = changedFiles.filter((f) => f.status === "D");
  const renamed = changedFiles.filter((f) => f.status === "R" && f.oldPath);

  let pointsDeleted = 0;

  for (const f of addedOrModified) {
    const prefixedPath = withRepoPrefix(repo, f.path);
    pointsDeleted += await countByRepoAndFilePath(repo, prefixedPath);
    await deleteByRepoAndFilePath(repo, prefixedPath);
  }

  for (const f of deleted) {
    const prefixedPath = withRepoPrefix(repo, f.path);
    pointsDeleted += await countByRepoAndFilePath(repo, prefixedPath);
    await deleteByRepoAndFilePath(repo, prefixedPath);
  }

  for (const f of renamed) {
    const oldPrefixedPath = withRepoPrefix(repo, f.oldPath!);
    pointsDeleted += await countByRepoAndFilePath(repo, oldPrefixedPath);
    await deleteByRepoAndFilePath(repo, oldPrefixedPath);
  }

  const filePaths = addedOrModified.map((f) => f.path);
  const { chunks, pointsUpserted, errors } = await processFiles(
    repo,
    repoPath,
    commitHash,
    filePaths,
  );

  const newTotalChunks = state.totalChunks + chunks.length - pointsDeleted;
  await updateRepoState(repo, commitHash, Math.max(0, newTotalChunks));

  return {
    filesProcessed: changedFiles.length,
    chunksCreated: chunks.length,
    pointsUpserted,
    pointsDeleted,
    errors,
  };
}

export async function reindexCommand(
  repoPaths: Record<string, string>,
  repoName?: string,
  full: boolean = false,
  excludePatterns: string[] = [],
): Promise<ReindexResult> {
  if (Object.keys(repoPaths).length === 0) {
    return {
      filesProcessed: 0,
      chunksCreated: 0,
      pointsUpserted: 0,
      pointsDeleted: 0,
      errors: ["No repo mappings configured"],
    };
  }

  const repos = repoName
    ? { [repoName]: repoPaths[repoName] }
    : repoPaths;

  const combined: ReindexResult = {
    filesProcessed: 0,
    chunksCreated: 0,
    pointsUpserted: 0,
    pointsDeleted: 0,
    errors: [],
  };

  for (const [name, repoPath] of Object.entries(repos)) {
    if (!repoPath) {
      combined.errors.push(`Unknown repo: ${name}`);
      continue;
    }

    const result =
      full || !getRepoState(name)
        ? await fullReindex(name, repoPath, excludePatterns)
        : await incrementalReindex(name, repoPath, excludePatterns);

    combined.filesProcessed += result.filesProcessed;
    combined.chunksCreated += result.chunksCreated;
    combined.pointsUpserted += result.pointsUpserted;
    combined.pointsDeleted += result.pointsDeleted;
    combined.errors.push(...result.errors);
  }

  return combined;
}
