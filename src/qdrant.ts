import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";

function getCollectionName(): string {
  return process.env.QDRANT_COLLECTION || "code_chunks";
}

let client: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (!client) {
    const url = process.env.QDRANT_URL || "http://localhost:6333";
    const apiKey = process.env.QDRANT_API_KEY || undefined;
    client = new QdrantClient(apiKey ? { url, apiKey } : { url });
  }
  return client;
}

export async function ensureCollection(): Promise<void> {
  const qd = getQdrantClient();
  const dims = parseInt(process.env.EMBEDDER_DIMENSIONS || "1536", 10);
  try {
    const info = await qd.getCollection(getCollectionName());
    const config = (info.config?.params?.vectors as { size?: number } | undefined) ??
      (info.config?.params?.vectors as Record<string, { size?: number }>);
    const existingSize = typeof config === "object" && "size" in config ? config.size : undefined;
    if (existingSize && existingSize !== dims) {
      await qd.deleteCollection(getCollectionName());
      await qd.createCollection(getCollectionName(), {
        vectors: { size: dims, distance: "Cosine" },
        on_disk_payload: true,
      });
    }
  } catch {
    await qd.createCollection(getCollectionName(), {
      vectors: { size: dims, distance: "Cosine" },
      on_disk_payload: true,
    });
  }
}

const UPSERT_BATCH_SIZE = 200;

export async function upsertChunks(
  chunks: Array<{
    id: string;
    vector: number[];
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
        vector: c.vector,
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

export async function search(
  vector: number[],
  repo?: string,
  limit: number = 10,
): Promise<Schemas["ScoredPoint"][]> {
  const qd = getQdrantClient();
  return qd.search(getCollectionName(), {
    vector,
    limit,
    with_payload: true,
    with_vector: false,
    ...(repo
      ? { filter: { must: [{ key: "repo", match: { value: repo } }] } }
      : {}),
  });
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
