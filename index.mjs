import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import crypto from "node:crypto";

// ---- config ----
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/data/images";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://https://template2.marcohuber-web.site/images";

const OUTPUTS = ["webp", "avif"];
const WEBP_QUALITY = 78;
const AVIF_QUALITY = 40;
const WEBP_EFFORT = 6;
const AVIF_EFFORT = 8;

const MAX_WIDTH = 3000;
const MAX_HEIGHT = 2000;

const app = express();

// serve converted images (useful for local testing)
app.use("/images", express.static(OUTPUT_DIR));

// store upload in memory (fast, simple); if you expect huge files, use diskStorage
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
  const name = originalName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_.]/g, ""); // slightly simpler/safer

  const base = name.replace(path.extname(name), "") || "image";
  const id = crypto.randomBytes(6).toString("hex");
  return `${base}-${id}`;
}

app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: image)" });

    const folder = (req.body.folder || "").toString().replace(/^\/+|\/+$/g, "");
    const outDir = path.join(OUTPUT_DIR, folder);
    await ensureDir(outDir);

    const baseName = makeSafeBaseName(req.file.originalname);

    const base = sharp(req.file.buffer, { failOn: "none" })
      .rotate()
      .resize({
        width: MAX_WIDTH,
        height: MAX_HEIGHT,
        fit: "inside",
        withoutEnlargement: true,
      });

    const results = {};

    for (const ext of OUTPUTS) {
      const outPath = path.join(outDir, `${baseName}.${ext}`);
      await pipeline(base.clone(), ext).toFile(outPath);

      const urlPath = [PUBLIC_BASE_URL, folder, `${baseName}.${ext}`]
        .filter(Boolean)
        .join("/")
        .replace(/\/+/g, "/")
        .replace("https:/", "https://")
        .replace("http:/", "http://"); // allows local http too

      results[ext] = urlPath;
    }

    return res.json({ ok: true, folder, files: results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Conversion failed" });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Image service running on :${port}`));
