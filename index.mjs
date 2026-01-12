import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import crypto from "node:crypto";

const app = express();

// ---- config ----
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/data/images";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://img-api.marcohuber-web.site/images")
  .replace(/\/+$/, "");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const OUTPUTS = ["webp", "avif"];
const WEBP_QUALITY = 78;
const AVIF_QUALITY = 40;
const WEBP_EFFORT = 6;
const AVIF_EFFORT = 8;

const MAX_WIDTH = 3000;
const MAX_HEIGHT = 2000;

// ---- auth middleware ----
app.use((req, res, next) => {
  // public endpoints
  if (req.path === "/health" || req.path.startsWith("/images")) return next();

  // protect everything else (including /upload)
  const token = req.header("x-admin-token");
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
});

// serve converted images
app.use("/images", express.static(OUTPUT_DIR));

// upload in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function pipeline(img, ext) {
  if (ext === "webp") {
    return img.webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT, smartSubsample: true });
  }
  if (ext === "avif") {
    return img.avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT });
  }
  throw new Error(`Unsupported output: ${ext}`);
}

function makeSafeBaseName(originalName) {
  const name = (originalName || "image")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_.]/g, "");

  const base = name.replace(path.extname(name), "") || "image";
  const id = crypto.randomBytes(6).toString("hex");
  return `${base}-${id}`;
}

function sanitizeFolder(input) {
  const raw = (input || "").toString().trim();
  if (!raw) return "";

  const cleaned = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

  // block traversal
  if (cleaned.includes("..") || cleaned.startsWith(".") || cleaned.includes("\0")) {
    throw new Error("Invalid folder");
  }

  // allow only safe chars
  if (!/^[a-zA-Z0-9/_-]+$/.test(cleaned)) {
    throw new Error("Invalid folder");
  }

  return cleaned;
}

app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded (field: image)" });

    let folder = "";
    try {
      folder = sanitizeFolder(req.body.folder);
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid folder" });
    }

    const outDir = path.join(OUTPUT_DIR, folder);
    await ensureDir(outDir);

    // extra safety: ensure outDir is inside OUTPUT_DIR
    const resolvedBase = path.resolve(OUTPUT_DIR);
    const resolvedOut = path.resolve(outDir);
    if (!resolvedOut.startsWith(resolvedBase + path.sep) && resolvedOut !== resolvedBase) {
      return res.status(400).json({ ok: false, error: "Invalid folder" });
    }

    const baseName = makeSafeBaseName(req.file.originalname);

    const base = sharp(req.file.buffer, { failOn: "none" })
      .rotate()
      .resize({
        width: MAX_WIDTH,
        height: MAX_HEIGHT,
        fit: "inside",
        withoutEnlargement: true,
      });

    const files = {};

    for (const ext of OUTPUTS) {
      const outPath = path.join(outDir, `${baseName}.${ext}`);
      await pipeline(base.clone(), ext).toFile(outPath);

      const url = `${PUBLIC_BASE_URL}${folder ? `/${folder}` : ""}/${baseName}.${ext}`;
      files[ext] = url;
    }

    return res.json({ ok: true, folder, files });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Conversion failed" });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Image service running on :${port}`));
