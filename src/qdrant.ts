import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";
import type { SparseVector } from "./sparse.js";

const DENSE_VECTOR_NAME = "dense";
const SPARSE_VECTOR_NAME = "bm25";

function getCollectionName(): string {
  return process.env.QDRANT_COLLECTION || "code_chunks";
}

let client: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (!client) {
    const url = process.env.QDRANT_URL || "http://localhost:6333";
    const apiKey = process.env.QDRANT_API_KEY || undefined;
    // checkCompatibility=false: the client/server minor-version check only logs
    // noisy warnings on stderr (which pollutes MCP stdio); we manage versions ourselves.
    client = new QdrantClient({ url, checkCompatibility: false, ...(apiKey ? { apiKey } : {}) });
  }
  return client;
}

export async function ensureCollection(): Promise<void> {
  const qd = getQdrantClient();
  const dims = parseInt(process.env.EMBEDDER_DIMENSIONS || "1536", 10);
  const collectionConfig = {
    vectors: { [DENSE_VECTOR_NAME]: { size: dims, distance: "Cosine" as const } },
    sparse_vectors: {
      [SPARSE_VECTOR_NAME]: {
        modifier: "idf" as const,
        index: { on_disk: true },
      },
    },
    on_disk_payload: true,
  };

  try {
    const info = await qd.getCollection(getCollectionName());
    const vectors = info.config?.params?.vectors as
      | { size?: number }
      | Record<string, { size?: number }>
      | undefined;
    const sparseVectors = info.config?.params?.sparse_vectors as
      | Record<string, unknown>
      | null
      | undefined;
    const existingDenseSize =
      vectors && typeof vectors === "object" && DENSE_VECTOR_NAME in vectors
        ? (vectors as Record<string, { size?: number }>)[DENSE_VECTOR_NAME]?.size
        : undefined;
    const hasSparseVector = !!sparseVectors?.[SPARSE_VECTOR_NAME];

    if (existingDenseSize !== dims || !hasSparseVector) {
      await qd.deleteCollection(getCollectionName());
      await qd.createCollection(getCollectionName(), collectionConfig);
    }
  } catch {
    await qd.createCollection(getCollectionName(), collectionConfig);
  }

  await ensurePayloadIndexes();
}

/** Keyword indexes for the fields we filter on. Idempotent — errors mean the index already exists. */
async function ensurePayloadIndexes(): Promise<void> {
  const qd = getQdrantClient();
  for (const field of ["kind", "memoryType", "repo"]) {
    try {
      await qd.createPayloadIndex(getCollectionName(), {
        field_name: field,
        field_schema: "keyword",
      });
    } catch {
      // already indexed
    }
  }
}

const UPSERT_BATCH_SIZE = 200;

export async function upsertChunks(
  chunks: Array<{
    id: string;
    vector: number[];
    sparseVector: SparseVector;
    payload: Record<string, unknown>;
  }>,
): Promise<void> {
  const qd = getQdrantClient();
  for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
    const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE);
    await qd.upsert(getCollectionName(), {
      wait: true,
      points: batch.map((c) => ({
        id: c.id,
        vector: {
          [DENSE_VECTOR_NAME]: c.vector,
          [SPARSE_VECTOR_NAME]: c.sparseVector,
        },
        payload: c.payload,
      })),
    });
  }
}

export async function deleteByFilePath(filePath: string): Promise<void> {
  const qd = getQdrantClient();
  await qd.delete(getCollectionName(), {
    wait: true,
    filter: {
      must: [{ key: "filePath", match: { value: filePath } }],
    },
  });
}

export async function deleteByRepoAndFilePath(repo: string, filePath: string): Promise<void> {
  const qd = getQdrantClient();
  await qd.delete(getCollectionName(), {
    wait: true,
    filter: {
      must: [
        { key: "repo", match: { value: repo } },
        { key: "filePath", match: { value: filePath } },
      ],
    },
  });
}

export async function deleteByRepo(repo: string): Promise<void> {
  const qd = getQdrantClient();
  await qd.delete(getCollectionName(), {
    wait: true,
    filter: {
      must: [{ key: "repo", match: { value: repo } }],
    },
  });
}

export interface SearchFilters {
  repo?: string;
  /** Restrict to a partition, e.g. "memory". */
  kind?: string;
  /** Restrict memory results to a single type, e.g. "pitfall". */
  memoryType?: string;
  /** Drop the "memory" partition (used by code search for a clean split). */
  excludeMemory?: boolean;
}

function buildFilter(filters: SearchFilters): Record<string, unknown> | undefined {
  const must: Array<Record<string, unknown>> = [];
  if (filters.repo) must.push({ key: "repo", match: { value: filters.repo } });
  if (filters.kind) must.push({ key: "kind", match: { value: filters.kind } });
  if (filters.memoryType) must.push({ key: "memoryType", match: { value: filters.memoryType } });

  const mustNot: Array<Record<string, unknown>> = [];
  if (filters.excludeMemory) mustNot.push({ key: "kind", match: { value: "memory" } });

  if (must.length === 0 && mustNot.length === 0) return undefined;
  return {
    ...(must.length ? { must } : {}),
    ...(mustNot.length ? { must_not: mustNot } : {}),
  };
}

export async function search(
  vector: number[],
  sparseVector: SparseVector,
  filters: SearchFilters = {},
  limit: number = 10,
): Promise<Schemas["ScoredPoint"][]> {
  const qd = getQdrantClient();
  const filter = buildFilter(filters);
  const response = await qd.query(getCollectionName(), {
    prefetch: [
      {
        query: vector,
        using: DENSE_VECTOR_NAME,
        limit,
        ...(filter ? { filter } : {}),
      },
      {
        query: sparseVector,
        using: SPARSE_VECTOR_NAME,
        limit,
        ...(filter ? { filter } : {}),
      },
    ],
    query: { fusion: "rrf" },
    limit,
    with_payload: true,
    with_vector: false,
  });
  return response.points;
}

export async function countByRepoAndFilePath(repo: string, filePath: string): Promise<number> {
  const qd = getQdrantClient();
  const result = await qd.count(getCollectionName(), {
    filter: {
      must: [
        { key: "repo", match: { value: repo } },
        { key: "filePath", match: { value: filePath } },
      ],
    },
  });
  return result.count;
}
