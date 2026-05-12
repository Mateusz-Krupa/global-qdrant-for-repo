import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeConfig {
  workspaceRoot: string;
  collectionName: string;
  repoPaths: Record<string, string>;
}

interface ParsedArgs {
  config: RuntimeConfig;
  command?: string;
  commandArgs: string[];
}

export function parseRuntimeArgs(argv: string[]): ParsedArgs {
  const commandIndex = argv.findIndex((arg) => arg === "reindex");
  const globalArgs = commandIndex >= 0 ? argv.slice(0, commandIndex) : argv;
  const command = commandIndex >= 0 ? argv[commandIndex] : undefined;
  const commandArgs = commandIndex >= 0 ? argv.slice(commandIndex + 1) : [];

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const defaultWorkspaceRoot = path.resolve(__dirname, "..", "..");
  const workspaceRoot =
    readOption(globalArgs, "--workspace-root") ||
    process.env.WORKSPACE_ROOT ||
    defaultWorkspaceRoot;
  const collectionName =
    readOption(globalArgs, "--collection") ||
    process.env.QDRANT_COLLECTION ||
    "code_chunks";

  const repoPairs = parseRepoPairs(globalArgs);
  const repoPaths: Record<string, string> = {};
  for (const pair of repoPairs) {
    repoPaths[pair.repo] = pair.repoPath;
  }

  validateConfig({ workspaceRoot, collectionName, repoPaths });

  return {
    config: {
      workspaceRoot: path.resolve(workspaceRoot),
      collectionName,
      repoPaths,
    },
    command,
    commandArgs,
  };
}

function readOption(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === key && args[i + 1]) {
      return args[i + 1];
    }
  }
  return undefined;
}

function parseRepoPairs(args: string[]): Array<{ repo: string; repoPath: string }> {
  const pairs: Array<{ repo: string; repoPath: string }> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--repo") {
      continue;
    }

    const repo = args[i + 1];
    const pathFlag = args[i + 2];
    const repoPath = args[i + 3];
    if (!repo || pathFlag !== "--path" || !repoPath) {
      throw new Error(
        `Invalid repo mapping near argument index ${i}. Expected: --repo <name> --path <absolute-path>`,
      );
    }
    pairs.push({ repo, repoPath });
    i += 3;
  }
  return pairs;
}

function validateConfig(config: RuntimeConfig): void {
  if (!path.isAbsolute(config.workspaceRoot)) {
    throw new Error(`workspace-root must be absolute: ${config.workspaceRoot}`);
  }

  if (!fs.existsSync(config.workspaceRoot)) {
    throw new Error(`workspace-root does not exist: ${config.workspaceRoot}`);
  }

  if (Object.keys(config.repoPaths).length === 0) {
    throw new Error(
      "No repo mappings configured. Add one or more mappings: --repo <name> --path <absolute-path>",
    );
  }

  for (const [repo, repoPath] of Object.entries(config.repoPaths)) {
    if (!path.isAbsolute(repoPath)) {
      throw new Error(
        `Repo '${repo}' path must be absolute: ${repoPath}. Use --repo ${repo} --path /abs/path`,
      );
    }

    if (!fs.existsSync(repoPath)) {
      throw new Error(`Repo '${repo}' path does not exist: ${repoPath}`);
    }

    const stat = fs.statSync(repoPath);
    if (!stat.isDirectory()) {
      throw new Error(`Repo '${repo}' path is not a directory: ${repoPath}`);
    }

    try {
      fs.accessSync(repoPath, fs.constants.R_OK);
    } catch {
      throw new Error(`Repo '${repo}' path is not readable: ${repoPath}`);
    }
  }
}
