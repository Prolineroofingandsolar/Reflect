// Who's speaking: turns a few seconds of someone's voice into a "voiceprint" (a list of 512 numbers
// that sounds-alike voices share) with WavLM, a small speaker-recognition model that runs right here
// in the browser. Nothing is sent anywhere. Like the Kokoro voice, it runs in its own worker so the
// HUD stays smooth, and the model downloads once (from Hugging Face) and is kept by the browser.
import { AutoProcessor, WavLMForXVector } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";

const MODEL = "Xenova/wavlm-base-plus-sv";
let loading = null;

async function load() {
  const processor = await AutoProcessor.from_pretrained(MODEL);
  let model;
  try { model = await WavLMForXVector.from_pretrained(MODEL, { dtype: "q8", device: "wasm" }); }
  catch { model = await WavLMForXVector.from_pretrained(MODEL, { dtype: "fp32", device: "wasm" }); }
  return { processor, model };
}

self.onmessage = async ({ data }) => {
  const { id, type, audio } = data || {};
  try {
    loading ||= load().catch((error) => { loading = null; throw error; });
    const { processor, model } = await loading;
    if (type === "load") return self.postMessage({ id, ok: true });
    // audio: mono Float32Array at 16 kHz.
    const inputs = await processor(audio);
    const { embeddings } = await model(inputs);
    self.postMessage({ id, ok: true, embedding: Array.from(embeddings.data) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};
