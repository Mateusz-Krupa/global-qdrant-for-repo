const RERANKER_PROVIDER = process.env.RERANKER_PROVIDER || "none";
const RERANKER_MODEL = process.env.RERANKER_MODEL || "rerank-english-v3.0";
const RERANKER_API_KEY = process.env.RERANKER_API_KEY || "";

const MAX_RETRIES = 5;
const TIMEOUT_MS = 30_000;
const COHERE_RERANK_URL = process.env.RERANKER_URL
  ? `${process.env.RERANKER_URL}/rerank`
  : "https://api.cohere.com/v2/rerank";

export function isRerankerEnabled(): boolean {
  return RERANKER_PROVIDER !== "none" && RERANKER_API_KEY.length > 0;
}

function passthrough(
  documents: Array<{ text: string; index: number }>,
  topN: number,
): number[] {
  return documents.slice(0, topN).map((d) => d.index);
}

async function rerankWithCohere(
  query: string,
  documents: Array<{ text: string; index: number }>,
  topN: number,
): Promise<number[]> {
  if (!RERANKER_API_KEY) {
    console.warn("[WARN] RERANKER_API_KEY is not set; falling back to passthrough");
    return passthrough(documents, topN);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(COHERE_RERANK_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RERANKER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: RERANKER_MODEL,
            query,
            documents: documents.map((d) => d.text),
            top_n: topN,
          }),
          signal: controller.signal,
        });

        if (response.status === 429) {
          if (attempt === MAX_RETRIES) {
            console.error(
              "[ERROR] Cohere rerank rate limit exhausted; falling back to passthrough",
            );
            return passthrough(documents, topN);
          }
          const delay = Math.min(1_000 * 2 ** attempt, 60_000);
          console.log(
            `[INFO] Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (status 429)`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "unknown");
          console.error(
            `[ERROR] Cohere rerank API error (${response.status}): ${body}; falling back to passthrough`,
          );
          return passthrough(documents, topN);
        }

        const data: { results: Array<{ index: number; relevance_score: number }> } =
          await response.json();
        return data.results.map((r) => r.index);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.error(
            "[ERROR] Cohere rerank request timed out; falling back to passthrough",
          );
          return passthrough(documents, topN);
        }
        console.error(
          "[ERROR] Cohere rerank request failed; falling back to passthrough",
          err,
        );
        return passthrough(documents, topN);
      }
    }

    return passthrough(documents, topN);
  } finally {
    clearTimeout(timer);
  }
}

export async function rerank(
  query: string,
  documents: Array<{ text: string; index: number }>,
  topN: number,
): Promise<number[]> {
  if (RERANKER_PROVIDER === "none" || !RERANKER_PROVIDER) {
    return passthrough(documents, topN);
  }

  if (RERANKER_PROVIDER === "cohere") {
    return rerankWithCohere(query, documents, topN);
  }

  console.warn(
    `[WARN] Unknown RERANKER_PROVIDER "${RERANKER_PROVIDER}"; falling back to passthrough`,
  );
  return passthrough(documents, topN);
}