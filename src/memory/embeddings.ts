/**
 * Embeddings.
 *
 * Anthropic does not provide an embeddings endpoint and instead recommends
 * Voyage AI, so semantic memory is embedded with Voyage by default. Everything
 * downstream depends only on the {@link EmbeddingClient} interface, so the
 * provider is swappable.
 *
 * {@link HashEmbeddingClient} is a deterministic, dependency-free, offline
 * embedder used in tests and when no VOYAGE_API_KEY is configured. It is NOT
 * semantically meaningful — it only makes the pipeline runnable end-to-end
 * without a network call. Production paths use {@link VoyageEmbeddingClient}.
 */

export interface EmbeddingClient {
  /** Dimensionality of the vectors this client produces (must match the schema). */
  readonly dimension: number;
  /** Embed a batch of texts. `inputType` lets providers optimize query vs document. */
  embed(texts: string[], inputType: 'query' | 'document'): Promise<number[][]>;
}

export interface VoyageOptions {
  apiKey: string;
  model: string;
  dimension: number;
  baseUrl?: string;
}

export class VoyageEmbeddingClient implements EmbeddingClient {
  readonly dimension: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: VoyageOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.dimension = opts.dimension;
    this.baseUrl = opts.baseUrl ?? 'https://api.voyageai.com/v1';
  }

  async embed(texts: string[], inputType: 'query' | 'document'): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: inputType,
        output_dimension: this.dimension,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Voyage embeddings failed (${res.status}): ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    // Voyage returns items with an `index`; sort to guarantee input order.
    return json.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

export interface GeminiEmbeddingOptions {
  apiKey: string;
  model: string;
  dimension: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Gemini embeddings (https://ai.google.dev/gemini-api/docs/embeddings).
 *
 * Uses the batchEmbedContents endpoint and requests `outputDimensionality` so the
 * vectors match the pgvector column width (ARES_EMBEDDING_DIM). `inputType` maps
 * to the Gemini task type so query and document embeddings are optimized
 * separately, exactly like the Voyage client.
 */
export class GeminiEmbeddingClient implements EmbeddingClient {
  readonly dimension: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiEmbeddingOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.dimension = opts.dimension;
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[], inputType: 'query' | 'document'): Promise<number[][]> {
    if (texts.length === 0) return [];
    const taskType = inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    const modelPath = `models/${this.model}`;
    const res = await this.fetchImpl(
      `${this.baseUrl}/${modelPath}:batchEmbedContents`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: modelPath,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: this.dimension,
          })),
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini embeddings failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { embeddings?: { values: number[] }[] };
    const rows = json.embeddings ?? [];
    if (rows.length !== texts.length) {
      throw new Error(`Gemini embeddings returned ${rows.length} vectors for ${texts.length} inputs.`);
    }
    // Gemini's MRL truncation isn't renormalized; do it here so cosine distance is well-behaved.
    return rows.map((row) => normalize(row.values));
  }
}

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/**
 * Deterministic offline embedder. Hashes token trigrams into a fixed-width
 * bag-of-features vector and L2-normalizes it, so identical/overlapping text
 * lands near itself under cosine distance. Good enough to exercise retrieval in
 * tests; not a substitute for a real model.
 */
export class HashEmbeddingClient implements EmbeddingClient {
  constructor(readonly dimension: number = 1024) {}

  async embed(texts: string[], _inputType: 'query' | 'document'): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const tok of tokens) {
      for (let i = 0; i < tok.length - 1; i++) {
        const gram = tok.slice(i, i + 3);
        const idx = fnv1a(gram) % this.dimension;
        vec[idx]! += 1;
      }
      const idx = fnv1a(tok) % this.dimension;
      vec[idx]! += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
