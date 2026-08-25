# Artist Image Converter v1.2

Stateless, authenticated image conversion service for the Artist backend.

The Go backend owns durable jobs, original/variant storage, publication state and retries. This service only transforms one image into deterministic variants and streams the result back.

## Why old storage variables disappeared

The legacy compose defined `OUTPUT_DIR` and `PUBLIC_BASE_URL`, but the provided legacy `index.mjs` never read either variable. The provided legacy code also never referenced `HOST_IMAGES_PATH` or `ADMIN_TOKEN`.

v1.2 intentionally removes that unused persistence/admin surface:

| Legacy variable | v1.2 | Reason |
|---|---|---|
| `TENANTS_JSON` | KEEP | Required API-key authentication |
| `OUTPUT_DIR` | REMOVE | Converter does not persist output |
| `PUBLIC_BASE_URL` | REMOVE | Converter does not publish URLs |
| `HOST_IMAGES_PATH` | REMOVE | No persistent converter volume |
| `ADMIN_TOKEN` | REMOVE | No admin API exists |
| `PORT` | INTERNAL | Compose fixes container port to 3000 |

If any removed variable is still configured, startup logs a `legacy_env_ignored` warning so Portainer cleanup is obvious.

## Required Portainer environment

Start with:

```env
TENANTS_JSON={"replace-with-64-char-key":{"tenant":"artist-backend"}}
CONVERTER_HOST=img-api.marcohuber-web.site
CADDY_NETWORK=caddy
MAX_ACTIVE_JOBS=1
SHARP_CONCURRENCY=1
SHARP_CACHE_MEMORY_MB=64
ENABLE_AVIF=false
WEBP_QUALITY=82
WEBP_EFFORT=4
```

The rest have safe compose defaults. See `.env.example`.

## API

### Health

`GET /health`

### Readiness

`GET /ready`

### Convert

`POST /v1/convert`

Headers:

- `X-API-Key`: configured tenant key
- `Content-Type`: `image/jpeg`, `image/png`, `image/webp`, or `image/avif`
- `X-Filename`: original filename, optional
- `X-Output-Formats`: `webp` by default; optionally `webp,avif` when AVIF is enabled

Body: raw image bytes.

Response: `multipart/mixed` containing `metadata.json` plus `thumb`, `medium`, and `large` variants.

## Local setup

Node 24 is the production target. Node 22 can run the service for local tests, but npm will warn about the engine range.

```bash
npm install
npm test
npm run check
```

`npm install` generates the new `package-lock.json`. Commit that lockfile to the Git repository. Once it is committed, you may switch the Dockerfile from `npm install` to `npm ci` for fully reproducible dependency installation.

## Benchmark

Single/sequential benchmark:

```bash
npm run benchmark -- /path/to/image.avif 10
```

Queue-like load benchmark:

```bash
npm run benchmark:load -- /path/to/image.avif 50 1
npm run benchmark:load -- /path/to/image.avif 50 2
```

For the small VPS begin with `MAX_ACTIVE_JOBS=1`, `SHARP_CONCURRENCY=1`, and AVIF disabled. Increase only after comparing wall time, images/minute, CPU and RAM.
