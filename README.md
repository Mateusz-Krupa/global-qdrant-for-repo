# Qdrant Code + Project Memory MCP

MCP server for coding agents (OpenCode / Claude Code) providing:

1. **Semantic code search** — hybrid retrieval (dense embeddings + BM25, RRF fusion, optional reranker) over one or more git repositories.
2. **Project memory** — durable, git-reviewed knowledge (pitfalls, conventions, decisions, workflows) captured when an OpenSpec change is archived and retrieved semantically when the next change starts.

**Git is the source of truth; Qdrant is a disposable, rebuildable index.**

```
OpenCode ──stdio──> MCP server ──> Qdrant (one collection, kind=code | kind=memory)
                        │
                        └── git repositories (git ls-files / git diff driven indexing)
```

---

## Requirements

- **Node.js 22+**
- **Qdrant** running (`curl http://localhost:6333` to check)
- An **OpenAI-compatible embeddings endpoint** + valid API key
- `openspec` CLI with opsx commands/skills — only for the memory loop; code search works without it

## Install

```bash
git clone <this-repo> && cd global-qdrant-repo
npm install --legacy-peer-deps   # flag required: tree-sitter-typescript declares an outdated
                                 # peer range (^0.21) while the working grammar line is 0.25
npm run build                    # everything runs from dist/
cp .env.example .env             # then fill in QDRANT_URL + embedder endpoint/key
```

Verify the embedder key before going further (a dead key breaks both search tools):

```bash
curl -s $EMBEDDER_URL/embeddings \
  -H "Authorization: Bearer $EMBEDDER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"<your-model>","input":"test"}' | head -c 200
# expect an embedding, not {"error":{"code":"401"}}
```

## Add to a project (one command)

```bash
node scripts/setup-memory.mjs /abs/path/to/repo --reindex
```

This idempotently:

