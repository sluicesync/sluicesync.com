# sluicesync.com

The public documentation site for [sluice](https://github.com/sluicesync/sluice),
served at **[sluicesync.com](https://sluicesync.com)** via **Cloudflare Pages**.

- Static site committed as plain HTML — **no build step runs on deploy**. The HTML is
  generated locally (`node build.mjs`) and the output is committed; Cloudflare Pages
  serves it as-is.
- **Deploy = merge to `main`.** Cloudflare Pages' Git integration watches the `main`
  branch and auto-builds/deploys on every merge — there is no GitHub Pages and no
  GitHub Actions deploy step. Merging a PR into `main` *is* the deploy, so the PR is
  the review gate before changes go live.
- `index.html` is a self-contained landing (overview, quick start, features) — no
  external CDNs or fonts.
- `docs/` holds the multi-page documentation (Getting started, Command reference,
  Configuration, Guides). These pages are **generated locally** by `build.mjs` from a
  shared layout + content, then committed as plain HTML. To edit docs: change the page
  bodies in `build.mjs`, run `node build.mjs`, and commit the regenerated
  `docs/**/index.html`.
- `assets/docs.css` is the shared docs stylesheet.
- Branding assets (`sluice-logo*.png`, favicons, `og-image.png`) mirror
  `sluicesync/sluice/branding/`.
- `CNAME` pins the custom domain. Domain + hosting are managed via Cloudflare Pages —
  see the Cloudflare dashboard for the project and DNS configuration.
  <!-- TODO: confirm exact Cloudflare Pages project name / custom-domain / DNS settings -->


This repo is intentionally separate from the `sluicesync.dev` vanity-import host
so the docs domain and the Go module path evolve independently.

## Roadmap

Current docs are hand-authored, curated content (not a bulk export of the private
`sluicesync/sluice/docs/`). As the main repo goes public, candidates to add: an
architecture overview, type-mapping reference, and operator runbooks. If the page
count grows large, consider migrating from the `build.mjs` generator to MkDocs
Material or Jekyll — Cloudflare Pages can run a framework build on deploy, so the
"commit the generated HTML" step could be dropped at that point.
