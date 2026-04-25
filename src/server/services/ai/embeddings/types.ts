/**
 * Pluggable embedding-provider contract. Mirrors the LLM adapter pattern:
 * the surface stays minimal so a future swap from local Ollama to OpenAI
 * (or anything else) is a one-file change.
 *
 * `embed` returns a Float32 vector of `dim` length. Implementations are
 * responsible for normalizing if the underlying model isn't already
 * cosine-friendly — most retrieval-trained embeddings (mxbai, bge, gte,
 * nomic) emit unit-length vectors out of the box.
 */
export interface EmbeddingAdapter {
	readonly kind: "ollama" | "openai";
	readonly model: string;
	readonly dim: number;
	embed(input: string): Promise<Float32Array>;
	/** Some servers expose batch embedding. Optional — falls back to N calls. */
	embedBatch?(inputs: string[]): Promise<Float32Array[]>;
}

/**
 * Cosine similarity. Both vectors expected to be unit-normalized for the
 * common case; degrades gracefully if not (still gives a valid 0..1 score
 * after the 0.5 + dot/2 mapping below). Same length required.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) {
		throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Pack a Float32Array into a Buffer suitable for sqlite blob storage. */
export function vectorToBuffer(v: Float32Array): Buffer {
	return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Reverse: hand back a Float32Array view on a Buffer pulled from sqlite. */
export function bufferToVector(buf: Buffer): Float32Array {
	// Copy into a fresh ArrayBuffer to avoid alignment issues with the
	// shared underlying buffer that sqlite returns.
	const copy = new Uint8Array(buf.byteLength);
	copy.set(buf);
	return new Float32Array(
		copy.buffer,
		copy.byteOffset,
		copy.byteLength / Float32Array.BYTES_PER_ELEMENT,
	);
}
