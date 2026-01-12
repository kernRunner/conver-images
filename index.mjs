import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import crypto from "node:crypto";

// ---- config ----
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/data/images";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://img-api.marcohuber-web.site/images").replace(/\/+$/, "");

// API keys -> tenant mapping (JSON)
const TENANTS_JSON = process.env.TENANTS_JSON || "{}";
let TENANTS = {};
try {
  TENANTS = JSON.parse(TENANTS_JSON);
} catch {
  console.error("❌ TENANTS_JSON is not valid JSON");
  process.exit(1);
}

function getTenantFromApiKey(apiKey) {
  if (!apiKey) return null;

  // support two shapes:
  // 1) { "key123": { "tenant": "clientA" } }
  // 2) { "key123": "clientA" }
  const entry = TENANTS[apiKey];
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && typeof entry.tenant === "string") return entry.tenant;
  return null;
}

const OUTPUTS = ["webp", "avif"];
const WEBP_QUALITY = 78;
const AVIF_QUALITY = 40;
const WEBP_EFFORT = 6;
const AVIF_EFFORT = 8;

const MAX_WIDTH = 3000;
const MAX_HEIGHT = 2000;

const app = express();

// serve converted images publicly
app.use("/images", express.static(OUTPUT_DIR));

// store upload in memory
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
    .replace(/[^a-z0-9-_.]/g, "");
  const base = name.replace(path.extname(name), "") || "image";
  const id = crypto.randomBytes(6).toString("hex");
  return `${base}-${id}`;
}

function sanitizeFolder(input) {
  const raw = (input || "").toString().trim();
  if (!raw) return "";

  const cleaned = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

  if (cleaned.includes("..") || cleaned.startsWith(".") || cleaned.includes("\0")) {
    throw new Error("Invalid folder");
  }

  if (!/^[a-zA-Z0-9/_-]+$/.test(cleaned)) {
    throw new Error("Invalid folder");
  }

  return cleaned;
}

function ensureInsideBase(baseDir, targetDir) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetDir);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new Error("Invalid path");
  }
}

// ---- auth middleware (multi-tenant) ----
app.use((req, res, next) => {
  // public endpoints
  if (req.path === "/health" || req.path.startsWith("/images")) return next();

  const apiKey = req.header("x-api-key");
  const tenant = getTenantFromApiKey(apiKey);

  if (!tenant) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // attach tenant to request
  req.tenant = tenant;
  next();
});

// Upload
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: image)" });

    const tenant = req.tenant; // set by middleware

    let folder = "";
    try {
      folder = sanitizeFolder(req.body.folder);
    } catch {
      return res.status(400).json({ error: "Invalid folder" });
    }

    // tenant folder is server-controlled (client cannot escape)
    const outDir = path.join(OUTPUT_DIR, tenant, folder);
    ensureInsideBase(OUTPUT_DIR, outDir);
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

      // URL structure: /images/<tenant>/<folder>/<file>
      const url = `${PUBLIC_BASE_URL}/${tenant}${folder ? `/${folder}` : ""}/${baseName}.${ext}`;
      results[ext] = url;
    }

    return res.json({ ok: true, tenant, folder, files: results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Conversion failed" });
  }
});

// Admin list for current tenant only
app.get("/admin/images", async (req, res) => {
  try {
    const tenant = req.tenant;
    const tenantDir = path.join(OUTPUT_DIR, tenant);
    ensureInsideBase(OUTPUT_DIR, tenantDir);

    async function walk(dir, base = "") {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }

      let files = [];
      for (const e of entries) {
        if (e.isDirectory()) {
          files.push(...(await walk(path.join(dir, e.name), `${base}${e.name}/`)));
        } else {
          files.push(`${base}${e.name}`);
        }
      }
      return files;
    }

    const files = await walk(tenantDir);
    res.json({ tenant, files });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "List failed" });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Image service running on :${port}`));
