import crypto from "node:crypto";

export function apiKeyDigest(value) {
  return crypto.createHash("sha256").update(value).digest();
}

export function buildTenantAuth(entries) {
  const tenants = entries.map(({ apiKey, tenant }) => ({
    digest: apiKeyDigest(apiKey),
    tenant,
  }));

  return function authenticate(presented) {
    if (typeof presented !== "string" || presented.length < 24) return null;
    const digest = apiKeyDigest(presented);
    for (const candidate of tenants) {
      if (crypto.timingSafeEqual(digest, candidate.digest)) return candidate.tenant;
    }
    return null;
  };
}

export function requestId(value) {
  if (typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
  return crypto.randomBytes(16).toString("hex");
}

export function safeBaseName(value = "image") {
  const withoutPath = String(value).replaceAll("\\", "/").split("/").pop() || "image";
  const noExt = withoutPath.replace(/\.[^.]+$/, "");
  const safe = noExt
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || "image";
}
