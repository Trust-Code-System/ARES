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
