import express from "express";
import multer from "multer";
import sharp from "sharp";
import crypto from "node:crypto";
import archiver from "archiver";

const app = express();

// ---- tenant auth ----
const TENANTS_JSON = process.env.TENANTS_JSON || "{}";
let TENANTS = {};
try {
  TENANTS = JSON.parse(TENANTS_JSON);
} catch {
  console.error("❌ TENANTS_JSON is not valid JSON");
  process.exit(1);
}

function getTenantFromApiKey(apiKey) {
  const entry = TENANTS[apiKey];
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && typeof entry.tenant === "string") return entry.tenant;
  return null;
}

// ---- image settings ----
const OUTPUTS = ["webp", "avif"];
const WEBP_QUALITY = 78;
const AVIF_QUALITY = 40;
const WEBP_EFFORT = 6;
const AVIF_EFFORT = 8;

const MAX_WIDTH = 3000;
const MAX_HEIGHT = 2000;

// upload in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

function pipeline(img, ext) {
  if (ext === "webp") {
    return img.webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT, smartSubsample: true });
  }
  if (ext === "avif") {
    return img.avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT });
  }
  throw new Error(`Unsupported output: ${ext}`);
}

function makeBaseName(originalName = "image") {
  const safe = originalName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_.]/g, "");
  const base = safe.replace(/\.[^.]+$/, "") || "image";
  const id = crypto.randomBytes(6).toString("hex");
  return `${base}-${id}`;
}

// ---- auth middleware ----
app.use((req, res, next) => {
  if (req.path === "/health") return next();

  const apiKey = req.header("x-api-key");
  const tenant = getTenantFromApiKey(apiKey);

  if (!tenant) return res.status(401).json({ error: "unauthorized" });

  req.tenant = tenant; // not strictly needed, but useful for logging later
  next();
});

app.get("/health", (_req, res) => res.send("ok"));

/**
 * POST /convert
 * multipart/form-data:
 *   - image: file
 *   - name: optional base name (without ext)
 *
 * response: application/zip containing:
 *   <base>.webp
 *   <base>.avif
 */
app.post("/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: image)" });

    const baseName = makeBaseName(req.body?.name || req.file.originalname);

    const base = sharp(req.file.buffer, { failOn: "none" })
      .rotate()
      .resize({
        width: MAX_WIDTH,
        height: MAX_HEIGHT,
        fit: "inside",
        withoutEnlargement: true,
      });

    // convert to buffers (no disk)
    const buffers = {};
    for (const ext of OUTPUTS) {
      buffers[ext] = await pipeline(base.clone(), ext).toBuffer();
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("ZIP error:", err);
      if (!res.headersSent) res.status(500).end("zip error");
      else res.end();
    });

    archive.pipe(res);
    archive.append(buffers.webp, { name: `${baseName}.webp` });
    archive.append(buffers.avif, { name: `${baseName}.avif` });
    await archive.finalize();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Conversion failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Converter running on :${port}`));
