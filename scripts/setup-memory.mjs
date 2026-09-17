#!/usr/bin/env node
/**
 * setup-memory.mjs — onboard a repo into the OpenSpec procedural-memory loop.
 *
 * Usage: node setup-memory.mjs <repo-path> [--reindex]
 *
 * Does, idempotently:
 *  1. adds the qdrant-code MCP block to <repo>/opencode.json (node v22 pinned,
 *     collection code_chunks_<repo>)
 *  2. patches project-local opsx commands/skills with the memory steps
 *     (delegates to patch-opsx-memory.mjs — the single source of truth)
 *  3. creates the openspec/memory/ skeleton if missing
 *  4. installs the post-commit reindex hook (won't clobber a foreign hook)
 *  5. with --reindex: runs a full reindex of the new collection
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(__dirname, "..");
const NODE22 = "/Users/mateuszkrupa/.nvm/versions/node/v22.22.3/bin/node";
const NODE = fs.existsSync(NODE22) ? NODE22 : process.execPath;
const HOOK_MARKER = "# qdrant-memory-reindex";

const args = process.argv.slice(2);
const reindex = args.includes("--reindex");
const repoPath = path.resolve(args.filter((a) => !a.startsWith("--"))[0] ?? "");
if (!repoPath || !fs.existsSync(repoPath)) {
  console.error("Usage: node setup-memory.mjs <repo-path> [--reindex]");
  process.exit(1);
}
if (!fs.existsSync(path.join(repoPath, ".git"))) {
  console.error(`Not a git repo: ${repoPath}`);
  process.exit(1);
}

const repoName = path.basename(repoPath);
const collection = "code_chunks_" + repoName.replace(/[^A-Za-z0-9]/g, "_");

// --- 1. opencode.json MCP block ---------------------------------------------
const configPath = path.join(repoPath, "opencode.json");
let config = { $schema: "https://opencode.ai/config.json" };
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (e) {
    console.error(`Cannot parse ${configPath} (${e.message}) — fix it and re-run.`);
    process.exit(1);
  }
}
config.mcp ??= {};
if (config.mcp["qdrant-code"]) {
  console.log(`[skip] mcp.qdrant-code already configured in ${configPath}`);
} else {
  config.mcp["qdrant-code"] = {
    type: "local",
    command: [
      NODE22,
      path.join(TOOL_DIR, "dist", "index.js"),
      "--workspace-root", repoPath,
      "--collection", collection,
      "--repo", repoName,
      "--path", repoPath,
    ],
    enabled: true,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`[done] mcp.qdrant-code added to ${configPath} (collection: ${collection})`);
}

// --- 2. patch project-local opsx files ---------------------------------------
const patchRoots = [path.join(repoPath, ".opencode"), path.join(repoPath, ".claude")].filter((p) =>
  fs.existsSync(p),
);
if (patchRoots.length > 0) {
  execFileSync(NODE, [path.join(__dirname, "patch-opsx-memory.mjs"), ...patchRoots], { stdio: "inherit" });
} else {
  console.log("[skip] no project-local .opencode/.claude scaffolds to patch");
}

// --- 3. openspec/memory skeleton ---------------------------------------------
const memDir = path.join(repoPath, "openspec", "memory");
const template = (category, id, extra = "") => `# ${category}

<!--
Entry format (each ## section is one retrievable memory):

## ${id}-001: Short imperative title
**When relevant:** comma, separated, retrieval, keywords
**Learning:** The durable fact a future agent should know before working here.
**Why:** Why it is true / what went wrong when it was ignored.
**Evidence:**
- openspec/changes/archive/YYYY-MM-DD-<change>
**Last verified:** YYYY-MM-DD
${extra}
Populated by /opsx-archive reflection. Do not hand-edit for one-off details.
-->
`;
const SKELETON = {
  "index.md": `# Project Memory Index

Human-readable table of contents for project memory. This file is **not** indexed
for retrieval (agents query \`search_memory\` instead) — keep it as a reviewable map.

## Architecture (\`architecture.md\`)
## Conventions (\`conventions.md\`)
## Pitfalls (\`pitfalls.md\`)
## Decisions (\`decisions.md\`)
## Workflows (\`workflows.md\`)
`,
  "architecture.md": template("Architecture", "ARCH"),
  "conventions.md": template("Conventions", "CONV"),
  "pitfalls.md": template("Pitfalls", "PIT"),
  "decisions.md": template("Decisions", "DEC"),
  "workflows.md": template("Workflows", "WF", "\nA workflow that grows large / broadly reusable should graduate to a skill.\n"),
};
fs.mkdirSync(memDir, { recursive: true });
for (const [name, content] of Object.entries(SKELETON)) {
  const f = path.join(memDir, name);
  if (fs.existsSync(f)) {
    console.log(`[skip] ${f} exists`);
  } else {
    fs.writeFileSync(f, content);
    console.log(`[done] created ${f}`);
  }
}

// --- 4. post-commit hook ------------------------------------------------------
const hookPath = path.join(repoPath, ".git", "hooks", "post-commit");
const hook = `#!/usr/bin/env bash
${HOOK_MARKER}
# Incremental qdrant reindex after each commit (code + openspec/memory).
# Pinned to node v22 LTS — newer node (26.x) breaks the Qdrant client (undici).
unset NODE_OPTIONS   # inherited preloads (IDE/agent harnesses) can crash node
NODE=${NODE22}
[ -x "$NODE" ] || NODE=$(command -v node)
"$NODE" ${path.join(TOOL_DIR, "dist", "index.js")} \\
  --workspace-root ${repoPath} \\
  --collection ${collection} \\
  --repo ${repoName} --path ${repoPath} \\
  reindex --repo ${repoName} >> /tmp/qdrant-reindex-${repoName}.log 2>&1 &
`;
if (fs.existsSync(hookPath) && !fs.readFileSync(hookPath, "utf-8").includes(HOOK_MARKER)) {
  console.warn(`[warn] ${hookPath} exists and is not ours — NOT overwriting. Add the reindex call manually.`);
} else {
  fs.writeFileSync(hookPath, hook);
  fs.chmodSync(hookPath, 0o755);
  console.log(`[done] post-commit hook installed (${hookPath})`);
}

// --- 5. memory-guard plugin (global, idempotent) --------------------------------
const pluginSrc = path.join(TOOL_DIR, "plugin", "memory-guard.js");
const pluginDst = path.join(homedir(), ".config", "opencode", "plugin", "memory-guard.js");
if (fs.existsSync(pluginSrc)) {
  if (fs.existsSync(pluginDst) && fs.readFileSync(pluginDst, "utf-8") === fs.readFileSync(pluginSrc, "utf-8")) {
    console.log("[skip] memory-guard plugin already installed");
  } else {
    fs.mkdirSync(path.dirname(pluginDst), { recursive: true });
    fs.copyFileSync(pluginSrc, pluginDst);
    console.log(`[done] memory-guard plugin installed (${pluginDst})`);
  }
}

// --- 6. optional full reindex ---------------------------------------------------
if (reindex) {
  console.log(`[run] full reindex of ${collection}…`);
  const r = spawnSync(
    NODE,
    [
      path.join(TOOL_DIR, "dist", "index.js"),
      "--workspace-root", repoPath,
      "--collection", collection,
      "--repo", repoName, "--path", repoPath,
      "reindex", "--repo", repoName, "--full",
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) console.error("[warn] reindex failed — check Qdrant/embedder and re-run with --reindex");
}

console.log(`\nSetup complete for ${repoName}.
Next: restart OpenCode in this repo, commit openspec/memory/, and remember —
memory indexes from git (uncommitted entries are invisible to search_memory).`);
