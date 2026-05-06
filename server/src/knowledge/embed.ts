import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL = "Xenova/bge-small-en-v1.5";

let _pipe: FeatureExtractionPipeline | null = null;

async function getPipe(): Promise<FeatureExtractionPipeline> {
  if (!_pipe) {
    _pipe = await pipeline("feature-extraction", MODEL, { dtype: "fp32" });
  }
  return _pipe;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = await getPipe();
  const output = await pipe(texts, { pooling: "mean", normalize: true });
  // output.tolist() returns float[][]
  return output.tolist() as number[][];
}

export async function embedOne(text: string): Promise<number[]> {
  const results = await embed([text]);
  return results[0];
}
