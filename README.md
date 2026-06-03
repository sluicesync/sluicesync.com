# sluicesync.com

The public documentation site for [sluice](https://github.com/sluicesync/sluice),
served at **[sluicesync.com](https://sluicesync.com)** via GitHub Pages.

- Static site, no build step (legacy Pages from `main` / root).
- `index.html` is a self-contained landing (overview, quick start, features) — no
  external CDNs or fonts.
- Branding assets (`sluice-logo*.png`, favicons, `og-image.png`) mirror
  `sluicesync/sluice/branding/`.
- `CNAME` pins the custom domain; DNS is on Cloudflare (DNS-only / grey-cloud):
  apex `A` → GitHub Pages `185.199.108–111.153`, `www` `CNAME` →
  `sluicesync.github.io`.

This repo is intentionally separate from the `sluicesync.dev` vanity-import host
so the docs domain and the Go module path evolve independently.

## Roadmap

As the main repo goes public, expand from the single landing page into rendered
guides (architecture, type-mapping, operator runbooks) — likely MkDocs Material
or Jekyll sourcing the curated subset of `sluicesync/sluice/docs/`.
