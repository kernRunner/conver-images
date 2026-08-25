import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

const [file, iterationsRaw = "5"] = process.argv.slice(2);
if (!file) {
  console.error("Usage: npm run benchmark -- <image-file> [iterations]");
  process.exit(2);
}
const endpoint = process.env.CONVERTER_URL || "http://127.0.0.1:3000/v1/convert";
const apiKey = process.env.CONVERTER_API_KEY;
if (!apiKey) {
  console.error("CONVERTER_API_KEY is required");
  process.exit(2);
}
const body = await fs.readFile(file);
const iterations = Math.max(1, Number(iterationsRaw));
const ext = file.toLowerCase().split(".").pop();
const mime = ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" })[ext];
if (!mime) throw new Error("unsupported benchmark input extension");

const samples = [];
for (let i = 0; i < iterations; i += 1) {
  const start = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": mime,
      "Content-Length": String(body.length),
      "X-API-Key": apiKey,
      "X-Filename": file.split(/[\\/]/).pop(),
      "X-Output-Formats": process.env.CONVERTER_FORMATS || "webp",
    },
    body,
  });
  const output = await response.arrayBuffer();
  const ms = performance.now() - start;
  if (!response.ok) {
    console.error(new TextDecoder().decode(output));
    process.exit(1);
  }
  samples.push({ ms, bytes: output.byteLength });
  console.log(`${i + 1}/${iterations}: ${ms.toFixed(1)} ms, ${output.byteLength} bytes`);
}
const values = samples.map((s) => s.ms).sort((a, b) => a - b);
const mean = values.reduce((a, b) => a + b, 0) / values.length;
const p95 = values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)];
console.log(JSON.stringify({
  iterations,
  mean_ms: Number(mean.toFixed(2)),
  p95_ms: Number(p95.toFixed(2)),
  response_bytes_mean: Math.round(samples.reduce((a, b) => a + b.bytes, 0) / samples.length),
}, null, 2));
