import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import crypto from "node:crypto";
import sharp from "sharp";
import { configuredLegacyEnvVars, loadConfig } from "./config.mjs";
import { buildTenantAuth, requestId, safeBaseName } from "./security.mjs";
import { configureSharp, ConversionError, convertImage } from "./processor.mjs";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(JSON.stringify({ level: "ERROR", msg: "invalid_config", error: error.message }));
  process.exit(1);
}

if (config.tenants.length === 0) {
  console.error(JSON.stringify({ level: "ERROR", msg: "invalid_config", error: "TENANTS_JSON must contain at least one active API key" }));
  process.exit(1);
}

configureSharp(config);
const authenticate = buildTenantAuth(config.tenants);
let activeJobs = 0;
let shuttingDown = false;

const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

function log(level, fields) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, ...fields }));
}

for (const name of configuredLegacyEnvVars()) {
  log("WARN", { msg: "legacy_env_ignored", env: name });
}

function setBaseHeaders(res, id) {
  res.setHeader("X-Request-ID", id);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
}

function json(res, id, status, body) {
  setBaseHeaders(res, id);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function errorResponse(res, id, status, code, message) {
  json(res, id, status, { error: message, code, request_id: id });
}

function contentType(req) {
  return String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
}

function requestedFormats(req) {
  const raw = String(req.headers["x-output-formats"] || "webp").toLowerCase();
  const values = [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
  if (values.length === 0 || values.some((v) => !["webp", "avif"].includes(v))) {
    throw new ConversionError("invalid_formats", "X-Output-Formats must contain webp and/or avif", 400);
  }
  if (values.includes("avif") && !config.enableAvif) {
    throw new ConversionError("avif_disabled", "AVIF output is disabled", 400);
  }
  return values;
}

async function receiveBody(req, filePath) {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > config.maxUploadBytes) {
    throw new ConversionError("payload_too_large", `upload exceeds ${config.maxUploadBytes} bytes`, 413);
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > config.maxUploadBytes) {
        callback(new ConversionError("payload_too_large", `upload exceeds ${config.maxUploadBytes} bytes`, 413));
        return;
      }
      callback(null, chunk);
    },
  });

  const file = fs.createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  try {
    await pipeline(req, limiter, file);
  } catch (error) {
    file.destroy();
    throw error;
  }
  if (bytes === 0) throw new ConversionError("empty_body", "request body is empty", 400);
  return bytes;
}

function writePartHeader(res, boundary, headers) {
  res.write(`--${boundary}\r\n`);
  for (const [key, value] of Object.entries(headers)) res.write(`${key}: ${value}\r\n`);
  res.write("\r\n");
}

async function streamMultipart(res, id, baseName, result) {
  const boundary = `img_${crypto.randomBytes(12).toString("hex")}`;
  setBaseHeaders(res, id);
  res.statusCode = 200;
  res.setHeader("Content-Type", `multipart/mixed; boundary=${boundary}`);
  res.setHeader("X-Variant-Count", String(result.variants.length));

  const metadata = {
    request_id: id,
    input: result.input,
    variants: result.variants.map(({ filePath: _filePath, ...variant }) => variant),
  };
  writePartHeader(res, boundary, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": 'inline; name="metadata"',
  });
  res.write(JSON.stringify(metadata));
  res.write("\r\n");

  for (const variant of result.variants) {
    writePartHeader(res, boundary, {
      "Content-Type": `image/${variant.format}`,
      "Content-Disposition": `attachment; filename="${variant.fileName}"`,
      "X-Variant-Name": variant.name,
      "X-Variant-Format": variant.format,
    });
    await pipeline(fs.createReadStream(variant.filePath), res, { end: false });
    res.write("\r\n");
  }
  res.end(`--${boundary}--\r\n`);
}

async function handleConvert(req, res, id, tenant) {
  if (activeJobs >= config.maxActiveJobs) {
    res.setHeader("Retry-After", "1");
    errorResponse(res, id, 503, "converter_busy", "converter is at capacity; retry later");
    return;
  }

  const mime = contentType(req);
  if (!MIME_TYPES.has(mime)) {
    errorResponse(res, id, 415, "unsupported_media_type", "Content-Type must be image/jpeg, image/png, image/webp, or image/avif");
    return;
  }

  let formats;
  try {
    formats = requestedFormats(req);
  } catch (error) {
    errorResponse(res, id, error.status ?? 400, error.code ?? "bad_request", error.message);
    return;
  }

  activeJobs += 1;
  const started = process.hrtime.bigint();
  let tempDir;
  let inputBytes = 0;
  try {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "artist-convert-"));
    const inputPath = path.join(tempDir, "input");
    inputBytes = await receiveBody(req, inputPath);
    const baseName = safeBaseName(req.headers["x-filename"] || "image");
    const result = await convertImage({ inputPath, outputDir: tempDir, mime, baseName, formats, config });
    await streamMultipart(res, id, baseName, result);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    log("INFO", {
      msg: "conversion_complete",
      request_id: id,
      tenant,
      status: 200,
      input_bytes: inputBytes,
      input_width: result.input.width,
      input_height: result.input.height,
      variants: result.variants.length,
      output_bytes: result.variants.reduce((sum, v) => sum + v.bytes, 0),
      duration_ms: Number(durationMs.toFixed(2)),
    });
  } catch (error) {
    const status = error instanceof ConversionError ? error.status : 500;
    const code = error instanceof ConversionError ? error.code : "internal_error";
    const message = error instanceof ConversionError ? error.message : "conversion failed";
    if (!res.headersSent) errorResponse(res, id, status, code, message);
    else res.destroy();
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    log(status >= 500 ? "ERROR" : "WARN", {
      msg: "conversion_failed",
      request_id: id,
      tenant,
      status,
      code,
      input_bytes: inputBytes,
      duration_ms: Number(durationMs.toFixed(2)),
    });
  } finally {
    activeJobs -= 1;
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  const id = requestId(req.headers["x-request-id"]);
  setBaseHeaders(res, id);

  if (req.method === "GET" && req.url === "/health") {
    json(res, id, 200, { status: "ok" });
    return;
  }
  if (req.method === "GET" && req.url === "/ready") {
    if (shuttingDown) {
      errorResponse(res, id, 503, "shutting_down", "service is shutting down");
      return;
    }
    json(res, id, 200, {
      status: "ready",
      active_jobs: activeJobs,
      max_active_jobs: config.maxActiveJobs,
      sharp: sharp.versions.sharp,
      vips: sharp.versions.vips,
    });
    return;
  }

  const tenant = authenticate(req.headers["x-api-key"]);
  if (!tenant) {
    errorResponse(res, id, 401, "unauthorized", "invalid API key");
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/convert" || req.url === "/convert")) {
    await handleConvert(req, res, id, tenant);
    return;
  }

  errorResponse(res, id, 404, "not_found", "route not found");
});

server.requestTimeout = 60_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1000;
server.listen(config.port, "0.0.0.0", () => {
  log("INFO", {
    msg: "converter_listening",
    port: config.port,
    max_active_jobs: config.maxActiveJobs,
    avif_enabled: config.enableAvif,
    node: process.version,
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips,
  });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("INFO", { msg: "shutdown_started", signal, active_jobs: activeJobs });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
