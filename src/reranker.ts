const RERANKER_PROVIDER = process.env.RERANKER_PROVIDER || "none";
const RERANKER_MODEL = process.env.RERANKER_MODEL || "rerank-english-v3.0";
const RERANKER_API_KEY = process.env.RERANKER_API_KEY || "";

const MAX_RETRIES = 5;
const TIMEOUT_MS = 30_000;
function getRerankUrl(): string {
  const baseUrl = process.env.RERANKER_URL;
  if (!baseUrl) return "https://api.cohere.com/v2/rerank";
  return `${baseUrl.replace(/\/$/, "")}/rerank`;
}

export function isRerankerEnabled(): boolean {
  return RERANKER_PROVIDER !== "none" && RERANKER_API_KEY.length > 0;
}

function passthrough(
  documents: Array<{ text: string; index: number }>,
  topN: number,
): number[] {
  return documents.slice(0, topN).map((d) => d.index);
}

function parseRerankResponse(data: unknown): number[] | null {
  if (!data || typeof data !== "object") return null;

  const body = data as {
    results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
    data?: Array<{ index?: number; relevance_score?: number; score?: number }>;
  };
  const results = body.results ?? body.data;
  if (!Array.isArray(results)) return null;

  return results
    .filter((result): result is { index: number; relevance_score?: number; score?: number } =>
      typeof result.index === "number",
    )
    .sort((a, b) => (b.relevance_score ?? b.score ?? 0) - (a.relevance_score ?? a.score ?? 0))
    .map((result) => result.index);
}

async function rerankWithHttpProvider(
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
        const response = await fetch(getRerankUrl(), {
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
              "[ERROR] Rerank rate limit exhausted; falling back to passthrough",
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
            `[ERROR] Rerank API error (${response.status}): ${body}; falling back to passthrough`,
          );
          return passthrough(documents, topN);
        }

        const data = await response.json();
        const indices = parseRerankResponse(data);
        if (!indices) {
          console.error(
            "[ERROR] Rerank API response did not include ranked indices; falling back to passthrough",
          );
          return passthrough(documents, topN);
        }
        return indices.slice(0, topN);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.error(
            "[ERROR] Rerank request timed out; falling back to passthrough",
          );
          return passthrough(documents, topN);
        }
        console.error(
          "[ERROR] Rerank request failed; falling back to passthrough",
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

  if (["cohere", "maas", "openai-compatible"].includes(RERANKER_PROVIDER)) {
    return rerankWithHttpProvider(query, documents, topN);
  }

  console.warn(
    `[WARN] Unknown RERANKER_PROVIDER "${RERANKER_PROVIDER}"; falling back to passthrough`,
  );
  return passthrough(documents, topN);
}
