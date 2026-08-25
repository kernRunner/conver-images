import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const [file, requestsRaw = "50", concurrencyRaw = "1"] = process.argv.slice(2);
if (!file) {
  console.error("Usage: npm run benchmark:load -- <image-file> [requests=50] [concurrency=1]");
  process.exit(2);
}

const endpoint = process.env.CONVERTER_URL || "http://127.0.0.1:3000/v1/convert";
const apiKey = process.env.CONVERTER_API_KEY;
if (!apiKey) {
  console.error("CONVERTER_API_KEY is required");
  process.exit(2);
}

function positiveInt(raw, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`${name} must be a positive integer`);
    process.exit(2);
  }
  return value;
}

const requests = positiveInt(requestsRaw, "requests");
const concurrency = positiveInt(concurrencyRaw, "concurrency");
const body = await fs.readFile(file);
const ext = path.extname(file).slice(1).toLowerCase();
const mime = ({
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
})[ext];
if (!mime) {
  console.error(`unsupported benchmark input extension: .${ext}`);
  process.exit(2);
}

const formats = process.env.CONVERTER_FORMATS || "webp";
const busyRetryMs = positiveInt(process.env.BENCH_BUSY_RETRY_MS || "100", "BENCH_BUSY_RETRY_MS");
const maxRetries = positiveInt(process.env.BENCH_MAX_RETRIES || "10000", "BENCH_MAX_RETRIES");

const latencies = [];
let outputBytes = 0;
let nextJob = 0;
let completed = 0;
let busyResponses = 0;
let totalAttempts = 0;
let failures = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function convertOne(jobNumber) {
  const jobStarted = performance.now();
  let retries = 0;

  for (;;) {
    totalAttempts += 1;
    const requestStarted = performance.now();
    let response;
    let output;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": mime,
          "Content-Length": String(body.length),
          "X-API-Key": apiKey,
          "X-Filename": path.basename(file),
          "X-Output-Formats": formats,
          "X-Request-ID": `bench-${process.pid}-${jobNumber}-${retries}`,
        },
        body,
      });
      output = await response.arrayBuffer();
    } catch (error) {
      failures += 1;
      throw new Error(`job ${jobNumber}: request failed: ${error.message}`);
    }

    const attemptMs = performance.now() - requestStarted;
    if (response.status === 503) {
      let payload = null;
      try {
        payload = JSON.parse(new TextDecoder().decode(output));
      } catch {}
      if (payload?.code === "converter_busy") {
        busyResponses += 1;
        retries += 1;
        if (retries > maxRetries) {
          failures += 1;
          throw new Error(`job ${jobNumber}: exceeded ${maxRetries} busy retries`);
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : busyRetryMs;
        await sleep(waitMs);
        continue;
      }
    }

    if (!response.ok) {
      failures += 1;
      throw new Error(`job ${jobNumber}: HTTP ${response.status}: ${new TextDecoder().decode(output)}`);
    }

    const endToEndMs = performance.now() - jobStarted;
    latencies.push(endToEndMs);
    outputBytes += output.byteLength;
    completed += 1;
    console.log(
      `${completed}/${requests}: job=${jobNumber} e2e=${endToEndMs.toFixed(1)}ms ` +
      `attempt=${attemptMs.toFixed(1)}ms retries=${retries} bytes=${output.byteLength}`,
    );
    return;
  }
}

async function worker() {
  for (;;) {
    const jobNumber = nextJob;
    nextJob += 1;
    if (jobNumber >= requests) return;
    await convertOne(jobNumber + 1);
  }
}

const wallStarted = performance.now();
try {
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, () => worker()));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const wallMs = performance.now() - wallStarted;

const sorted = [...latencies].sort((a, b) => a - b);
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
const throughputPerSecond = completed / (wallMs / 1000);

console.log(JSON.stringify({
  endpoint,
  input_file: path.basename(file),
  input_bytes: body.length,
  formats,
  requests,
  concurrency,
  completed,
  failures,
  total_attempts: totalAttempts,
  busy_responses: busyResponses,
  wall_ms: Number(wallMs.toFixed(2)),
  throughput_images_per_second: Number(throughputPerSecond.toFixed(3)),
  throughput_images_per_minute: Number((throughputPerSecond * 60).toFixed(2)),
  latency_mean_ms: Number(mean.toFixed(2)),
  latency_p50_ms: Number(percentile(0.50).toFixed(2)),
  latency_p95_ms: Number(percentile(0.95).toFixed(2)),
  latency_max_ms: Number(sorted.at(-1).toFixed(2)),
  response_bytes_mean: Math.round(outputBytes / completed),
}, null, 2));
