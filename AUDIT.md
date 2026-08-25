# Converter audit

## Original service strengths

- small codebase
- Sharp already chosen as the conversion engine
- API-key-to-tenant isolation concept
- explicit image quality settings
- EXIF/orientation concerns were recognized
- no public unauthenticated conversion endpoint

## Original release blockers / weaknesses

### High

1. `multer.memoryStorage()` buffered the complete upload in RAM while WebP and AVIF outputs were also held as full buffers. Concurrent large images could multiply memory consumption quickly.
2. The project used `multer@1.4.5-lts.1`, an old branch later affected by multiple resource-exhaustion / DoS advisories.
3. The project used `sharp@0.33.5`; Sharp currently supports security updates on its latest line and 2026 advisories affected older bundled libvips versions.
4. No decoded-pixel or maximum-dimension protection existed, so a small compressed file could still be computationally expensive after decoding.
5. Conversion had no concurrency/backpressure guard.

### Medium

6. Docker used Node 20, which is EOL in 2026.
7. `OUTPUT_DIR`, `PUBLIC_BASE_URL`, and the `/data/images` volume were configured but unused.
8. `archiver` was installed but unused.
9. The service generated AVIF unconditionally, paying the expensive AVIF encode cost even when the consumer did not need it.
10. The service generated one resized image per format, not the backend's thumb/medium/large contract.
11. Errors had no stable machine-readable codes or request IDs.
12. Logs were unstructured and could not be correlated with backend jobs.
13. API-key lookup used a normal object lookup; keys remained raw in the in-memory lookup structure.
14. Health existed, but no readiness/capacity view or graceful shutdown behavior existed.
15. Container ran without the backend project's later read-only/cap-drop/no-new-privileges hardening.

## Hardened v1 decisions

- Node built-in HTTP server; no Express/Multer.
- Raw bounded request body streamed to per-request temp storage.
- Sharp is the only runtime npm dependency.
- WebP default; AVIF opt-in for benchmarks.
- Three backend-compatible variants: 400/1200/2000.
- No persistent volume and no converter-side queue.
- Backend remains the durability/orchestration boundary.
- MIME/data match, pixel/dimension limits, and multi-page rejection.
- Capacity returns retryable 503 rather than accumulating work in RAM.
- JSON logs and request IDs.
- Read-only, non-root container with no Linux capabilities.
