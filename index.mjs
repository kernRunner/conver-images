import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import crypto from "node:crypto";

// ---- config ----
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/data/images";

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://img-api.marcohuber-web.site/images").replace(/\/+$/, "");

const OUTPUTS = ["webp", "avif"];
const WEBP_QUALITY = 78;
const AVIF_QUALITY = 40;
const WEBP_EFFORT = 6;
const AVIF_EFFORT = 8;

const MAX_WIDTH = 3000;
const MAX_HEIGHT = 2000;

const app = express();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

app.use((req, res, next) => {
  // allow public endpoints
  if (req.path === "/health" || req.path.startsWith("/images")) return next();

  // protect everything else (including /upload)
  const token = req.header("x-admin-token");
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

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

    let folder = "";
    try {
      folder = sanitizeFolder(req.body.folder);
    } catch {
      return res.status(400).json({ error: "Invalid folder" });
    }

    const outDir = path.join(OUTPUT_DIR, folder);
    await ensureDir(outDir);
    const resolvedBase = path.resolve(OUTPUT_DIR);
    const resolvedOut = path.resolve(outDir);
    if (!resolvedOut.startsWith(resolvedBase + path.sep) && resolvedOut !== resolvedBase) {
      return res.status(400).json({ error: "Invalid folder" });
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

    const results = {};

    for (const ext of OUTPUTS) {
      const outPath = path.join(outDir, `${baseName}.${ext}`);
      await pipeline(base.clone(), ext).toFile(outPath);

      const url = `${PUBLIC_BASE_URL}${folder ? `/${folder}` : ""}/${baseName}.${ext}`;
      results[ext] = url;
    }

    return res.json({ ok: true, folder, files: results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Conversion failed" });
  }
});

function sanitizeFolder(input) {
  const raw = (input || "").toString().trim();

  if (!raw) return ""; // allow root

  // normalize slashes and remove leading/trailing slashes
  const cleaned = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

  // reject traversal or absolute-ish paths
  if (cleaned.includes("..") || cleaned.startsWith(".") || cleaned.includes("\0")) {
    throw new Error("Invalid folder");
  }

  // allow only safe characters per segment: a-z A-Z 0-9 _ - /
  if (!/^[a-zA-Z0-9/_-]+$/.test(cleaned)) {
    throw new Error("Invalid folder");
  }

  return cleaned;
}


app.get("/health", (_req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Image service running on :${port}`));


app.get("/admin/images", async (req, res) => {
  const token = req.header("x-admin-token");
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  async function walk(dir, base = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let files = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        files.push(...await walk(path.join(dir, e.name), `${base}${e.name}/`));
      } else {
        files.push(`${base}${e.name}`);
      }
    }
    return files;
  }

  const files = await walk(OUTPUT_DIR);
  res.json({ files });
});