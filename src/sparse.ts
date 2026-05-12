export interface SparseVector {
  indices: number[];
  values: number[];
}

const MAX_TERMS = parseInt(process.env.BM25_MAX_TERMS || "512", 10);

function hashTerm(term: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) {
    hash ^= term.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function splitIdentifier(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 2);
}

function tokenize(text: string): string[] {
  const matches = text.match(/[A-Za-z][A-Za-z0-9_\-.]*|[0-9]+/g) ?? [];
  const tokens: string[] = [];

  for (const match of matches) {
    const lower = match.toLowerCase();
    if (lower.length >= 2) tokens.push(lower);
    tokens.push(...splitIdentifier(match));
  }

  return tokens;
}

export function createSparseVector(text: string): SparseVector {
  const termFrequency = new Map<number, number>();
  for (const token of tokenize(text)) {
    const index = hashTerm(token);
    termFrequency.set(index, (termFrequency.get(index) ?? 0) + 1);
  }

  const entries = [...termFrequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TERMS)
    .sort((a, b) => a[0] - b[0]);

  return {
    indices: entries.map(([index]) => index),
    values: entries.map(([, frequency]) => Math.log1p(frequency)),
  };
}
