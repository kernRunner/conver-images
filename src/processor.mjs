import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const MIME_TO_FORMATS = new Map([
  ["image/jpeg", new Set(["jpeg", "jpg"])],
  ["image/png", new Set(["png"])],
  ["image/webp", new Set(["webp"])],
  ["image/avif", new Set(["avif", "heif"])],
]);

export class ConversionError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function effectiveDimensions(meta) {
  const orientation = meta.orientation ?? 1;
  if ([5, 6, 7, 8].includes(orientation)) {
    return { width: meta.height ?? 0, height: meta.width ?? 0 };
  }
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

function validateMeta(meta, config, declaredMime) {
  if (!meta.width || !meta.height || !meta.format) {
    throw new ConversionError("invalid_image", "image dimensions or format could not be read");
  }
  const expectedFormats = MIME_TO_FORMATS.get(declaredMime);
  if (!expectedFormats) {
    throw new ConversionError("unsupported_media_type", "unsupported image content type", 415);
  }
  const actual = meta.format;
  if (!expectedFormats.has(actual)) {
    throw new ConversionError("content_type_mismatch", "declared content type does not match image data", 415);
  }
  if (meta.width > config.maxDimension || meta.height > config.maxDimension) {
    throw new ConversionError("image_dimensions_too_large", `image dimensions exceed ${config.maxDimension}px`);
  }
  const pixels = Number(meta.width) * Number(meta.height);
  if (!Number.isSafeInteger(pixels) || pixels > config.maxPixels) {
    throw new ConversionError("image_too_many_pixels", `image exceeds ${config.maxPixels} pixels`);
  }
  if ((meta.pages ?? 1) > 1) {
    throw new ConversionError("animated_image_not_supported", "animated or multi-page images are not supported");
  }
}

async function outputInfo(filePath) {
  const [stat, meta] = await Promise.all([
    fs.stat(filePath),
    sharp(filePath, { failOn: "error" }).metadata(),
  ]);
  return {
    bytes: stat.size,
    width: meta.width,
    height: meta.height,
  };
}

export function configureSharp(config) {
  sharp.concurrency(config.sharpConcurrency);
  sharp.cache({
    memory: config.sharpCacheMemoryMB,
    files: 0,
    items: 100,
  });
}

export async function convertImage({ inputPath, outputDir, mime, baseName, formats, config }) {
  const input = sharp(inputPath, {
    failOn: "error",
    limitInputPixels: config.maxPixels,
    sequentialRead: true,
  });

  let meta;
  try {
    meta = await input.metadata();
  } catch {
    throw new ConversionError("invalid_image", "input is not a decodable image");
  }
  validateMeta(meta, config, mime);

  const effective = effectiveDimensions(meta);
  const variants = [];

  for (const [name, width] of Object.entries(config.widths)) {
    for (const format of formats) {
      const ext = format === "webp" ? "webp" : "avif";
      const fileName = `${baseName}-${name}.${ext}`;
      const filePath = path.join(outputDir, fileName);

      let pipeline = sharp(inputPath, {
        failOn: "error",
        limitInputPixels: config.maxPixels,
        sequentialRead: true,
      })
        .rotate()
        .toColourspace("srgb")
        .resize({
          width,
          fit: "inside",
          withoutEnlargement: true,
          kernel: sharp.kernel.lanczos3,
        });

      if (format === "webp") {
        pipeline = pipeline.webp({
          quality: config.webpQuality,
          effort: config.webpEffort,
          smartSubsample: true,
        });
      } else {
        pipeline = pipeline.avif({
          quality: config.avifQuality,
          effort: config.avifEffort,
        });
      }

      try {
        await pipeline.toFile(filePath);
      } catch {
        throw new ConversionError("conversion_failed", `failed to encode ${name}.${format}`, 500);
      }

      const info = await outputInfo(filePath);
      variants.push({
        name,
        format,
        fileName,
        filePath,
        ...info,
      });
    }
  }

  return {
    input: {
      format: meta.format,
      width: effective.width,
      height: effective.height,
      orientation: meta.orientation ?? 1,
      space: meta.space ?? null,
      hasAlpha: Boolean(meta.hasAlpha),
    },
    variants,
  };
}
