# Global Qdrant MCP

Reusable MCP server for semantic code search and indexing with Qdrant.

It is project-agnostic: you configure workspace, collection, and repo mappings at startup.

## Architecture

- `search_code`: semantic search (optional repo filter)
- hybrid retrieval combines dense embeddings with Qdrant sparse `bm25` vectors via RRF fusion
- `get_file`: read files (line-slicing supported)
- `reindex`: on-demand incremental/full reindex
- `index_status`: index state + Qdrant point count

Flow: OpenCode -> MCP server (stdio) -> Qdrant + local repositories.

## Prerequisites

- Node.js 20+
- Running Qdrant (`QDRANT_URL`, default `http://localhost:6333`)
- `OPENAI_API_KEY` for embedding generation

## Quick Start

```bash
npm install
npm run build
```

Run MCP server (no subcommand):

```bash
node dist/index.js \
  --workspace-root /abs/path/to/project-root \
  --collection code_chunks_projectA \
  --repo frontend --path /abs/path/to/project-root/frontend \
  --repo backend --path /abs/path/to/project-root/backend
```

## Startup Args

- `--workspace-root <abs-path>`: root boundary for `get_file` path safety
- `--collection <name>`: Qdrant collection name (recommended per project)
- repeated repo mappings:
  - `--repo <name> --path <abs-path>`

Important ordering rule:
- Global config flags go before subcommand.
- Reindex subcommand flags go after `reindex`.

Example:

```bash
node dist/index.js \
  --workspace-root /abs/project \
  --collection code_chunks_projectA \
  --repo frontend --path /abs/project/frontend \
  --repo backend --path /abs/project/backend \
  reindex --repo frontend --full
```

## opencode.json Setup

Add MCP entry in each target project's `opencode.json`:

```json
{
  "mcp": {
    "qdrant-code": {
      "type": "local",
      "command": [
        "node",
        "/Users/mateuszkrupa/global-qdrant-repo/dist/index.js",
        "--workspace-root", "/Users/mateuszkrupa/my-project",
        "--collection", "code_chunks_my_project",
        "--repo", "frontend", "--path", "/Users/mateuszkrupa/my-project/frontend",
        "--repo", "backend", "--path", "/Users/mateuszkrupa/my-project/backend"
      ],
      "enabled": true
    }
  }
}
```

If needed, provide env vars in shell/session before OpenCode start:

```bash
export QDRANT_URL=http://localhost:6333
export OPENAI_API_KEY=...
```

Optional reranker configuration:

```bash
export RERANKER_PROVIDER=maas
export RERANKER_URL=https://maas.phoeniqs.com/v1
export RERANKER_MODEL=inference-bge-reranker
export RERANKER_API_KEY=...
```

Supported `RERANKER_PROVIDER` values:

- `none`: disabled, preserves Qdrant result order
- `cohere`: Cohere-compatible `/rerank` endpoint
- `maas`: OpenAI-compatible `/rerank` endpoint, using `RERANKER_URL` as the base URL
- `openai-compatible`: alias for custom `/rerank` providers

The reranker is applied after Qdrant retrieval and only reorders the candidate chunks returned to OpenCode.

## Hybrid Search

The collection uses named vectors:

- `dense`: embedding vector from `EMBEDDER_MODEL`
- `bm25`: sparse keyword vector with Qdrant `idf` modifier

`search_code` retrieves candidates from both vectors and merges them with Qdrant RRF fusion before the optional reranker runs.

Changing from an older dense-only collection requires a full reindex because the collection schema changes.

## Git Hooks (post-commit)

Use CLI reindex in each repo hook.

Example `frontend/.githooks/post-commit`:

```bash
#!/usr/bin/env bash
node /Users/mateuszkrupa/global-qdrant-repo/dist/index.js \
  --workspace-root /Users/mateuszkrupa/my-project \
  --collection code_chunks_my_project \
  --repo frontend --path /Users/mateuszkrupa/my-project/frontend \
  --repo backend --path /Users/mateuszkrupa/my-project/backend \
  reindex --repo frontend || true
```

Example `backend/.githooks/post-commit`:

```bash
#!/usr/bin/env bash
node /Users/mateuszkrupa/global-qdrant-repo/dist/index.js \
  --workspace-root /Users/mateuszkrupa/my-project \
  --collection code_chunks_my_project \
  --repo frontend --path /Users/mateuszkrupa/my-project/frontend \
  --repo backend --path /Users/mateuszkrupa/my-project/backend \
  reindex --repo backend || true
```

Verification:

```bash
node /Users/mateuszkrupa/global-qdrant-repo/dist/index.js \
  --workspace-root /Users/mateuszkrupa/my-project \
  --collection code_chunks_my_project \
  --repo frontend --path /Users/mateuszkrupa/my-project/frontend \
  --repo backend --path /Users/mateuszkrupa/my-project/backend \
  reindex
```

Expected output includes:

```text
Reindex complete
  Files processed: <n>
  Chunks created: <n>
  Points upserted: <n>
  Points deleted: <n>
  Errors: 0
```

## Reindex From MCP Level

The MCP `reindex` tool is available on demand.

- incremental all configured repos: call `reindex` with `{}`
- incremental one repo: `{ "repo": "frontend" }`
- full one repo: `{ "repo": "frontend", "full": true }`

Expected MCP text response:

```text
Files processed: <n>
Chunks created: <n>
Points upserted: <n>
Points deleted: <n>
Errors: <n>
```

## AGENTS.md Additions

Add this section to each project `AGENTS.md`:

```md
## Qdrant Code Search Rules

- Use `search_code` first for intent-based code lookup.
- Use `get_file` to read candidate files before edits.
- Use `repo` filter when request is repo-specific.
- If results look stale after significant changes, run `reindex`.
- Prefer MCP `reindex` for on-demand refresh; hooks cover normal post-commit flow.
- Always cite file paths from tool results in answers.
```

## Troubleshooting

- Wrong collection data mixing:
  - Ensure each project uses distinct `--collection` value.
- Unknown repo errors:
  - Confirm repo is configured at startup with `--repo <name> --path <abs-path>`.
- Stale search:
  - Run MCP `reindex` with `full: true` for affected repo.
- `get_file` path denied:
  - Path resolves outside `--workspace-root`; use workspace-relative path.
