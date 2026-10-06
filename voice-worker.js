// Jarvis's built-in voice: Kokoro, a small, natural-sounding text-to-speech model that runs right
// here in the browser, so nothing has to be sent anywhere to speak. It runs in this worker so the
// HUD animations stay smooth while it works. The model downloads once (from Hugging Face) and the
// browser keeps it, so later starts are quick and it works offline.
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let loading = null, engine = "";

async function load() {
  // WebGPU (Apple Silicon Macs, recent Chrome) is much faster; plain WebAssembly works everywhere else.
  const gpu = self.navigator?.gpu ? await self.navigator.gpu.requestAdapter().catch(() => null) : null;
  let tts = null;
  try {
    if (gpu) { tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "fp32", device: "webgpu" }); engine = "built-in voice on the graphics chip"; }
  } catch {}
  if (!tts) { tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "wasm" }); engine = "built-in voice on the processor"; }
  // The very first sentence is much slower than the rest while everything warms up, so say one
  // quietly to ourselves now rather than making the first real reply wait for it.
  await tts.generate("Good evening, sir.", { voice: "bm_george" }).catch(() => {});
  return tts;
}

self.onmessage = async ({ data }) => {
  const { id, type, text, voice, speed } = data || {};
  try {
    loading ||= load().catch((error) => { loading = null; throw error; });
    const tts = await loading;
    if (type === "load") return self.postMessage({ id, ok: true, engine });
    const audio = await tts.generate(String(text || ""), { voice, speed: speed || 1 });
    self.postMessage({ id, ok: true, blob: audio.toBlob() });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};
