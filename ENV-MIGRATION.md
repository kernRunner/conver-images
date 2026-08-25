# Environment migration

The converter is now stateless. Remove old storage/admin variables from Portainer.

| Old variable | Action | Replacement |
|---|---|---|
| `TENANTS_JSON` | Keep | Same role; required |
| `PUBLIC_BASE_URL` | Delete | None; Go backend owns public URLs |
| `OUTPUT_DIR` | Delete | None; Go backend owns variant storage |
| `HOST_IMAGES_PATH` | Delete | None; converter has no persistent volume |
| `ADMIN_TOKEN` | Delete | None; converter has no admin routes |
| `PORT` | Delete from Portainer | Internal port fixed to 3000 |

Recommended first-server benchmark values:

```env
MAX_ACTIVE_JOBS=1
SHARP_CONCURRENCY=1
SHARP_CACHE_MEMORY_MB=64
ENABLE_AVIF=false
WEBP_QUALITY=82
WEBP_EFFORT=4
```
