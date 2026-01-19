import express from "express";
import multer from "multer";
import sharp from "sharp";
import crypto from "node:crypto";

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
const WEBP_QUALITY = Number(process.env.WEBP_QUALITY ?? 78);
const AVIF_QUALITY = Number(process.env.AVIF_QUALITY ?? 40);
const WEBP_EFFORT = Number(process.env.WEBP_EFFORT ?? 4);
const AVIF_EFFORT = Number(process.env.AVIF_EFFORT ?? 4);

const LANDSCAPE_MAX_W = Number(process.env.MAX_WIDTH ?? 2400);
const LANDSCAPE_MAX_H = Number(process.env.MAX_HEIGHT ?? 1600);
const PORTRAIT_MAX_W = Number(process.env.PORTRAIT_MAX_W ?? 1600);
const PORTRAIT_MAX_H = Number(process.env.PORTRAIT_MAX_H ?? 3200);

// upload in memory (single file)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 1,
  },
});

// ---- auth middleware ----
app.use((req, res, next) => {
  if (req.path === "/health") return next();

  const apiKey = req.header("x-api-key");
  const tenant = getTenantFromApiKey(apiKey);

  if (!tenant) return res.status(401).json({ error: "unauthorized" });

  req.tenant = tenant;
  next();
});

app.get("/health", (_req, res) => res.send("ok"));

function makeBaseName(originalName = "image") {
  const safe = originalName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_.]/g, "");
  const base = safe.replace(/\.[^.]+$/, "") || "image";
  const id = crypto.randomBytes(6).toString("hex");
  return `${base}-${id}`;
}

function isSwapOrientation(o) {
  // 5,6,7,8 mean rotated 90/270 (dimensions swap)
  return o === 5 || o === 6 || o === 7 || o === 8;
}

/**
 * Heuristic:
 * - If EXIF says "swap dims" (5-8) but the pixels are currently landscape (w>h),
 *   we should rotate (bake) to get a portrait image.
 * - If EXIF says swap dims but pixels are already portrait (h>=w),
 *   skip rotate to avoid double-rotation, and just reset orientation to 1.
 * - For 3/4 (180 flips), we also only apply if orientation != 1 AND we assume pixels likely uncorrected.
 *   If you ever see "upside down" issues, we can refine similarly.
 */
async function buildSharpBase(buffer) {
  const meta = await sharp(buffer, { failOn: "none" }).metadata();

  const o = meta.orientation ?? 1;
  const w = meta.width ?? 1;
  const h = meta.height ?? 1;

  const swap = isSwapOrientation(o);
  const shouldRotate =
    o !== 1 &&
    (
      // 90/270-type orientations: rotate only if pixels look un-rotated (landscape)
      (swap && w > h) ||
      // 180-type orientations: apply (usually safe). If this causes double-flip for some sources,
      // we can add a similar heuristic.
      (!swap && (o === 3 || o === 4))
    );

  const isPortraitAfter =
    swap ? (shouldRotate ? true : h > w) : h > w;

  const maxW = isPortraitAfter ? PORTRAIT_MAX_W : LANDSCAPE_MAX_W;
  const maxH = isPortraitAfter ? PORTRAIT_MAX_H : LANDSCAPE_MAX_H;

  let img = sharp(buffer, { failOn: "none" });

  if (shouldRotate) {
    // bake EXIF orientation into pixels (fixes phone portrait -> landscape issue)
    img = img.rotate();
  }

  return img
    // always reset orientation so outputs never depend on EXIF orientation
    .withMetadata({ orientation: 1 })
    .resize({
      width: maxW,
      height: maxH,
      fit: "inside",
      withoutEnlargement: true,
    });
}

// helper to write one multipart part
function writePart(res, boundary, headersObj, bodyBuf) {
  res.write(`--${boundary}\r\n`);
  for (const [k, v] of Object.entries(headersObj)) {
    res.write(`${k}: ${v}\r\n`);
  }
  res.write(`\r\n`);
  res.write(bodyBuf);
  res.write(`\r\n`);
}

app.post("/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (field name: image)" });
    }

    const baseName = makeBaseName(req.body?.name || req.file.originalname);
    const base = await buildSharpBase(req.file.buffer);

    const webpBuf = await base.clone().webp({
      quality: WEBP_QUALITY,
      effort: WEBP_EFFORT,
      smartSubsample: true,
    }).toBuffer();

    const avifBuf = await base.clone().avif({
      quality: AVIF_QUALITY,
      effort: AVIF_EFFORT,
    }).toBuffer();

    const boundary = "img_" + crypto.randomBytes(12).toString("hex");

    res.status(200);
    res.setHeader("Content-Type", `multipart/mixed; boundary=${boundary}`);
    res.setHeader("Cache-Control", "no-store");

    writePart(res, boundary, {
      "Content-Type": "image/webp",
      "Content-Disposition": `attachment; filename="${baseName}.webp"`,
      "X-File": `${baseName}.webp`,
    }, webpBuf);

    writePart(res, boundary, {
      "Content-Type": "image/avif",
      "Content-Disposition": `attachment; filename="${baseName}.avif"`,
      "X-File": `${baseName}.avif`,
    }, avifBuf);

    res.end(`--${boundary}--\r\n`);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Conversion failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Converter running on :${port}`));
