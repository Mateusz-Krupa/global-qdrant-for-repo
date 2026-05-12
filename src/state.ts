import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", ".index-state.json");

export interface RepoState {
  lastCommit: string;
  lastIndexed: string;
  totalChunks: number;
}

export interface IndexState {
  [repo: string]: RepoState;
}

export function readIndexState(): IndexState {
  try {
    const data = readFileSync(STATE_PATH, "utf-8");
    return JSON.parse(data) as IndexState;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {};
    }
    console.warn(`[WARN] Failed to read index state: ${(err as Error).message}`);
    return {};
  }
}

export async function writeIndexState(state: IndexState): Promise<void> {
  const tmpPath = STATE_PATH + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await fs.rename(tmpPath, STATE_PATH);
}

export async function updateRepoState(
  repo: string,
  lastCommit: string,
  totalChunks: number,
): Promise<void> {
  const state = readIndexState();
  state[repo] = {
    lastCommit,
    lastIndexed: new Date().toISOString(),
    totalChunks,
  };
  await writeIndexState(state);
}

export function getRepoState(repo: string): RepoState | null {
  const state = readIndexState();
  return state[repo] ?? null;
}
