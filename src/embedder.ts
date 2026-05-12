import OpenAI from "openai";

let _client: OpenAI | null = null;
let _model: string | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.EMBEDDER_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("EMBEDDER_API_KEY or OPENAI_API_KEY environment variable is required");
    }
    _client = new OpenAI({
      apiKey,
      baseURL: process.env.EMBEDDER_URL || undefined,
    });
    _model = process.env.EMBEDDER_MODEL || "text-embedding-3-small";
  }
  return _client;
}

function getModel(): string {
  getClient();
  return _model!;
}

const DEFAULT_BATCH_SIZE = parseInt(process.env.EMBEDDER_BATCH_SIZE || "100", 10);
const MAX_RETRIES = 5;
const TIMEOUT_MS = 60_000;

async function embedWithRetry(
  texts: string[],
  signal: AbortSignal,
): Promise<number[][]> {
  const client = getClient();
  const model = getModel();
  // Exponential backoff: start at 1s, double each retry, cap at 60s.
  // Retry only on HTTP 429 (rate limit) and 5xx server errors.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.embeddings.create(
        { model, input: texts },
        { signal },
      );
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    } catch (err: unknown) {
      const isRetryable =
        err instanceof OpenAI.RateLimitError ||
        err instanceof OpenAI.APIError;
      if (!isRetryable || attempt === MAX_RETRIES) throw err;

      const apiErr = err as InstanceType<typeof OpenAI.APIError>;
      if (
        apiErr.status !== 429 &&
        !(apiErr.status! >= 500 && apiErr.status! < 600)
      ) {
        throw err;
      }

      const delay = Math.min(1_000 * 2 ** attempt, 60_000);
      console.log(
        `[INFO] Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (status ${apiErr.status})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Unreachable");
}

function isContextWindowError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError) || err.status !== 400) return false;
  const text = JSON.stringify(err.error) + (err.message ?? "");
  return /context|ContextWindow|maximum context length/i.test(text);
}

export async function embed(
  texts: string[],
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (texts.length <= batchSize) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await embedWithRetry(texts, controller.signal);
    } catch (err: unknown) {
      if (texts.length > 1 && isContextWindowError(err)) {
        const mid = Math.floor(texts.length / 2);
        const left = await embed(texts.slice(0, mid), mid);
        const right = await embed(texts.slice(mid), mid);
        return left.concat(right);
      }
      if (texts.length === 1 && isContextWindowError(err)) {
        const safe = texts[0].slice(0, 8000);
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), TIMEOUT_MS);
        try {
          return await embedWithRetry([safe], controller2.signal);
        } finally {
          clearTimeout(timer2);
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  console.log(
    `[INFO] Embedding ${texts.length} texts in ${batches.length} batch(es) (batch size: ${batchSize})`,
  );

  const results: number[][] = [];

  for (let i = 0; i < batches.length; i++) {
    console.log(
      `[INFO] API call ${i + 1}/${batches.length}: embedding ${batches[i].length} texts`,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const vectors = await embedWithRetry(batches[i], controller.signal);
      results.push(...vectors);
    } catch (err: unknown) {
      if (isContextWindowError(err)) {
        const subResults = await embed(batches[i], Math.max(1, Math.floor(batches[i].length / 2)));
        results.push(...subResults);
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}