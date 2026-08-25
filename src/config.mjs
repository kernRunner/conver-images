function envString(name, fallback = "") {
  const value = process.env[name];
  return value == null ? fallback : String(value).trim();
}

function envInt(name, fallback, { min, max } = {}) {
  const raw = envString(name, String(fallback));
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} is outside the safe integer range`);
  }
  if (min != null && value < min) throw new Error(`${name} must be >= ${min}`);
  if (max != null && value > max) throw new Error(`${name} must be <= ${max}`);
  return value;
}

function envBool(name, fallback) {
  const raw = envString(name, fallback ? "true" : "false").toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

export function parseTenants(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new Error("TENANTS_JSON must be valid JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("TENANTS_JSON must be a JSON object");
  }

  const entries = [];
  for (const [apiKey, value] of Object.entries(parsed)) {
    if (apiKey.length < 24) {
      throw new Error("TENANTS_JSON API keys must be at least 24 characters");
    }
    const tenant = typeof value === "string" ? value : value?.tenant;
    const active = typeof value === "object" && value !== null && "active" in value
      ? Boolean(value.active)
      : true;
    if (!tenant || typeof tenant !== "string" || !tenant.trim()) {
      throw new Error("every TENANTS_JSON entry needs a non-empty tenant");
    }
    if (active) entries.push({ apiKey, tenant: tenant.trim() });
  }
  return entries;
}


export const LEGACY_ENV_VARS = Object.freeze([
  "OUTPUT_DIR",
  "PUBLIC_BASE_URL",
  "HOST_IMAGES_PATH",
  "ADMIN_TOKEN",
]);

export function configuredLegacyEnvVars() {
  return LEGACY_ENV_VARS.filter((name) => {
    const value = process.env[name];
    return value != null && String(value).trim() !== "";
  });
}

export function loadConfig() {
  const widths = {
    thumb: envInt("THUMB_WIDTH", 400, { min: 64, max: 8000 }),
    medium: envInt("MEDIUM_WIDTH", 1200, { min: 64, max: 8000 }),
    large: envInt("LARGE_WIDTH", 2000, { min: 64, max: 8000 }),
  };
  if (!(widths.thumb <= widths.medium && widths.medium <= widths.large)) {
    throw new Error("variant widths must satisfy THUMB_WIDTH <= MEDIUM_WIDTH <= LARGE_WIDTH");
  }

  return Object.freeze({
    port: envInt("PORT", 3000, { min: 1, max: 65535 }),
    tenants: parseTenants(envString("TENANTS_JSON", "{}")),
    maxUploadBytes: envInt("MAX_UPLOAD_BYTES", 32 * 1024 * 1024, { min: 1024, max: 128 * 1024 * 1024 }),
    maxPixels: envInt("MAX_PIXELS", 50_000_000, { min: 1_000_000, max: 200_000_000 }),
    maxDimension: envInt("MAX_DIMENSION", 12_000, { min: 1000, max: 50_000 }),
    widths,
    webpQuality: envInt("WEBP_QUALITY", 82, { min: 1, max: 100 }),
    webpEffort: envInt("WEBP_EFFORT", 4, { min: 0, max: 6 }),
    enableAvif: envBool("ENABLE_AVIF", false),
    avifQuality: envInt("AVIF_QUALITY", 45, { min: 1, max: 100 }),
    avifEffort: envInt("AVIF_EFFORT", 4, { min: 0, max: 9 }),
    maxActiveJobs: envInt("MAX_ACTIVE_JOBS", 2, { min: 1, max: 32 }),
    sharpConcurrency: envInt("SHARP_CONCURRENCY", 2, { min: 1, max: 32 }),
    sharpCacheMemoryMB: envInt("SHARP_CACHE_MEMORY_MB", 64, { min: 0, max: 2048 }),
  });
}
