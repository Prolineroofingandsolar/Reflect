import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds one ES module (dist/smarthome.js) plus its stylesheet, loaded by index.html.
// The output is committed, so the mirror runs it with no install or build of its own.
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: "esbuild",
    cssCodeSplit: false,
    lib: { entry: "src/main.jsx", formats: ["es"], fileName: () => "smarthome.js" },
    rollupOptions: { output: { inlineDynamicImports: true, assetFileNames: (a) => (a.name?.endsWith(".css") ? "smarthome.css" : "[name][extname]") } }
  }
});
