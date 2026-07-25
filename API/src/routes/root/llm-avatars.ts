export const llmAvatarsMarkdown = `
---

## User avatars

Every UOA user always has an avatar. The API resolves one with a fixed precedence and the avatar \`GET\` endpoints **always return image bytes, never JSON** — there is no "no avatar" case to handle and no 404 for a known user.

1. **Uploaded** — an image set through UOA (\`PUT\` on any avatar endpoint). Stored in Postgres, one row per user. Wins over everything.
2. **Provider** — the social provider avatar captured in \`avatar_url\`. UOA fetches it server-side and returns the bytes, so the caller never has to hotlink a provider CDN. HTTPS-only, SSRF-guarded, ~5s timeout, 5 MiB cap, and the response must sniff as a raster image. Nothing is persisted.
3. **Generated** — a deterministic, dependency-free SVG UOA draws itself. Always available.

Any provider-fetch failure silently degrades to the generated image; the response is still \`200\` and \`X-UOA-Avatar-Source\` tells you it happened. Apple, which returns no avatar URL, therefore always resolves to \`generated\`.

### Endpoints

| Method | Path | Auth |
| ------ | ---- | ---- |
| GET / PUT / DELETE | \`/domain/users/:userId/avatar?domain=…\` | domain hash bearer — backend-driven administration |
| GET / PUT / DELETE | \`/avatar/me?domain=…\` | domain hash bearer **and** \`X-UOA-Access-Token\` — the end user's own choice, relayed by your backend |
| GET | \`/internal/admin/users/:userId/avatar\` | admin superuser bearer |

For \`/domain/users/:userId/avatar\` the user must be visible to the authenticated domain under the same rules as \`GET /domain/users\`; anything else is the standard generic 404. For \`/avatar/me\` the access token's \`domain\` claim must equal \`?domain=\`, and the acting identity is always the token subject — you cannot act for another user through this route.

\`PUT\` takes \`multipart/form-data\` with exactly one part named \`file\`: PNG, JPEG or WebP, at most 1 MiB. The stored type is decided by **magic-byte sniffing**, not the mimetype you send — SVG, HTML, PDF and everything else non-raster is rejected with the generic error envelope. It returns \`{ ok, avatar: { source, content_type, size_bytes, updated_at } }\`. \`DELETE\` returns \`{ ok: true }\` and is idempotent; resolution then falls back to the provider URL or the generated image. Both mutations are rate-limited per domain + user.

### Generated styles and caching

Four styles: \`tiles\` (symmetric identicon mosaic), \`waves\` (stacked Bézier bands), \`rings\` (offset concentric rings), and \`mono\` (black-and-white geometric pattern). Selection order:

1. \`?style=\` on the GET — one of the four values; use it to preview or pin a style per call.
2. The signed config claim \`avatars.default_style\` for the domain. Pass \`?config_url=\` on the avatar GET to have UOA fetch and verify your config and apply it; its \`domain\` claim must match \`?domain=\`.
3. Neither → a stable per-user pick derived from the user id.

Generation is deterministic: the same user always gets the same image, so it is safe to cache and it never flickers between styles. \`?size=\` (default 128, clamped 16–512) sets the SVG's rendered width/height — the \`viewBox\` is constant and \`size\` is ignored for raster images.

Every avatar GET responds with \`X-UOA-Avatar-Source: uploaded | provider | generated\`, an \`ETag\` (send it back as \`If-None-Match\` for a \`304\`), \`X-Content-Type-Options: nosniff\`, \`Content-Disposition: inline\`, and \`Cache-Control: private, max-age=300\` for uploaded/proxied images or \`private, max-age=86400\` for generated ones. SVG responses additionally carry \`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\` — generated SVGs contain no scripts, foreign objects, or external references.

Since these endpoints need a bearer credential, a plain \`<img src>\` cannot call them directly: fetch the image with your credential and render the resulting blob/object URL.

\`GET /domain/users\` additionally returns \`avatar_source\` per user so you can label or prioritise without a request per avatar. \`avatar_url\` is unchanged: it remains the provider URL and is still overwritten on every social login, which is exactly why uploads live in their own table and cannot be clobbered by a later sign-in.

See [the JSON endpoint contract](/api) and \`Docs/Auth/avatars.md\` for the full specification.
`;
