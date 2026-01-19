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

// ---- image settings (tuned faster) ----
const WEBP_QUALITY = Number(process.env.WEBP_QUALITY ?? 78);
const AVIF_QUALITY = Number(process.env.AVIF_QUALITY ?? 40);

// ↓ effort is the big speed knob
const WEBP_EFFORT = Number(process.env.WEBP_EFFORT ?? 4); // was 6
const AVIF_EFFORT = Number(process.env.AVIF_EFFORT ?? 4); // was 8

// you can also lower max size to reduce CPU (optional)
const MAX_WIDTH = Number(process.env.MAX_WIDTH ?? 2400);  // was 3000
const MAX_HEIGHT = Number(process.env.MAX_HEIGHT ?? 1600); // was 2000

// upload in memory (single file)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // smaller limit encouraged
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

// function buildSharpBase(buffer) {
//   return sharp(buffer, { failOn: "none" })
//     .rotate()
//     .resize({
//       width: MAX_WIDTH,
//       height: MAX_HEIGHT,
//       fit: "inside",
//       withoutEnlargement: true,
//     });
// }


async function buildSharpBase(buffer) {
  const meta = await sharp(buffer, { failOn: "none" }).metadata();

  // If EXIF orientation implies rotation, swap width/height for the "display" size
  const oriented =
    meta.orientation && meta.orientation >= 5 && meta.orientation <= 8;

  const w = meta.width ?? 1;
  const h = meta.height ?? 1;
  const displayW = oriented ? h : w;
  const displayH = oriented ? w : h;

  const isPortrait = displayH > displayW;

  const maxW = isPortrait ? 1600 : 2400;
  const maxH = isPortrait ? 3200 : 1600;

  return sharp(buffer, { failOn: "none" })
    .rotate() // apply EXIF orientation
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

/**
 * POST /convert
 * multipart/form-data:
 *   - image: file
 *   - name: optional base name (without ext)
 *
 * response: multipart/mixed with:
 *   part 1: image/webp
 *   part 2: image/avif
 */
app.post("/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: image)" });

    const baseName = makeBaseName(req.body?.name || req.file.originalname);

    const base = await buildSharpBase(req.file.buffer);


    // convert
    const webpBuf = await base.clone().webp({
      quality: WEBP_QUALITY,
      effort: WEBP_EFFORT,
      smartSubsample: true,
    }).toBuffer();

    const avifBuf = await base.clone().avif({
      quality: AVIF_QUALITY,
      effort: AVIF_EFFORT,
    }).toBuffer();

    // multipart response
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