1. adds the `qdrant-code` MCP block to `<repo>/opencode.json` (collection `code_chunks_<repo>`),
2. patches the project-local opsx commands/skills with the memory steps,
3. creates the `openspec/memory/` skeleton (architecture / conventions / pitfalls / decisions / workflows),
4. installs a post-commit reindex hook (won't clobber a foreign hook),
5. installs the global `memory-guard` OpenCode plugin,
6. `--reindex` runs the initial full index.

Then:

```bash
cd /abs/path/to/repo
git add openspec/memory && git commit -m "add project memory"
# restart OpenCode in this repo so it picks up the new MCP config
```

Also patch the **global** opsx scaffolds once per machine:

```bash
node scripts/patch-opsx-memory.mjs ~/.opencode ~/.claude
```

### Multi-repo workspace (one product, several git repos)

Memory should live where the unit of work lives. If one change touches several repos, make the workspace root a meta-repo:

```bash
cd /path/to/workspace
git init
printf 'sub-repo-a/\nsub-repo-b/\nnode_modules/\n.DS_Store\n' > .gitignore   # sub-repos stay independent
git add -A && git commit -m "workspace meta-repo: shared openspec layer"
node /path/to/global-qdrant-repo/scripts/setup-memory.mjs /path/to/workspace --reindex
```

Then add each sub-repo as an extra `--repo <name> --path <abs>` pair in the generated `qdrant-code` block (same collection: code search covers everything, memory lives in the meta-repo). Optionally copy the post-commit hook into each sub-repo, changing only `reindex --repo <name>`.

### The generated MCP block (for reference / manual setup)

```jsonc
"mcp": {
  "qdrant-code": {
    "type": "local",
    "command": [
      "node",
      "/abs/path/to/global-qdrant-repo/dist/index.js",
      "--workspace-root", "/abs/path/to/repo",
      "--collection", "code_chunks_<repo>",
      "--repo", "<repo>", "--path", "/abs/path/to/repo"
      // optional: "--exclude", "docs/**", more --repo/--path pairs
    ],
    "enabled": true
  }
}
```

## MCP tools

| Tool | What it does |
|---|---|
| `search_code(query, repo?, limit?)` | hybrid semantic code search (memory excluded) |
| `search_memory(query, type?, repo?, limit?)` | project memory only; `type` ∈ architecture/convention/pitfall/decision/workflow/learning/skill; results include evidence, `Last verified`, and a ⚠ stale warning when unverified > 60 days |
| `get_file(path, startLine?, endLine?)` | read a file under workspace root |
| `reindex(repo?, full?)` | incremental (git diff since last indexed commit) or full |
| `index_status()` | per-repo state + total Qdrant points |

## How the memory loop works

Memory entries are markdown sections (`## <ID>: <title>`) in `openspec/memory/*.md`, indexed one entry per point with payload `kind=memory`, `memoryType`, `memoryId`, `whenRelevant`, `evidence[]`, `lastVerified`. Archived changes' `learnings.md` and standalone `SKILL.md` files are indexed too.

> **Indexing is git-driven: uncommitted entries are invisible to `search_memory`.**

The OpenSpec lifecycle drives capture and retrieval:

- **`/opsx-propose`** → `search_memory` with a task summary → Context Pack (≤10 entries) before writing artifacts
- **`/opsx-apply`** → retrieval again before implementing (pitfalls prioritized); non-obvious decisions are appended to `openspec/changes/<name>/notes.md` as they happen
- **`/opsx-archive`** → writes `learnings.md` (incl. a **Memory impact** verdict — did retrieved memories actually help?), classifies learnings local/project/procedural, proposes ADD/UPDATE/MERGE/IGNORE against `openspec/memory/` (with a `search_memory` dedup check before any ADD), shows the diff, and asks **`Apply? [yes/edit/no]`** — a human gates every promotion

### Enforcement

- **`plugin/memory-guard.js`** (installed globally by setup): blocks the archive `mv` until `learnings.md` exists, and injects retrieval reminders right after `openspec new change` / `openspec instructions apply`.
- **`scripts/patch-opsx-memory.mjs <root>...`** — single source of truth for all memory-step text. `openspec update` regenerates scaffolds and removes the steps; re-run this to restore them. Idempotent.

## Measuring whether it pays off

Every `search_memory` call is logged to `~/.qdrant-code-mcp/memory-telemetry.jsonl`; every archive records Memory-impact verdicts in `learnings.md`.

```bash
node scripts/memory-stats.mjs --collection code_chunks_<repo> --repo /abs/path/to/repo [--days 14]
```

Reports: retrieval volume per day, top-used entries, knowledge gaps (empty-hit queries), dead entries (indexed but never retrieved → MERGE/IGNORE candidates), and harvested Memory-impact verdicts.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm install` fails with `ERESOLVE … tree-sitter` | outdated peer range in tree-sitter-typescript | use `npm install --legacy-peer-deps` (see Install) |
| `401 … token_not_found_in_db` on every search/reindex | embedder key expired/rotated | refresh `EMBEDDER_API_KEY` in `.env` |
| `search_memory` finds nothing although entries exist | entries not committed, or no reindex since commit | commit them; check hook log `/tmp/qdrant-reindex-<repo>.log` |
| Archive runs but no reflection/learnings | project-local `.opencode` scaffolds shadow the globals and lack the memory steps | `node scripts/patch-opsx-memory.mjs <repo>/.opencode` and install the plugin |
| `TypeError: fetch failed … invalid onError method` | `@qdrant/js-client-rest` older than 1.19 | `npm install @qdrant/js-client-rest@^1.19 --legacy-peer-deps && npm run build` |
| `Vector dimension error: expected X, got Y` | `EMBEDDER_DIMENSIONS` doesn't match the embedding model | set it to the model's output size (bge-m3 = 1024), full reindex |
| Memory steps vanished after `openspec update` | CLI regenerated the scaffolds | re-run `scripts/patch-opsx-memory.mjs` |

## Repo layout

```
src/
├── index.ts              # MCP server + tools
├── qdrant.ts             # collection mgmt, hybrid search, payload filters
├── reindex.ts            # git-driven full/incremental indexing
├── embedder.ts           # OpenAI-compatible embeddings (batching, retries)
├── sparse.ts             # BM25 sparse vectors
├── reranker.ts           # optional reranker
├── telemetry.ts          # memory-retrieval JSONL log
└── chunker/              # dispatch: memory md / TS-JS AST (tree-sitter) / line-based
plugin/
└── memory-guard.js       # OpenCode enforcement plugin
scripts/
├── setup-memory.mjs      # one-command project onboarding
├── patch-opsx-memory.mjs # single source of truth for opsx memory steps
└── memory-stats.mjs      # retrieval/impact statistics
```

## CLI reindex (without MCP)

```bash
node dist/index.js \
  --workspace-root /abs/repo --collection code_chunks_repo \
  --repo repo --path /abs/repo \
  reindex --repo repo --full
```

The post-commit hooks installed by setup run exactly this (incremental) in the background and log to `/tmp/qdrant-reindex-<repo>.log`.
