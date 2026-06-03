# sluicesync.com

The public documentation site for [sluice](https://github.com/sluicesync/sluice),
served at **[sluicesync.com](https://sluicesync.com)** via GitHub Pages.

- Static site, **no build step on Pages** (legacy Pages from `main` / root).
- `index.html` is a self-contained landing (overview, quick start, features) — no
  external CDNs or fonts.
- `docs/` holds the multi-page documentation (Getting started, Command reference,
  Configuration). These pages are **generated locally** by `build.mjs` from a shared
  layout + content, then committed as plain HTML — Pages serves the output directly,
  so there is still no build step in CI. To edit docs: change the page bodies in
  `build.mjs`, run `node build.mjs`, and commit the regenerated `docs/**/index.html`.
- `assets/docs.css` is the shared docs stylesheet.
- Branding assets (`sluice-logo*.png`, favicons, `og-image.png`) mirror
  `sluicesync/sluice/branding/`.
- `CNAME` pins the custom domain; DNS is on Cloudflare (DNS-only / grey-cloud):
  apex `A` → GitHub Pages `185.199.108–111.153`, `www` `CNAME` →
  `sluicesync.github.io`.

This repo is intentionally separate from the `sluicesync.dev` vanity-import host
so the docs domain and the Go module path evolve independently.

## Roadmap

Current docs are hand-authored, curated content (not a bulk export of the private
`sluicesync/sluice/docs/`). As the main repo goes public, candidates to add: an
architecture overview, type-mapping reference, and operator runbooks. If the page
count grows large, consider migrating from the `build.mjs` generator to MkDocs
Material or Jekyll — but only once the custom-domain HTTPS cert is stable, since
switching the Pages build type to Actions can disrupt cert provisioning.
