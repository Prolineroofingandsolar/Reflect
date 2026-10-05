// Jarvis's built-in voice: Kokoro, a small, natural-sounding text-to-speech model that runs right
// here in the browser, so nothing has to be sent anywhere to speak. It runs in this worker so the
// HUD animations stay smooth while it works. The model downloads once (from Hugging Face) and the
// browser keeps it, so later starts are quick and it works offline.
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let loading = null;

async function load() {
  // WebGPU (Apple Silicon Macs, recent Chrome) is much faster; plain WebAssembly works everywhere else.
  const gpu = self.navigator?.gpu ? await self.navigator.gpu.requestAdapter().catch(() => null) : null;
  try {
    if (gpu) return await KokoroTTS.from_pretrained(MODEL, { dtype: "fp32", device: "webgpu" });
  } catch {}
  return KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "wasm" });
}

self.onmessage = async ({ data }) => {
  const { id, type, text, voice, speed } = data || {};
  try {
    loading ||= load().catch((error) => { loading = null; throw error; });
    const tts = await loading;
    if (type === "load") return self.postMessage({ id, ok: true });
    const audio = await tts.generate(String(text || ""), { voice, speed: speed || 1 });
    self.postMessage({ id, ok: true, blob: audio.toBlob() });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};
