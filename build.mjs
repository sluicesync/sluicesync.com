// Static docs generator for sluicesync.com.
// Output is plain HTML committed to the repo — Cloudflare Pages serves it as-is (auto-deploys on push to main)
// (no build step on Pages). Edit the page bodies below and re-run:  node build.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

// ---- helpers -------------------------------------------------------------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// minimal shell highlighter (operates on escaped text)
function hl(raw) {
  return esc(raw.replace(/^\n/, "").replace(/\n$/, ""))
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return '<span class="c">' + line + "</span>";
      line = line.replace(/(--[a-z][a-z0-9-]*)/g, '<span class="f">$1</span>');
      line = line.replace(/^(\s*)(sluice|go install|curl|docker)\b/, '$1<span class="k">$2</span>');
      return line;
    })
    .join("\n");
}
const pre = (raw) => "<pre><code>" + hl(raw) + "</code></pre>";

// ---- site nav ------------------------------------------------------------
const NAV = [
  {
    group: "Documentation",
    items: [
      { slug: "", label: "Overview" },
      { slug: "getting-started", label: "Getting started" },
      { slug: "configuration", label: "Configuration" },
    ],
  },
  {
    group: "Guides",
    items: [
      { slug: "migrate-mysql-to-postgres", label: "Migrate MySQL → Postgres" },
      { slug: "how-sluice-copies", label: "How sluice copies your data" },
      { slug: "preview-and-validate", label: "Preview & validate before you migrate" },
      { slug: "verify-reconcile", label: "Verify & reconcile" },
      { slug: "zero-downtime-cutover", label: "Zero-downtime migration (continuous sync)" },
      { slug: "schema-changes", label: "Schema changes during a sync" },
      { slug: "redact-pii", label: "Redact PII" },
      { slug: "import-sqlite-d1", label: "Import SQLite or Cloudflare D1" },
      { slug: "multi-database", label: "Migrate many databases or schemas" },
      { slug: "copy-table-subset", label: "Copy a subset of tables" },
      { slug: "foreign-keys-vitess", label: "Foreign keys on Vitess" },
      { slug: "postgres-source-prep", label: "Prepare a Postgres source" },
      { slug: "managed-postgres-slotless", label: "Managed Postgres (slot-less)" },
      { slug: "planetscale-vitess", label: "PlanetScale & Vitess" },
      { slug: "planetscale-region-move", label: "Move PlanetScale regions" },
      { slug: "planetscale-postgres", label: "PlanetScale Postgres" },
      { slug: "planetscale-postgres-upgrade", label: "Upgrade PlanetScale Postgres" },
      { slug: "operate-fleet", label: "Operate a sync fleet" },
      { slug: "encrypted-backups", label: "Take encrypted backups" },
      { slug: "from-backup-sync", label: "Sync from a backup chain" },
      { slug: "agent-skills", label: "Drive sluice from an AI agent" },
    ],
  },
  {
    group: "Reference",
    items: [
      {
        slug: "commands",
        label: "Command reference",
        subs: [
          ["engines", "engines"],
          ["migrate", "migrate"],
          ["sync-start", "sync start"],
          ["sync-manage", "sync status / stop / health"],
          ["schema-add-table", "schema add-table"],
          ["sync-from-backup", "sync from-backup"],
          ["cutover", "cutover"],
          ["backup", "backup"],
          ["restore", "restore"],
          ["trigger", "trigger setup / teardown"],
          ["schema", "schema preview / diff"],
          ["verify", "verify"],
          ["matview", "matview refresh"],
          ["slot", "slot list / drop"],
          ["diagnose", "diagnose"],
        ],
      },
      { slug: "database-objects", label: "Objects sluice creates" },
    ],
  },
];

function sidebar(activeSlug) {
  let out = "";
  for (const g of NAV) {
    out += '<div class="grp">' + g.group + "</div>";
    for (const it of g.items) {
      const href = it.slug === "" ? "/docs/" : "/docs/" + it.slug + "/";
      const active = it.slug === activeSlug ? " active" : "";
      out += '<a class="lnk' + active + '" href="' + href + '">' + it.label + "</a>";
      if (it.subs && it.slug === activeSlug) {
        for (const [anchor, label] of it.subs) {
          out += '<a class="sub" href="#' + anchor + '">' + label + "</a>";
        }
      }
    }
  }
  return out;
}

// Every rendered page is also collected here so the llms.txt / llms-full.txt
// generators at the bottom of this script stay in lockstep with the site —
// a page added above is picked up automatically, never hand-listed twice.
const EMITTED = [];

function slugify(s) {
  return (
    s
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/&[a-z]+;/g, " ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section"
  );
}

// Give every h2/h3 in a page body a stable id (reusing any hand-authored id)
// and a hover-revealed "#" permalink, and collect the h2s for a table of
// contents. Purely additive and layout-safe: we only APPEND a small trailing
// link — never wrap the heading's inner content — so existing #anchors keep
// working and the `.cmd h3` flex layout is untouched.
function processHeadings(body) {
  const toc = [];
  const seen = new Set();
  const withHeadings = body.replace(/<(h2|h3)([^>]*)>([\s\S]*?)<\/\1>/g, (_m, tag, attrs, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    let id = (attrs.match(/id="([^"]+)"/) || [])[1];
    if (!id) {
      let base = slugify(text);
      id = base;
      for (let n = 2; seen.has(id); n++) id = base + "-" + n;
      attrs += ` id="${id}"`;
    }
    seen.add(id);
    if (tag === "h2") toc.push({ id, text });
    return `<${tag}${attrs}>${inner} <a class="hlink" href="#${id}" aria-label="Permalink to this section">#</a></${tag}>`;
  });
  // Wrap every table in a horizontal-scroll container so a wide table scrolls
  // WITHIN its box instead of widening the whole page (the mobile-overflow /
  // zoom-out-blank-space bug). The table keeps normal table layout; the wrapper
  // div is the scroll container. Idempotent enough for our authored bodies
  // (no nested tables, no pre-wrapped tables).
  const html = withHeadings.replace(
    /<table(\s[^>]*)?>([\s\S]*?)<\/table>/g,
    '<div class="table-scroll"><table$1>$2</table></div>',
  );
  return { html, toc };
}

function renderToc(toc) {
  if (toc.length < 2) return "";
  const items = toc.map((t) => `<li><a href="#${t.id}">${t.text}</a></li>`).join("");
  return `<nav class="toc" aria-label="On this page"><p class="toc-label">On this page</p><ul>${items}</ul></nav>`;
}

function page({ slug, title, subtitle, body, prev, next }) {
  EMITTED.push({ slug, title, subtitle, body });
  const { html: bodyHtml, toc } = processHeadings(body);
  const tocHtml = renderToc(toc);
  const desc = subtitle || "sluice documentation";
  const guideSlugs = [
    "from-backup-sync",
    "migrate-mysql-to-postgres",
    "preview-and-validate",
    "zero-downtime-cutover",
    "import-sqlite-d1",
    "multi-database",
    "copy-table-subset",
    "foreign-keys-vitess",
    "how-sluice-copies",
    "verify-reconcile",
    "schema-changes",
    "redact-pii",
    "postgres-source-prep",
    "managed-postgres-slotless",
    "planetscale-vitess",
    "planetscale-region-move",
    "planetscale-postgres",
    "planetscale-postgres-upgrade",
    "operate-fleet",
    "encrypted-backups",
    "agent-skills",
  ];
  const docsActive = slug === "getting-started" || slug === "configuration" || slug === "commands" || slug === "database-objects" || slug === "" || guideSlugs.includes(slug);
  const top = '<a class="' + (docsActive ? "active" : "") + '" href="/docs/">Docs</a>';
  let pager = "";
  if (prev || next) {
    pager = '<div class="pager">';
    pager += prev ? '<a class="prev" href="' + prev.href + '">← ' + prev.label + "</a>" : "<span></span>";
    pager += next ? '<a class="next" href="' + next.href + '">' + next.label + " →</a>" : "";
    pager += "</div>";
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — sluice docs</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#0d1b22">
<link rel="stylesheet" href="/assets/docs.css">
<link rel="alternate" type="text/markdown" href="${slug === "" ? "/docs/index.md" : "/docs/" + slug + "/index.md"}" title="This page as Markdown (for AI agents)">
</head>
<body>
<header class="top">
  <div class="bar">
    <a class="brand" href="/"><img src="/sluice-logo-dark.png" alt="sluice"></a>
    <nav>
      <button class="menu-btn" onclick="document.querySelector('aside.sidebar').classList.toggle('open')">Menu</button>
      ${top}
      <a href="https://github.com/sluicesync/sluice">GitHub</a>
    </nav>
  </div>
</header>
<div class="layout">
  <aside class="sidebar">${sidebar(slug)}</aside>
  <main class="content">
    <h1>${esc(title)}</h1>
    ${subtitle ? '<p class="subtitle">' + esc(subtitle) + "</p>" : ""}
    ${tocHtml}
    ${bodyHtml}
    ${pager}
  </main>
</div>
<footer class="foot">Apache 2.0 · <a href="https://github.com/sluicesync/sluice">github.com/sluicesync/sluice</a> · <code>go install sluicesync.dev/sluice/cmd/sluice@latest</code> · <a href="${slug === "" ? "/docs/index.md" : "/docs/" + slug + "/index.md"}">View this page as Markdown</a></footer>
</body>
</html>`;
}

function write(slug, html) {
  const dir = slug === "" ? join(ROOT, "docs") : join(ROOT, "docs", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  console.log("wrote", slug === "" ? "docs/index.html" : "docs/" + slug + "/index.html");
}

// =========================================================================
//  PAGES
// =========================================================================

// ---- Overview ------------------------------------------------------------
write(
  "",
  page({
    slug: "",
    title: "Documentation",
    subtitle: "Migrate and continuously sync MySQL and Postgres, and import SQLite / Cloudflare D1 — correctness-first, loud failure by default.",
    body: `
<p>sluice is an open-source tool for moving and keeping databases in sync between <strong>MySQL</strong> and
<strong>Postgres</strong>, in all four directions. <strong>SQLite</strong> files (and a <code>wrangler d1 export</code> <code>.sql</code> dump)
and live <strong>Cloudflare D1</strong> databases also import into Postgres or MySQL, and SQLite is itself a migrate target —
nine engines are registered today (run <code>sluice engines</code> to list them). It is built around three surfaces you can
use independently or end to end:</p>
<ul>
  <li><strong>Migrate</strong> — a one-shot schema + data copy, with deferred indexes/constraints for fast bulk load and per-table resume.</li>
  <li><strong>Sync</strong> — change-data-capture streaming with a snapshot → CDC handoff and resumable checkpoints.</li>
  <li><strong>Operate</strong> — run as a long-lived service behind <code>/readyz</code> and <code>/metrics</code>, or as one-shot jobs.</li>
</ul>
<h2>Start here</h2>
<ul>
  <li><a href="/docs/getting-started/">Getting started</a> — install, connect, and run your first migration and sync.</li>
  <li><a href="/docs/commands/">Command reference</a> — every command, its key flags, and worked examples.</li>
  <li><a href="/docs/configuration/">Configuration</a> — connection strings, environment variables, the YAML config file, and global flags.</li>
</ul>
<div class="note"><strong>New here?</strong> The fastest path is <a href="/docs/getting-started/">Getting started</a> → run a <code>--dry-run</code> migration against a copy of your data → then read the <a href="/docs/commands/#migrate">migrate</a> and <a href="/docs/commands/#sync-start">sync start</a> references.</div>
`,
    next: { href: "/docs/getting-started/", label: "Getting started" },
  })
);

// ---- Getting started -----------------------------------------------------
write(
  "getting-started",
  page({
    slug: "getting-started",
    title: "Getting started",
    subtitle: "Install sluice, point it at a source and target, and run your first migration and continuous sync.",
    body: `
<h2 id="install">Install</h2>
<p>sluice is a single static binary with no daemon and no SaaS dependency. Install it with your platform's package manager:</p>
<ul>
  <li><strong>macOS / Linux</strong> (Homebrew): <code>brew install sluicesync/tap/sluice</code></li>
  <li><strong>Windows</strong> (Scoop): <code>scoop bucket add sluicesync https://github.com/sluicesync/scoop-bucket</code> then <code>scoop install sluice</code></li>
  <li><strong>Windows</strong> (WinGet): <code>winget install sluicesync.sluice</code> <em>(once accepted into <a href="https://github.com/microsoft/winget-pkgs">winget-pkgs</a>)</em></li>
  <li><strong>Debian / Ubuntu</strong>: download the <code>.deb</code> from the <a href="https://github.com/sluicesync/sluice/releases/latest">latest release</a>, then <code>sudo dpkg -i sluice_*_linux_amd64.deb</code></li>
  <li><strong>RHEL / Fedora</strong>: download the <code>.rpm</code>, then <code>sudo rpm -i sluice_*_linux_amd64.rpm</code></li>
  <li><strong>Go</strong>: <code>go install sluicesync.dev/sluice/cmd/sluice@latest</code></li>
  <li><strong>Container</strong> (multi-arch, distroless): <code>docker pull ghcr.io/sluicesync/sluice:latest</code></li>
</ul>
<p>Self-contained binaries (Linux / macOS / Windows &times; amd64 / arm64) and <code>.deb</code> / <code>.rpm</code> / <code>.apk</code> packages are attached to every <a href="https://github.com/sluicesync/sluice/releases/latest">release</a>. Verify the install:</p>
${pre(`sluice --version
sluice engines      # list the database engines built into this binary`)}

<h2 id="prerequisites">Prerequisites</h2>
<ul>
  <li>A <strong>source</strong> and a <strong>target</strong> database you can reach over the network.</li>
  <li>Engines available out of the box (nine — run <code>sluice engines</code> to confirm): <code>mysql</code>, the <code>planetscale</code> and self-hosted <code>vitess</code> MySQL flavors, <code>postgres</code>, <code>sqlite</code> and <code>d1</code> (migrate sources; <code>sqlite</code> is also a target), and the trigger-CDC engines <code>postgres-trigger</code>, <code>sqlite-trigger</code>, <code>d1-trigger</code>.</li>
  <li>For continuous sync from Postgres, the source normally needs logical replication (a replication slot). Managed Postgres that blocks slots (e.g. Heroku) can use the slot-less <a href="/docs/commands/#trigger">trigger engine</a> instead.</li>
  <li>SQLite and Cloudflare D1 are <strong>migrate sources</strong> (a local file, a <code>.sql</code> dump, or a live D1 over the HTTP query API) into Postgres or MySQL; SQLite is also a <strong>target</strong>. Their base engines are migrate-only — for continuous sync use the trigger-CDC variants <code>sqlite-trigger</code> / <code>d1-trigger</code>.</li>
</ul>

<h2 id="connecting">Connecting to your databases</h2>
<p>Source and target are passed as DSNs (connection strings). The driver is named separately with <code>--source-driver</code> / <code>--target-driver</code>.</p>
<table>
<thead><tr><th>Engine</th><th>DSN format</th></tr></thead>
<tbody>
<tr><td><code>mysql</code></td><td><code>user:pass@tcp(host:3306)/dbname</code></td></tr>
<tr><td><code>postgres</code></td><td><code>postgres://user:pass@host:5432/dbname?sslmode=require</code></td></tr>
<tr><td><code>sqlite</code></td><td>A file path (<code>./app.db</code>) or a <code>wrangler d1 export</code> <code>.sql</code> dump (auto-detected). Also a target driver.</td></tr>
<tr><td><code>d1</code></td><td><code>d1://&lt;account_id&gt;/&lt;database_id&gt;</code> (or <code>d1://&lt;database_id&gt;</code> + <code>CLOUDFLARE_ACCOUNT_ID</code>); API token via <code>CLOUDFLARE_API_TOKEN</code>.</td></tr>
</tbody>
</table>
<div class="note"><strong>A note on <code>sslmode</code>.</strong> The <code>sslmode=require</code> in these placeholder DSNs encrypts the connection but does <em>not</em> verify the server's certificate — a safe default that works against any TLS target regardless of its CA. Prefer <strong><code>sslmode=verify-full</code></strong> (encrypt <em>and</em> verify the CA chain + hostname, which defeats man-in-the-middle) whenever the target's certificate is trusted by your system store or you can pin its CA with <code>sslrootcert</code>. Managed providers with a public CA make this free — e.g. <a href="/docs/planetscale-postgres/#connect">PlanetScale Postgres</a> ships a Let's Encrypt certificate, so sluice connects with <code>verify-full</code> out of the box. sluice (pgx) passes <code>sslmode</code> and <code>sslrootcert</code> straight through to the driver and never downgrades TLS on its own.</div>
<p>DSNs often contain credentials, so you can supply them via environment variables instead of flags:</p>
${pre(`export SLUICE_SOURCE='root:rootpw@tcp(localhost:3306)/app'
export SLUICE_TARGET='postgres://postgres:pgpw@localhost:5432/app?sslmode=disable'`)}
<p>See <a href="/docs/configuration/">Configuration</a> for the full set of environment variables and the optional YAML config file.</p>

<h2 id="first-migration">Your first migration</h2>
<p>A one-shot migration translates the source schema, creates the target tables, bulk-copies rows, then builds indexes and constraints. Always do a <strong>dry run</strong> first — it reads the source schema and prints the plan without touching the target:</p>
${pre(`sluice migrate \\
    --source-driver mysql    --source 'root:rootpw@tcp(localhost:3306)/app' \\
    --target-driver postgres --target 'postgres://postgres:pgpw@localhost:5432/app?sslmode=disable' \\
    --dry-run`)}
<p>When the plan looks right, drop <code>--dry-run</code> to apply it. If a migration is interrupted, re-run with <code>--resume</code> — state is checkpointed per table on the target, so it picks up where it left off:</p>
${pre(`sluice migrate --source-driver mysql --source ... --target-driver postgres --target ... --resume`)}
<div class="note"><strong>Cold-start safety.</strong> sluice refuses to bulk-copy into a non-empty target by default (an <code>INSERT</code> into a populated table would collide on the primary key). Use <code>--resume</code> to continue a prior run, or read the <a href="/docs/commands/#migrate">migrate reference</a> for the recovery flags.</div>

<h2 id="sqlite-d1">Import a SQLite file or Cloudflare D1</h2>
<p>SQLite and Cloudflare D1 are migrate sources into Postgres or MySQL. Point <code>--source-driver sqlite</code> at a local <code>.db</code> file — or at a <code>wrangler d1 export</code> <code>.sql</code> dump, which is auto-detected — and migrate as usual:</p>
${pre(`# SQLite file (or a wrangler d1 export .sql dump) → Postgres
sluice migrate \\
    --source-driver sqlite   --source ./app.db \\
    --target-driver postgres --target 'postgres://postgres:pgpw@localhost:5432/app?sslmode=disable'`)}
<p>To read a <strong>live</strong> Cloudflare D1, use <code>--source-driver d1</code> with a <code>d1://</code> DSN; the API token is read from <code>CLOUDFLARE_API_TOKEN</code> (env-only, never a flag). The reader projects each column through <code>typeof()</code> + <code>CAST(… AS TEXT)</code> / <code>hex()</code> so integers above 2<sup>53</sup> and BLOBs round-trip exactly (no JavaScript 52-bit rounding), and the reads don't take D1 offline:</p>
${pre(`# Live Cloudflare D1 → Postgres
export CLOUDFLARE_API_TOKEN=...
sluice migrate \\
    --source-driver d1       --source 'd1://<account_id>/<database_id>' \\
    --target-driver postgres --target 'postgres://...?sslmode=disable'`)}
<p>SQLite is also a migrate <strong>target</strong> (<code>--target-driver sqlite</code>) — emit a <code>.db</code> from any source (decimals are stored byte-exact as <code>TEXT</code>), e.g. to then run <code>wrangler d1 import</code>. D1 itself is not a target; emit a SQLite <code>.db</code> and import it with wrangler.</p>
<div class="note"><strong>Declared dates are an explicit choice.</strong> SQLite has no native temporal storage, so columns <em>declared</em> <code>DATE</code> / <code>DATETIME</code> are decoded per <code>--sqlite-date-encoding</code> (<code>iso</code> default, or <code>unixepoch</code> / <code>unixmillis</code> / <code>julian</code>) — a value whose storage class doesn't match is refused loudly, never a silently-wrong date. For continuous (not one-shot) sync from SQLite / D1, use the <a href="/docs/commands/#trigger">trigger-CDC engines</a> <code>sqlite-trigger</code> / <code>d1-trigger</code>.</div>

<h2 id="first-sync">Your first continuous sync</h2>
<p>Continuous sync captures a consistent snapshot, bulk-copies it, then streams ongoing changes. Streams are identified by a <code>--stream-id</code> so they can resume after a restart:</p>
${pre(`sluice sync start \\
    --source-driver mysql    --source 'root:rootpw@tcp(localhost:3306)/app' \\
    --target-driver postgres --target 'postgres://postgres:pgpw@localhost:5432/app?sslmode=disable' \\
    --stream-id app-prod`)}
<p>From another shell, check freshness or status, and stop the stream cleanly when you're done:</p>
${pre(`sluice sync status --stream-id app-prod --target-driver postgres --target ...
sluice sync health --stream-id app-prod --target-driver postgres --target ...   # cron-friendly exit code
sluice sync stop   --stream-id app-prod --target-driver postgres --target ...   # drains in-flight changes, then exits`)}

<h2 id="verify">Verify the copy</h2>
<p>After a migration or once a stream has caught up, compare source and target:</p>
${pre(`sluice verify \\
    --source-driver mysql    --source ... \\
    --target-driver postgres --target ...`)}
<p><code>verify</code> compares row counts by default and can escalate to per-row hashing — see the <a href="/docs/commands/#verify">verify reference</a>.</p>

<h2 id="backups">Set up backups</h2>
<p>sluice takes <strong>logical</strong> backups — a full snapshot that roots a chain, plus incrementals appended onto it — to a local directory or any S3/GCS/Azure object store. It's the same binary; no separate backup daemon. Take a full backup first; on Postgres, add <code>--chain-slot</code> so the full provisions the replication slot that anchors the chain (incrementals then chain with zero gap, no manual slot setup):</p>
${pre(`# full snapshot to a local directory (chain root)
sluice backup full --source-driver postgres --source ... \\
    --output-dir /var/backups/app --chain-slot

# append an incremental onto the chain
sluice backup incremental --source-driver postgres --source ... \\
    --output-dir /var/backups/app`)}
<p>Backups are compressed with <strong>zstd by default</strong> (<code>--compression none|gzip|zstd</code>). To rest the chain encrypted, add the encryption flags — a passphrase (read from an env var or file, not the command line) or a cloud KMS key (<code>--kms-key-arn</code> / <code>--gcp-kms-key-resource</code> / <code>--azure-key-vault-id</code>); see the <a href="/docs/commands/#backup">backup reference</a>.</p>
<p>For <strong>object storage</strong>, swap <code>--output-dir</code> for <code>--target &lt;url&gt;</code> (<code>s3://</code>, <code>gs://</code>, <code>azblob://</code>, <code>file:///</code>). S3-compatible providers — Cloudflare R2, Backblaze B2, MinIO, Wasabi, Tigris — take three extra knobs: <code>--backup-endpoint</code> (the provider's endpoint), <code>--backup-region</code>, and <code>--backup-path-style</code> (bucket-in-path addressing, which most non-AWS providers require):</p>
${pre(`# full backup to Cloudflare R2 (an S3-compatible store)
sluice backup full --source-driver postgres --source ... \\
    --target s3://my-bucket/app-chain \\
    --backup-endpoint https://<account>.r2.cloudflarestorage.com \\
    --backup-region auto \\
    --backup-path-style \\
    --chain-slot`)}
<div class="note">Credentials follow the cloud SDK's normal resolution (e.g. <code>AWS_ACCESS_KEY_ID</code> / <code>AWS_SECRET_ACCESS_KEY</code> for any S3-compatible endpoint). To run continuously instead of one incremental at a time, use <code>sluice backup stream run</code> (rolling incrementals) — and replay a chain into a live target with the <a href="/docs/from-backup-sync/">broker tutorial</a>.</div>

<h2 id="trigger-cdc">Trigger-based CDC (no replication slot / Bucardo-style)</h2>
<p>When the source is a managed Postgres that blocks logical replication slots — Heroku Postgres, RDS without the right grants, Supabase / Crunchy starter tiers — sluice can capture changes with <strong>plpgsql triggers</strong> instead. Per-table triggers write into a <code>sluice_change_log</code> capture table; the <code>postgres-trigger</code> engine tails the log. The lifecycle is explicit — <strong>setup → run → teardown</strong> — so the source-side DDL is visible at the CLI, not silently applied on first sync.</p>
<p><strong>1. Install the capture triggers</strong> (<code>--tables</code> is required; on a tier that denies event-trigger creation, add <code>--allow-polled-fingerprint</code> to opt into the polled schema-fingerprint fallback):</p>
${pre(`sluice trigger setup \\
    --dsn 'postgres://user:pass@host:5432/app?sslmode=require' \\
    --tables=orders,customers \\
    --allow-polled-fingerprint`)}
<p><strong>2. Stream with the trigger engine</strong> — the source driver is <code>postgres-trigger</code>; everything else is an ordinary <code>sync start</code>:</p>
${pre(`sluice sync start \\
    --source-driver postgres-trigger \\
    --source 'postgres://user:pass@host:5432/app?sslmode=require' \\
    --target-driver postgres --target 'postgres://...target...' \\
    --stream-id app`)}
<p><strong>3. Tear down cleanly</strong> when the stream is finished — this drops every per-table trigger and (by default) the <code>sluice_change_log</code> table, leaving the source with zero residue (the full set of objects setup installs is listed under <a href="/docs/database-objects/#trigger-source">Objects sluice creates</a>). Pass <code>--keep-data</code> to retain the change-log for forensics, or <code>--yes</code> to skip the confirmation prompt:</p>
${pre(`sluice trigger teardown \\
    --dsn 'postgres://user:pass@host:5432/app?sslmode=require' --yes`)}
<div class="note">The slot-based PG CDC reader refuses loudly when the source role lacks the <code>REPLICATION</code> attribute rather than silently degrading to polling — the trigger engine is the deliberate slot-less path. See the <a href="/docs/commands/#trigger">trigger reference</a>.</div>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/commands/">Command reference</a> — the full flag set for every command.</li>
  <li><a href="/docs/from-backup-sync/">Continuous sync from a backup chain</a> — replay a chain into a target as a long-running broker (decoupled transport).</li>
  <li><a href="/docs/commands/#cutover">cutover</a> — prime target sequences before switching traffic, so the first post-cutover <code>INSERT</code> can't collide.</li>
  <li><a href="/docs/configuration/">Configuration</a> — YAML config, env vars, type/expression overrides, and PII redaction.</li>
</ul>
`,
    prev: { href: "/docs/", label: "Overview" },
    next: { href: "/docs/commands/", label: "Command reference" },
  })
);

// ---- Command reference ---------------------------------------------------
const cmd = (id, name, purpose, bodyHtml) =>
  '<div class="cmd" id="' + id + '"><h3>' + name + "</h3>" +
  '<p class="purpose">' + purpose + "</p>" + bodyHtml + "</div>";

write(
  "commands",
  page({
    slug: "commands",
    title: "Command reference",
    subtitle: "Every sluice command, its purpose, the flags that matter most, and worked examples.",
    body: `
<p>The general shape is <code>sluice &lt;command&gt; [flags]</code>. Every command accepts the
<a href="/docs/configuration/#global-flags">global flags</a> (<code>--config</code>, <code>--log-level</code>, …).
Run <code>sluice &lt;command&gt; --help</code> for the complete flag list — the tables below cover the
flags you'll reach for most.</p>

<div class="note"><strong>Parallelism flags mean different things per command.</strong> The same flag name maps to a different axis depending on the verb — read this row before tuning.
<table><thead><tr><th>Flag</th><th>What it controls</th></tr></thead><tbody>
<tr><td><code>--table-parallelism</code></td><td class="desc">Tables processed concurrently. On <strong>migrate</strong> = tables copied at once; on <strong>backup</strong> = tables read at once (the read-side analog of <code>pg_dump -j</code>); on <strong>restore</strong> = tables bulk-applied at once (<code>pg_restore -j</code>). On <strong>sync start</strong> it governs the PG-source cold-start sweep only.</td></tr>
<tr><td><code>--bulk-parallelism</code></td><td class="desc">Within-table concurrency (a single table's chunks at once). On <strong>migrate</strong> / <strong>restore</strong> it multiplies with <code>--table-parallelism</code>, the product bounded by the target connection budget.</td></tr>
<tr><td><code>--apply-concurrency</code></td><td class="desc">CDC apply lane count (PK-hash, exactly-once). Used by <strong>sync start</strong>, <strong>sync from-backup</strong>, and the incremental-replay leg of <strong>restore</strong>.</td></tr>
<tr><td><code>--copy-fanout-degree</code></td><td class="desc">VStream/CDC cold-start <strong>write</strong> fan-out (PlanetScale-MySQL target) on <strong>sync start</strong>.</td></tr>
</tbody></table>
On <strong>sync start</strong>, <code>--table-parallelism</code> / <code>--bulk-parallelism</code> are <strong>PG-source-only</strong> — they're inert on MySQL / VStream sources. For a MySQL or Vitess/PlanetScale source's cold-copy concurrency, use the source-DSN knobs <a href="/docs/configuration/#dsn-tuning"><code>copy_table_parallelism</code></a> (native MySQL) / <code>vstream_copy_table_parallelism</code> (VStream) for read concurrency, and <code>--copy-fanout-degree</code> for write fan-out.</div>

<h2 id="engines">engines</h2>
${cmd(
  "engines",
  "sluice engines",
  "List the database engines built into this binary and their bulk-load / CDC capabilities.",
  `${pre(`sluice engines`)}
  <p>Nine engines are registered today: <code>mysql</code> (binlog CDC), <code>planetscale</code> and self-hosted <code>vitess</code> (both VStream CDC), <code>postgres</code> (logical-replication CDC), <code>sqlite</code> and <code>d1</code> (migrate sources — <code>sqlite</code> is also a target — no CDC), and the trigger-CDC engines <code>postgres-trigger</code> (slot-less Postgres), <code>sqlite-trigger</code> (local SQLite file), and <code>d1-trigger</code> (live Cloudflare D1). The <code>vitess</code> flavor shares the PlanetScale engine code with a self-hosted-vtgate capability set, and warm-resumes since v0.99.44.</p>
  <table><thead><tr><th>Engine</th><th>Role</th><th>Notes</th></tr></thead><tbody>
  <tr><td><code>mysql</code></td><td class="desc">CDC <strong>source</strong> · migrate <strong>source &amp; target</strong></td><td class="desc">Vanilla MySQL: binlog (row-based) CDC and bulk <code>LOAD DATA</code> cold-copy. DSN <code>user:pass@tcp(host:3306)/db</code>.</td></tr>
  <tr><td><code>planetscale</code></td><td class="desc">CDC <strong>source</strong> · migrate <strong>source &amp; target</strong></td><td class="desc">PlanetScale MySQL flavor: VStream (gRPC) CDC and batched-insert cold-copy — Vitess blocks <code>LOAD DATA</code>, so use this, not <code>mysql</code>, against a <code>*.psdb.cloud</code> host. Auto-discovers the keyspace shard layout.</td></tr>
  <tr><td><code>vitess</code></td><td class="desc">CDC <strong>source</strong> · migrate <strong>source &amp; target</strong></td><td class="desc">Self-hosted Vitess/vtgate: shares the <code>planetscale</code> engine code (VStream CDC) with a self-hosted-vtgate capability set; warm-resumes since v0.99.44.</td></tr>
  <tr><td><code>postgres</code></td><td class="desc">CDC <strong>source</strong> · migrate <strong>source &amp; target</strong></td><td class="desc">Logical-replication (replication-slot) CDC and <code>COPY</code> cold-copy. Roles, extensions, and slot lifecycle are surfaced explicitly, never silently auto-handled.</td></tr>
  <tr><td><code>sqlite</code></td><td class="desc">migrate <strong>source</strong> (file or <code>.sql</code> dump) <strong>and target</strong></td><td class="desc">Pure-Go <code>modernc.org/sqlite</code>, no CGO. Imports a binary <code>.db</code> or an auto-detected <code>wrangler d1 export</code> <code>.sql</code> dump into Postgres / MySQL; as a target emits a <code>.db</code> (decimals byte-exact as <code>TEXT</code>). Migrate only (no CDC).</td></tr>
  <tr><td><code>d1</code></td><td class="desc">migrate <strong>source</strong> (live, lossless)</td><td class="desc">Reads a live Cloudflare D1 over its HTTP query API (token via <code>CLOUDFLARE_API_TOKEN</code>); per-column <code>typeof()</code> + <code>CAST(… AS TEXT)</code> / <code>hex()</code> projection makes integers above 2<sup>53</sup> and BLOBs round-trip exactly, and reads don't take D1 offline (ADR-0132).</td></tr>
  <tr><td><code>postgres-trigger</code></td><td class="desc">CDC <strong>source</strong></td><td class="desc">Slot-less Postgres trigger-CDC: per-table AFTER triggers + a change-log watermark, for managed Postgres where a logical-replication slot isn't available.</td></tr>
  <tr><td><code>sqlite-trigger</code></td><td class="desc">CDC <strong>source</strong></td><td class="desc">Trigger-based continuous sync from a local SQLite file: per-table AFTER triggers + a <code>sluice_change_log</code> watermark for exactly-once resume (ADR-0135).</td></tr>
  <tr><td><code>d1-trigger</code></td><td class="desc">CDC <strong>source</strong></td><td class="desc">The same trigger-CDC design over a live D1's HTTP query API (ADR-0136).</td></tr>
  </tbody></table>
  <div class="note"><strong>WAN-fast MySQL CDC apply (ADR-0139/0140).</strong> Against a MySQL / PlanetScale-MySQL target, consecutive same-shape INSERTs fold into one multi-row <code>INSERT … ON DUPLICATE KEY UPDATE</code>, UPDATEs apply as that same keyed upsert, and DELETEs coalesce into one <code>DELETE … WHERE pk IN (…)</code> — turning N round trips into one so high-latency / cross-region apply keeps up. A rate-limited INFO line (<code>rows_per_stmt</code>) reports the coalescing ratio so you can see whether it's helping.</div>
  <div class="note"><strong>Rich types over continuous CDC.</strong> Continuous sync now carries the types that earlier only cold-started: PostgreSQL arrays (<code>int4[]</code>, <code>text[]</code>, <code>numeric[]</code>, …, multi-dimensional preserved), MySQL <code>ENUM</code> and <code>SET</code>, MySQL→PG and PG→PG <code>ENUM</code>, and PostGIS <code>geometry</code> (every subtype/dimension, SRID preserved) — all over the CDC apply path, in both source directions (v0.99.50–v0.99.60). PostGIS <code>geography</code>, arrays of geometry (<code>geometry[]</code>), and arrays of enum (<code>enum[]</code>) remain <strong>loudly refused</strong> over CDC — no silent loss.</div>`
)}

<h2 id="migrate">migrate</h2>
${cmd(
  "migrate-c",
  "sluice migrate",
  "Run a one-time schema + data migration: translate the schema, create tables, bulk-copy rows, then build indexes and constraints.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--source-driver</code> / <code>--source</code></td><td class="desc">Source engine name and DSN (or <code>SLUICE_SOURCE</code>).</td></tr>
  <tr><td><code>--target-driver</code> / <code>--target</code></td><td class="desc">Target engine name and DSN (or <code>SLUICE_TARGET</code>).</td></tr>
  <tr><td><code>--dry-run</code>, <code>-n</code></td><td class="desc">Print the plan; don't touch the target.</td></tr>
  <tr><td><code>--include-table</code> / <code>--exclude-table</code></td><td class="desc">Glob-aware table filters (mutually exclusive). Scope the bulk copy — including the PlanetScale (VStream) snapshot — not just the write path.</td></tr>
  <tr><td><code>--include-database</code> / <code>--exclude-database</code> / <code>--all-databases</code></td><td class="desc">Multi-database fan-out (ADR-0074, <strong>MySQL source</strong>): migrate several source databases in one run, each to a same-named target namespace. Glob-aware; system databases (<code>information_schema</code>, <code>mysql</code>, …) are always excluded. When any database-scope flag is set the source DSN's database is optional (it's a server connection).</td></tr>
  <tr><td><code>--include-schema</code> / <code>--exclude-schema</code> / <code>--all-schemas</code></td><td class="desc">Multi-schema fan-out (ADR-0075, <strong>Postgres source</strong>): the PG-source synonyms of the <code>-database</code> family. System schemas (<code>pg_catalog</code>, <code>information_schema</code>, …) are always excluded. <strong>MySQL source uses the <code>-database</code> spelling, PG source uses <code>-schema</code>; supplying both spellings in one invocation is a hard error.</strong></td></tr>
  <tr><td><code>--map-database</code> / <code>--map-schema</code></td><td class="desc"><code>SRC=DST</code> — rename a namespace on the way (ADR-0142, repeatable). Without it a fan-out lands each source namespace in a <strong>same-named</strong> target; this routes <code>SRC</code> to a differently-named <code>DST</code> (snapshot <em>and</em> CDC). <code>--map-database</code> for a MySQL source, <code>--map-schema</code> for a Postgres source (same rule as the fan-out spellings). The rename is engine-side only — source-keyed <code>--redact</code> / <code>--type-override</code> still match on the original name.</td></tr>
  <tr><td><code>--allow-degraded-fks</code></td><td class="desc">PG-target only: tolerate a dirty FK source — when <code>ADD CONSTRAINT FOREIGN KEY</code> fails on orphan rows (SQLSTATE 23503), retry as <code>NOT VALID</code> and surface the degraded constraint at the end (run <code>VALIDATE CONSTRAINT</code> after fixing the orphans). Default off (loud failure on a dirty source). MySQL has no per-constraint <code>NOT VALID</code> and refuses loudly if this is set against a MySQL target.</td></tr>
  <tr><td><code>--resume</code>, <code>-r</code></td><td class="desc">Resume a failed migration from per-table checkpoints on the target.</td></tr>
  <tr><td><code>--bulk-parallelism</code></td><td class="desc">Parallel reader/writer pairs per large table (0 = auto, 1 = off). Since v0.99.64 (ADR-0096) within-table chunking covers single non-integer PKs (UUID/string/binary/decimal/temporal) and all-orderable composite PKs via sampled-keyset chunking — not just single-integer PKs. Tables with no usable PK (or a non-orderable PK column like JSON/array/geometry) still take the single-reader path.</td></tr>
  <tr><td><code>--bulk-parallel-min-rows</code></td><td class="desc">Row-count threshold below which a table is copied with a single reader/writer pair regardless of <code>--bulk-parallelism</code>. 0 = auto (base 80000, dialled down on many-table schemas).</td></tr>
  <tr><td><code>--table-parallelism</code></td><td class="desc">Tables copied concurrently (0 = auto: 4, 1 = off). Multiplies with <code>--bulk-parallelism</code>; the product is bounded by the target connection budget.</td></tr>
  <tr><td><code>--max-target-connections</code></td><td class="desc">Connection budget on the target the parallelism product must fit inside.</td></tr>
  <tr><td><code>--index-build-parallelism</code></td><td class="desc">Postgres-only: deferred indexes built concurrently after the bulk copy.</td></tr>
  <tr><td><code>--type-override</code></td><td class="desc"><code>TABLE.COLUMN=TYPE</code> — force a target column type (repeatable).</td></tr>
  <tr><td><code>--redact</code></td><td class="desc">Redact a PII column, e.g. <code>users.email=hash:sha256</code> (repeatable).</td></tr>
  <tr><td><code>--infer-types</code></td><td class="desc">SQLite / D1 source only (ADR-0144): opt-in, <strong>data-validated</strong> promotion of conservatively-typed columns to native target types — <code>INTEGER</code>→<code>boolean</code>, ISO-8601 <code>TEXT</code>→<code>timestamptz</code>/<code>timestamp</code>, JSON <code>TEXT</code>→<code>jsonb</code>, UUID <code>TEXT</code>→<code>uuid</code> — but only after an exhaustive aggregate over the actual data confirms <em>every</em> value qualifies; otherwise the column keeps its safe type. Mixed-offset / sub-µs temporal columns and non-UUID <code>*_id</code> values stay <code>text</code>, never silently coerced. An explicit <code>--type-override</code> always wins. Off by default. Against a live D1, auto-engages <code>--stage-local</code> (below).</td></tr>
  <tr><td><code>--stage-local</code> / <code>--no-stage-local</code></td><td class="desc">Cloudflare D1 source only (ADR-0145, v0.99.167): first replicate the live D1 into a <strong>byte-faithful</strong> local SQLite file (verbatim DDL + exact storage classes, integers above 2<sup>53</sup> included — lossless, unlike <code>wrangler d1 export</code>), then migrate from that file. Sidesteps D1's HTTP query limits (the per-query CPU ceiling and the <code>GLOB</code> pattern-complexity limit that block <code>--infer-types</code> on a live D1). <strong>Auto-engaged</strong> by <code>--infer-types</code> against a D1 source; set <code>--stage-local</code> explicitly to stage without inference, or <code>--no-stage-local</code> to force the direct path. The staged file is created in the system temp dir and removed when the migrate finishes. Mutually exclusive.</td></tr>
  <tr><td><code>--include-orm-tables</code> / <code>--skip-orm-tables</code></td><td class="desc">ORM bookkeeping tables (Rails <code>schema_migrations</code>, Prisma <code>_prisma_migrations</code>, Drizzle <code>__drizzle_*</code>, Laravel <code>migrations</code>, Flyway, Goose, …) carry the <em>source</em> engine's migration state, which is meaningless on a different target engine. On a <strong>cross-engine</strong> migrate they're skipped by default, each skip announced by name; <code>--include-orm-tables</code> copies them anyway. A same-engine run keeps them (the history is still valid) unless you pass <code>--skip-orm-tables</code>. The two flags are mutually exclusive.</td></tr>
  <tr><td><code>--target-schema</code></td><td class="desc">Postgres-only: land tables under a named schema namespace.</td></tr>
  <tr><td><code>--inject-shard-column</code></td><td class="desc"><code>NAME=VALUE</code> — ADR-0048 Shape A: inject a sluice-managed discriminator column on a consolidated target so per-shard rows from a multi-shard Vitess source land disjoint via a composite PK. Each per-shard run passes a distinct VALUE.</td></tr>
  <tr><td><code>--allow-cross-shard-merge</code></td><td class="desc">Opt out of the cross-shard-collision preflight (Bug 152). Off by default the guard is active: a multi-shard Vitess/PlanetScale source without <code>--inject-shard-column</code> refuses to merge into a single PK/UNIQUE target. Pass this only when the key is globally unique across shards.</td></tr>
  <tr><td><code>--reset-target-data</code></td><td class="desc">Destructive recovery: drop source-schema tables on the target, then cold-start. Prompts (type <code>reset</code>) unless <code>--yes</code>. Mutually exclusive with <code>--resume</code>.</td></tr>
  </tbody></table>
  <p><strong>Filtered dry run, then apply:</strong></p>
  ${pre(`sluice migrate --source-driver mysql --source ... --target-driver postgres --target ... \\
    --include-table 'app_*' --exclude-table 'app_audit' --dry-run`)}
  <p><strong>Redact PII as it copies:</strong></p>
  ${pre(`sluice migrate --source-driver mysql --source ... --target-driver postgres --target ... \\
    --redact users.email=hash:sha256 \\
    --redact users.ssn=mask:ssn`)}
  <p><strong>Import a SQLite file / <code>.sql</code> dump, or a live Cloudflare D1:</strong> point <code>--source-driver</code> at <code>sqlite</code> (a <code>.db</code> file or an auto-detected <code>wrangler d1 export</code> <code>.sql</code> dump) or <code>d1</code> (a <code>d1://</code> DSN; token via <code>CLOUDFLARE_API_TOKEN</code>). Big integers above 2<sup>53</sup> round-trip exactly; declared <code>DATE</code> / <code>DATETIME</code> columns are decoded per <code>--sqlite-date-encoding</code>. SQLite is also a target (<code>--target-driver sqlite</code>).</p>
  ${pre(`sluice migrate --source-driver sqlite --source ./app.db \\
    --target-driver postgres --target 'postgres://...?sslmode=disable'
sluice migrate --source-driver d1 --source 'd1://<account_id>/<database_id>' \\
    --target-driver mysql --target 'user:pass@tcp(host:3306)/app'`)}
  <div class="note"><strong>No-PRIMARY-KEY tables (v0.99.13).</strong> A source table with no declared <code>PRIMARY KEY</code> but a NOT-NULL <code>UNIQUE</code> key now migrates and syncs <strong>MySQL→Postgres</strong> without a manual schema change — sluice promotes the unique key for an idempotent copy (this already worked MySQL→MySQL). A table with no PK and no NOT-NULL unique key is still refused loudly.</div>`
)}

<h2 id="sync-start">sync start</h2>
${cmd(
  "sync-start-c",
  "sluice sync start",
  "Start (or resume) a continuous-sync stream: consistent snapshot → bulk copy → ongoing CDC. Identified by --stream-id for clean restart.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--stream-id</code></td><td class="desc">Stream identifier; the key its position is persisted under on the target.</td></tr>
  <tr><td><code>--slot-name</code></td><td class="desc">Postgres replication-slot suffix (default <code>sluice_slot</code>); set per-instance to run several streams off one source.</td></tr>
  <tr><td><code>--apply-batch-size</code></td><td class="desc">CDC changes per target tx, or <code>auto</code>. Default <code>auto</code> (v0.99.44, ADR-0089): the AIMD latency controller adapts the batch size within <code>[1, ceiling]</code> to a p95 target for >10× throughput over single-row apply. Ceilings: 1000 mysql/postgres, 100 planetscale. Pass <code>=1</code> for the conservative one-change-per-tx behavior. Tables with no usable identity key (no PK, no unique index) are never batched — each such change commits alone.</td></tr>
  <tr><td><code>--no-auto-tune</code></td><td class="desc">Disable the AIMD controller. <code>--apply-batch-size=N</code> then becomes a strictly static row cap (floor stays 1) instead of an adaptive ceiling. For workloads where you've hand-tuned the batch size and want no auto-adaptation.</td></tr>
  <tr><td><code>--apply-concurrency</code></td><td class="desc">CDC apply lane count <code>W</code> (ADR-0104/0105/0106; engine-general — MySQL <em>and</em> Postgres). The merged change stream is fanned across <code>W</code> in-order lanes by primary-key hash (same key → same lane → applied in source order, so dependent INSERT→UPDATE→DELETE never reorder), each lane committing concurrently on its own connection with its own AIMD batch controller. <code>0</code> (default, unset) = <code>auto:N</code> — the new fast-by-default adaptive concurrent path: Postgres <code>min(4, slot-budget)</code>, MySQL/PlanetScale a fixed 4. <code>1</code> = explicit serial opt-out (byte-identical to the pre-fast-by-default behaviour). <code>W&gt;1</code> honored verbatim. Exactly-once for keyed tables (the position advances only to a boundary durable across <em>all</em> lanes). An in-lane PlanetScale tx-killer (MySQL) or serialization/deadlock (Postgres) is recovered <em>in-lane</em> — split-and-retried idempotently, no stream restart.</td></tr>
  <tr><td><code>--schema-changes</code></td><td class="desc"><code>forward</code> (default, ADR-0091) auto-applies unambiguous source DDL — ADD/DROP/ALTER COLUMN, CREATE/DROP INDEX, ADD/DROP/MODIFY CHECK — on the target so the sync stays online through schema evolution. <code>refuse</code> restores the conservative pre-v0.92 behavior: any source DDL surfaces loudly with the drained-model recovery hint. RENAME COLUMN and a computed/volatile DEFAULT on ADD COLUMN always refuse loudly. See the warn box below.</td></tr>
  <tr><td><code>--copy-fanout-degree</code></td><td class="desc">VStream/CDC snapshot cold-start (PlanetScale-MySQL target) only, ADR-0097: WRITE-side fan-out — the incoming snapshot row stream is PK-hash-partitioned out to N concurrent batched-INSERT writers, each on its own connection, to beat the single round-trip-bound INSERT connection vtgate forces. 0 = auto: 4; 1 = serial. Bounded by the target connection budget.</td></tr>
  <tr><td><code>--no-auto-resnapshot</code></td><td class="desc">Opt out of the automatic re-snapshot when a resume hits a purged/invalid source position (v0.99.51, ADR-0093). By default a resume from a position older than the source's retained binlogs — routine on PlanetScale's retention window — auto-recovers with a fresh cold-start re-snapshot; with this flag set, sluice instead fails loudly with the recovery commands named, so a full re-snapshot of very large tables is a deliberate choice.</td></tr>
  <tr><td><code>--inject-shard-column</code></td><td class="desc"><code>NAME=VALUE</code> — ADR-0048 Shape A discriminator column for consolidating a multi-shard Vitess source onto one target (per-shard streams pass distinct VALUEs). See the <a href="/docs/commands/#migrate">migrate</a> row.</td></tr>
  <tr><td><code>--allow-cross-shard-merge</code></td><td class="desc">Opt out of the cross-shard-collision preflight (Bug 152) — see the <a href="/docs/commands/#migrate">migrate</a> row. Off by default the guard is active.</td></tr>
  <tr><td><code>--metrics-listen</code></td><td class="desc">Bind a Prometheus <code>/metrics</code> + <code>/readyz</code> endpoint, e.g. <code>:9090</code>. Exports <code>sluice_build_info</code>, a Go-runtime block, and — when PlanetScale telemetry is configured (below) — the <code>sluice_target_*</code> CPU/mem/storage/lag gauge family. See <a href="/docs/configuration/#metrics">/metrics export</a>.</td></tr>
  <tr><td><code>--position-from-manifest</code></td><td class="desc">URL of a backup chain (<code>s3://</code>, <code>gs://</code>, <code>azblob://</code>, <code>file:///</code>) whose terminal manifest's <code>EndPosition</code> becomes this stream's resume position — resume CDC from a restored chain's tail without re-bulking. Bypasses the persisted <code>sluice_cdc_state</code> position. PG soft preflight warnings fire here; <code>--strict-preflight</code> promotes them to refusals. (Mutually exclusive with <code>--restart-from-scratch</code> / <code>--reset-target-data</code>.)</td></tr>
  <tr><td><code>--planetscale-org</code></td><td class="desc">PlanetScale org slug — enables OPTIONAL target-health telemetry (CPU/mem/storage/lag) read from the PlanetScale metrics endpoint (ADR-0107). A <strong>control-plane credential, distinct from the data-plane <code>--target</code> DSN</strong>. Feeds proactive apply back-off and the <code>sluice_target_*</code> gauges. Opt-in and <strong>all-or-nothing</strong>: setting the org without <em>both</em> token flags is a loud refusal. Off when unset (default sync unchanged).</td></tr>
  <tr><td><code>--planetscale-metrics-token-id</code> / <code>--planetscale-metrics-token</code></td><td class="desc">PlanetScale service-token (granted <code>read_metrics_endpoints</code>) ID + secret for <code>--planetscale-org</code> telemetry. Set via the env vars <code>PLANETSCALE_METRICS_TOKEN_ID</code> / <code>PLANETSCALE_METRICS_TOKEN</code> — never on the command line; masked in all logging.</td></tr>
  <tr><td><code>--planetscale-metrics-db</code> / <code>--planetscale-metrics-branch</code></td><td class="desc">Database (defaults to the <code>--target</code> DSN's database) and branch (default <code>main</code>) the telemetry series is filtered to. Only consulted when <code>--planetscale-org</code> is set.</td></tr>
  <tr><td><code>--suppress-target-metrics-history</code></td><td class="desc">Disable persisting polled target-health metrics to the <code>sluice_target_metrics_history</code> table (7-day retention, pruned). History is <strong>on by default</strong> when telemetry is configured; it lets <code>sluice diagnose</code> show the recent CPU/mem/storage/lag trend without scripting the metrics API. Advisory + failure-isolated — never affects the sync.</td></tr>
  <tr><td><code>--notify-webhook</code> / <code>--notify-slack</code></td><td class="desc">Threshold-alert sinks (also accepted by <a href="/docs/commands/#metrics-watch">metrics-watch</a>): a generic webhook (JSON POST) and/or a Slack incoming-webhook. Set the URLs via the env vars <code>SLUICE_NOTIFY_WEBHOOK</code> / <code>SLUICE_NOTIFY_SLACK</code>. Advisory + failure-isolated (a dead sink is logged-and-swallowed); require <code>--planetscale-org</code> telemetry plus at least one threshold below.</td></tr>
  <tr><td><code>--notify-storage-util</code> / <code>--notify-cpu-util</code> / <code>--notify-mem-util</code></td><td class="desc">Alert when the target's storage / CPU / memory utilisation (a fraction <code>0–1</code>, <em>used/capacity</em>) is at or above the threshold. Edge-triggered + cooldown'd. <code>0</code> disables a rule.</td></tr>
  <tr><td><code>--notify-lag-seconds</code> / <code>--notify-storage-growth-per-min</code></td><td class="desc">Alert when replica lag (seconds) is at or above the value, or when storage utilisation is <em>climbing</em> at or above this fraction-of-capacity per minute (a pre-grow early warning, e.g. <code>0.02</code> = +2%/min). <code>0</code> disables.</td></tr>
  <tr><td><code>--notify-cooldown</code></td><td class="desc">Minimum interval between re-fires of a still-breached alert (default <code>15m</code>) — a sustained breach reminds at most once per interval, not every poll.</td></tr>
  <tr><td><code>--apply-retry-attempts</code></td><td class="desc">Max consecutive retriable apply failures absorbed before exiting (ADR-0038, default <code>8</code> — tuned for managed-Vitess tx-killer transients). <code>1</code> = no retry. The counter resets whenever the persisted CDC position advances.</td></tr>
  <tr><td><code>--apply-retry-backoff-base</code> / <code>--apply-retry-backoff-cap</code></td><td class="desc">Exponential backoff between retriable apply failures: base <code>100ms</code> (doubling), capped at <code>30s</code>. Only consulted when <code>--apply-retry-attempts &gt; 1</code>.</td></tr>
  <tr><td><code>--apply-exec-timeout</code></td><td class="desc">Per-statement deadline on every apply-path <code>ExecContext</code> (default <code>60s</code>). Closes the silent-stall mode where a half-closed target connection blocks the apply goroutine inside the driver; on expiry the batch is retried on a fresh connection. <code>0</code> disables (unbounded).</td></tr>
  <tr><td><code>--source-heartbeat-interval</code></td><td class="desc">Write a heartbeat row on the source every interval so the slot/binlog can't be evicted past the consumer against an idle source.</td></tr>
  <tr><td><code>--dry-run</code>, <code>-n</code></td><td class="desc">Show cold-start vs warm-resume and the planned actions without starting.</td></tr>
  <tr><td><code>--schema-already-applied</code></td><td class="desc">Skip all cold-start DDL (you promise the target catalog matches). For Atlas/Liquibase-managed or PlanetScale Safe-Migrations targets.</td></tr>
  <tr><td><code>--include-table</code> / <code>--exclude-table</code></td><td class="desc">Glob-aware table filters (mutually exclusive). Scope the cold-start snapshot <em>and</em> its resume — including the PlanetScale (VStream) snapshot, so an excluded table in a large keyspace is never streamed (v0.99.12–v0.99.13), not just the write path.</td></tr>
  <tr><td><code>--force-cold-start</code></td><td class="desc">Skip the pre-flight check that refuses to bulk-copy into a populated target. Use with caution — an INSERT into a non-empty table can collide on the primary key. Still warm-resumes from a persisted position (it only skips the check); ignored on the warm-resume path.</td></tr>
  <tr><td><code>--reset-target-data</code></td><td class="desc">Destructive recovery: delete the CDC-state row, DROP every source-schema table on the target, then run a fresh cold-start. For a wedged-state recovery (e.g. slot-missing fall-through). Prompts (type <code>reset</code>) unless <code>--yes</code>. See ADR-0023.</td></tr>
  <tr><td><code>--restart-from-scratch</code></td><td class="desc">Force a fresh cold-start re-copy from the beginning, ignoring any persisted resume position (incl. a mid-COPY cursor) — <em>without</em> dropping the target (the idempotent copy absorbs the overlap). For a bad checkpoint. Differs from <code>--force-cold-start</code> (keeps the position) and <code>--reset-target-data</code> (drops tables). (v0.99.10)</td></tr>
  </tbody></table>
  <div class="note warn"><strong>Source DDL auto-applies by default (v0.99.45, ADR-0091).</strong> A running stream now forwards unambiguous source schema changes onto the target automatically — including a <strong>destructive <code>DROP COLUMN</code></strong>, which drops the column (and its data) on the target. This keeps the sync online through routine schema evolution, but it means a source DDL change propagates without operator review. To gate DDL through a separate change-management process, start the stream with <code>--schema-changes=refuse</code> — any source DDL then surfaces loudly instead of applying. (The older <code>--forward-schema-add-column</code> flag is deprecated: it warns and still forwards, subsumed by the new default.)</div>
  <div class="note"><strong>Mid-stream reshard is followed automatically (v0.99.62, ADR-0094).</strong> A PlanetScale/Vitess source reshard (shard split/merge, <code>MoveTables</code>) used to halt the sync as a loud terminal error. The Streamer now reopens onto the new shard layout from the journal-stamped GTIDs and continues with no gap and no re-snapshot. (Not yet auto-followed when <code>--inject-shard-column</code> is engaged — that interplay keeps the prior loud-terminal behavior.)</div>
  <div class="note"><strong>Multi-table Vitess keyspaces cold-copy in one command (v0.99.63, ADR-0095).</strong> A full Vitess/PlanetScale keyspace now cold-copies in a single <code>sync start</code> at bounded memory — the engine auto-shards the VStream COPY by table internally, so there's no per-table <code>--include-table</code> workaround. On by default for a fresh multi-table cold-start; opt out with <code>vstream_copy_single_stream=true</code> in the source DSN (see <a href="/docs/configuration/#dsn-tuning">Source-DSN tuning parameters</a>).</div>
  <div class="note"><strong>The apply path is adaptive-concurrent by default (v0.99.100+, ADR-0106).</strong> With <code>--apply-concurrency</code> unset, CDC apply fans out across an auto-chosen number of PK-hash lanes (Postgres <code>min(4, slot-budget)</code>; MySQL/PlanetScale 4) — exactly-once for keyed tables, with per-lane AIMD and in-lane tx-killer/deadlock recovery. To force the old strictly-serial apply, pass <code>--apply-concurrency 1</code>.</div>
  <div class="note"><strong>Resilient on managed / PlanetScale targets (no flags needed).</strong> sluice automatically rides PlanetScale storage-grow and primary-reparent serving transitions without operator intervention — across cold-copy writes, cold-copy source reads, the coordinated grow-gate, restore reconciliation, and (new in v0.99.118) the post-copy DDL phase (index / constraint / view build). Transient errors during a transition are bounded-retried and loud only on genuine exhaustion.</div>
  <p><strong>Run as a service with metrics + idle-source heartbeat:</strong></p>
  ${pre(`sluice sync start --source-driver postgres --source ... --target-driver mysql --target ... \\
    --stream-id reporting \\
    --metrics-listen :9090 \\
    --source-heartbeat-interval 30s`)}
  <p><strong>With PlanetScale target-health telemetry + a storage alert</strong> (tokens via env, control-plane credential distinct from <code>--target</code>):</p>
  ${pre(`export PLANETSCALE_METRICS_TOKEN_ID=...   # the read_metrics_endpoints service token
export PLANETSCALE_METRICS_TOKEN=...
export SLUICE_NOTIFY_SLACK=https://hooks.slack.com/services/...
sluice sync start --source-driver mysql --source ... --target-driver planetscale --target ... \\
    --stream-id app-prod \\
    --planetscale-org acme --planetscale-metrics-db app \\
    --notify-storage-util 0.85 --notify-slack "$SLUICE_NOTIFY_SLACK"`)}`
)}

<h2 id="sync-manage">sync status / stop / health</h2>
${cmd(
  "sync-manage-c",
  "sluice sync status · stop · health",
  "Inspect, gracefully stop, and health-check a running stream. All take --stream-id plus the target connection.",
  `<ul>
   <li><code>sync status</code> — show the stream's persisted position and phase.</li>
   <li><code>sync stop</code> — request the stream to drain in-flight changes and exit cleanly. By default it just files the stop request and returns; pass <code>--wait</code> / <code>-w</code> to block until the running streamer drains and clears its stop signal (with <code>--timeout</code>, default <code>5m</code>; on timeout the CLI exits non-zero and the stop request remains in place). Use <code>--wait</code> to coordinate ALTER windows or scripted teardowns.</li>
   <li><code>sync health</code> — probe freshness against thresholds and return a cron-friendly exit code (non-zero when stale).</li>
   </ul>
   ${pre(`sluice sync stop   --stream-id app-prod --target-driver postgres --target ... --wait --timeout 10m
sluice sync health --stream-id app-prod --target-driver postgres --target ... \\
    --max-stale-seconds 300   # exit non-zero if the last apply was more than 5 minutes ago`)}
   <p><code>sync health</code>'s freshness check is <code>--max-stale-seconds N</code> (target-side wall-clock seconds since the last apply; <code>0</code> = informational only). When you also pass <code>--source-driver</code> + <code>--source</code> the probe reads the source position too and, on a <strong>PG→PG</strong> pair, exposes <code>--max-lag-bytes N</code> (source LSN bytes ahead of target; MySQL GTID sets aren't byte-distance comparable). Both exit <code>1</code> when breached — cron-friendly.</p>`
)}

<h2 id="schema-add-table">schema add-table</h2>
${cmd(
  "schema-add-table-c",
  "sluice schema add-table &lt;table&gt;",
  "Bring a new source table into an active stream's scope without a destructive --reset-target-data cycle. Drain the stream first via 'sluice sync stop --wait'.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>&lt;table&gt;</code> (argument)</td><td class="desc">Unqualified name of the new source table; its schema/database is inferred from <code>--source</code>.</td></tr>
  <tr><td><code>--stream-id</code></td><td class="desc">Required — must match the active stream's id (run <code>sluice sync status</code> to confirm).</td></tr>
  <tr><td><code>--type-override</code> / <code>--expr-override</code></td><td class="desc">Per-column overrides for the new table (repeatable).</td></tr>
  <tr><td><code>--target-schema</code></td><td class="desc">Postgres-only: must match the active stream's <code>--target-schema</code>, or be omitted to inherit the recorded value.</td></tr>
  <tr><td><code>--no-drain</code></td><td class="desc">Phase 2 live add: run against an actively-streaming sync without first running <code>sync stop --wait</code>. PG-only in this release; MySQL sources still require the drained workflow.</td></tr>
  <tr><td><code>--dry-run</code>, <code>-n</code> / <code>--yes</code>, <code>-y</code></td><td class="desc">Print the plan without modifying anything / skip the typed-confirmation prompt.</td></tr>
  </tbody></table>
  ${pre(`# drain first, add the table, then resume
sluice sync stop --stream-id app-prod --target-driver postgres --target ... --wait
sluice schema add-table new_events \\
    --source-driver mysql --source ... --target-driver postgres --target ... \\
    --stream-id app-prod
sluice sync start --stream-id app-prod --source-driver mysql --source ... --target-driver postgres --target ...`)}`
)}

<h2 id="sync-from-backup">sync from-backup</h2>
${cmd(
  "sync-from-backup-c",
  "sluice sync from-backup run · stop",
  "Replay a backup chain into a target as a long-running broker — polls a chain root (S3/GCS/Azure/local) for new incrementals and applies them. No direct source↔target connectivity required.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--backup-target</code> / <code>--backup-dir</code></td><td class="desc">The chain location: a URL (<code>s3://</code>, <code>gs://</code>, <code>azblob://</code>, <code>file:///</code>) or a local directory. Mutually exclusive.</td></tr>
  <tr><td><code>--backup-endpoint</code> / <code>--backup-region</code> / <code>--backup-path-style</code></td><td class="desc">S3-compatible-provider knobs (R2 / B2 / MinIO / Wasabi / Tigris); only meaningful when <code>--backup-target</code> is an <code>s3://</code> URL.</td></tr>
  <tr><td><code>--target-driver</code> / <code>--target</code></td><td class="desc">Target engine name and DSN (or <code>SLUICE_TARGET</code>).</td></tr>
  <tr><td><code>--stream-id</code></td><td class="desc">Required. The key the broker's chain-state position is persisted under on the target — needed for clean restart resume.</td></tr>
  <tr><td><code>--apply-concurrency</code></td><td class="desc">Key-hash concurrent-apply lane count <code>W</code> for incremental replay (the same machinery <code>sync start</code> uses). <code>0</code> (default) = <code>auto:4</code>; <code>1</code> = serial; <code>W&gt;1</code> honored. Matters for high-latency / cross-region targets — without it a large incremental replays through a single RTT-bound stream. Exactly-once preserved.</td></tr>
  <tr><td><code>--reset-target-data</code></td><td class="desc">Cold-start recovery: drop target tables, run a chain restore (full + every incremental), then transition to live polling. Prompts (type <code>reset</code>) unless <code>--yes</code>. Mutually exclusive with <code>--at-chain-id</code>.</td></tr>
  <tr><td><code>--at-chain-id</code></td><td class="desc">Operator-asserted resume: treat the target as currently at chain ID <code>&lt;ID&gt;</code> (e.g. after a manual <code>sluice restore</code>), write a fresh state row, and tail forward. Mutually exclusive with <code>--reset-target-data</code>.</td></tr>
  <tr><td><code>--poll-interval</code></td><td class="desc">Cadence each broker tick runs at (default <code>30s</code>); new incrementals are applied within ~one interval of their source-side commit.</td></tr>
  <tr><td><code>--apply-batch-size</code></td><td class="desc">CDC changes per target transaction during replay (default <code>100</code>). Idempotent applier semantics keep replay-on-crash safe.</td></tr>
  <tr><td><code>--max-buffer-bytes</code></td><td class="desc">Soft cap on per-batch buffered memory in the CDC applier. Default <code>67108864</code> (64 MiB).</td></tr>
  </tbody></table>
  <p>The full walkthrough — producing the chain, cold-start vs warm-resume, stopping — is in the <a href="/docs/from-backup-sync/">backup-chain sync guide</a>.</p>
  ${pre(`sluice sync from-backup run \\
    --backup-target s3://my-bucket/app-chain \\
    --target-driver postgres --target ... \\
    --stream-id app-broker --apply-concurrency 4 --poll-interval 30s

sluice sync from-backup stop --backup-target s3://my-bucket/app-chain`)}`
)}

<h2 id="cutover">cutover</h2>
${cmd(
  "cutover-c",
  "sluice cutover",
  "Two-phase sequence priming at cutover: re-read source sequence / AUTO_INCREMENT state and apply it to the target with a safety margin, so the first post-cutover INSERT can't collide on the primary key.",
  `${pre(`sluice cutover --config sluice.yaml --cutover-sequence-margin 1000`)}
   <p>Run after the snapshot has caught up and just before switching application traffic to the target.</p>`
)}

<h2 id="backup">backup</h2>
${cmd(
  "backup-c",
  "sluice backup",
  "Take and verify logical backups — full snapshots and incremental chains, optionally encrypted, to local FS or object storage.",
  `<table><thead><tr><th>Subcommand</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>backup full</code></td><td class="desc">Take a full snapshot (chain root).</td></tr>
  <tr><td><code>backup incremental</code></td><td class="desc">Append an incremental onto the existing chain.</td></tr>
  <tr><td><code>backup stream run</code> / <code>stop</code></td><td class="desc">Run as a long-lived process appending incrementals at a rolling cadence; <code>stop</code> drains the in-flight rollover and exits cleanly.</td></tr>
  <tr><td><code>backup verify</code></td><td class="desc">Re-checksum every chunk in a chain and report mismatches.</td></tr>
  <tr><td><code>backup prune</code> / <code>compact</code></td><td class="desc">Retention: drop the oldest segments, or merge consecutive segments whose gaps fall within <code>--merge-window</code>. Compact splits a merge group at a rotation-boundary coverage gap instead of refusing the run (v0.99.41) — chains stopped while the source was idle stay compactable.</td></tr>
  </tbody></table>
  <table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--output-dir</code> / <code>--target</code></td><td class="desc">Destination: a local directory, or a URL (<code>s3://</code>, <code>gs://</code>, <code>azblob://</code>, <code>file:///</code>). Mutually exclusive.</td></tr>
  <tr><td><code>--chain-slot</code></td><td class="desc">Postgres-only, on <code>backup full</code>: provision the persistent replication slot (named by <code>--slot-name</code>) as the snapshot anchor and ensure the publication, so <code>backup incremental</code> chains with zero gap and no manual slot setup. (v0.99.35)</td></tr>
  <tr><td><code>--table-parallelism</code></td><td class="desc">Tables read concurrently during the backup sweep (the read-side analog of <code>pg_dump -j</code>); <code>0</code> = auto (4). Postgres pins every parallel reader to one shareable exported snapshot; vanilla MySQL coordinates N readers under a brief FTWRL window (v0.99.43, ADR-0088) — both match the serial sweep's cross-table consistency. MySQL falls back to a serial single reader (a loud INFO names why) without <code>RELOAD</code>. (v0.99.39 / v0.99.43)</td></tr>
  <tr><td><code>--include-table</code> / <code>--exclude-table</code></td><td class="desc">Glob-aware table filters; scope the backup snapshot itself — including the PlanetScale (VStream) snapshot — so an excluded table in a large keyspace is never streamed (v0.99.13), not just what's written.</td></tr>
  <tr><td><code>--compression</code></td><td class="desc">Per-segment chunk codec: <code>none</code> | <code>gzip</code> | <code>zstd</code>. Default <strong><code>zstd</code></strong> (55–85% faster restore — the DR-critical axis; ~1–5% larger than gzip). <code>none</code> leaves chunks as human-readable <code>.jsonl</code> on a local-FS target. Recorded in <code>lineage.json</code> and read back from there on restore (never inferred from bytes).</td></tr>
  <tr><td><code>--encrypt</code></td><td class="desc">Enable client-side envelope encryption. Requires exactly one key source (below). The chain rests encrypted; <code>restore</code> / <code>verify</code> / the broker read the same flag to unwrap.</td></tr>
  <tr><td><code>--encryption-passphrase-env</code> / <code>--encryption-passphrase-file</code></td><td class="desc">Passphrase mode: read the passphrase from an environment variable or a file (preferred over <code>--encryption-passphrase</code>, which lands in shell history). The chain root records the Argon2id params so incrementals and restores re-derive the KEK — operators only remember the passphrase.</td></tr>
  <tr><td><code>--kms-key-arn</code> / <code>--gcp-kms-key-resource</code> / <code>--azure-key-vault-id</code></td><td class="desc">KMS mode: wrap the CEK through AWS KMS, GCP Cloud KMS, or Azure Key Vault respectively — the root key never leaves the cloud KMS. Mutually exclusive with each other and with the passphrase flags. KMS and passphrase modes can't be mixed within one chain.</td></tr>
  </tbody></table>
  ${pre(`sluice backup full --source-driver postgres --source ... --target s3://my-bucket/app-chain --chain-slot
sluice backup incremental --source-driver postgres --source ... --target s3://my-bucket/app-chain`)}
  <div class="note"><strong>Full backups are engine-neutral; incremental chains need a CDC source.</strong> <code>backup full</code> works against any registered source — including <code>sqlite</code> (a local file). <code>backup incremental</code> appends changes since the chain root, so it needs a CDC-capable source: Postgres / MySQL natively, or the trigger-CDC engines for SQLite / D1 (<code>sqlite-trigger</code> / <code>d1-trigger</code>). A base <code>sqlite</code> source is migrate-only (no CDC), so it can root a full backup but not extend an incremental chain.</div>
  <div class="note"><strong>Values that used to break backups (v0.99.40).</strong> IEEE-special floats (<code>NaN</code>, <code>±Infinity</code>) now ride the chunk codec exactly — one such row no longer makes a table un-backupable, and restores are bit-identical to <code>pg_dump</code>.</div>`
)}

<h2 id="restore">restore</h2>
${cmd(
  "restore-c",
  "sluice restore",
  "Restore a logical backup chain (full + every incremental up to the tail) into a target database.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--from-dir</code> / <code>--from</code></td><td class="desc">Backup location: a local directory, or a URL (<code>s3://</code>, <code>gs://</code>, <code>azblob://</code>, <code>file:///</code>). Mutually exclusive.</td></tr>
  <tr><td><code>--target-driver</code> / <code>--target</code></td><td class="desc">Target engine name and DSN. Accepts <strong>any registered engine</strong> — a backup taken from one engine can be restored into another (e.g. a MySQL chain into a Postgres target).</td></tr>
  <tr><td><code>--table-parallelism</code></td><td class="desc">Tables bulk-applied concurrently (the write-side analog of <code>pg_restore -j</code>); <code>0</code> = auto (4), works on both engines; incremental change replay stays ordered. (v0.99.39)</td></tr>
  <tr><td><code>--bulk-parallelism</code></td><td class="desc">Within-table chunk parallelism — a single table's chunks applied concurrently (ADR-0112). <code>0</code> = auto: <code>min(8, NumCPU)</code>; <code>1</code> = serial. Engages only for tables with ≥2 chunks; multiplies with <code>--table-parallelism</code> (table × chunk), with the product bounded by the target connection budget. Applies to chain restores too.</td></tr>
  <tr><td><code>--apply-concurrency</code></td><td class="desc">Key-hash concurrent-apply lane count for the <strong>incremental-replay leg</strong> of a chain restore (ADR-0104/0105). The full-restore row load is the bulk COPY (governed by the two parallelism flags above); a chain's incremental change-replay would otherwise run through a single serial stream and stall RTT-bound on a high-latency / cross-region target. <code>0</code> (default) = <code>auto:4</code>; <code>1</code> = serial; <code>W&gt;1</code> honored. Exactly-once preserved. No effect on a single-full restore.</td></tr>
  <tr><td><code>--target-schema</code></td><td class="desc">Postgres-only: land restored tables under a named schema namespace.</td></tr>
  </tbody></table>
  ${pre(`sluice restore --from s3://my-bucket/app-chain \\
    --target-driver postgres --target ...`)}
   <p>Pair with <a href="/docs/commands/#sync-start">sync start</a> <code>--position-from-manifest URL</code> — point it at the chain URL whose terminal manifest's <code>EndPosition</code> becomes the stream's resume position, so CDC picks up from the chain's tail without re-bulking. (PG soft preflight warnings — <code>wal_keep_size</code> sufficiency, Patroni-managed source — fire here; <code>--strict-preflight</code> promotes them to refusals.)</p>
   <p><strong>Drive both restore parallelism axes</strong> (tables × within-table chunks, product bounded by the target budget):</p>
   ${pre(`sluice restore --from s3://my-bucket/app-chain \\
    --target-driver postgres --target ... \\
    --table-parallelism 4 --bulk-parallelism 4`)}
   <p><strong>Cross-engine restore (a MySQL backup into a Postgres target):</strong> <code>--target-driver</code> accepts any registered engine — the backup's source engine and the restore target need not match.</p>
   ${pre(`sluice restore --from s3://my-bucket/mysql-chain \\
    --target-driver postgres --target 'postgres://user:pass@host:5432/app'`)}`
)}

<h2 id="trigger">trigger setup / teardown</h2>
${cmd(
  "trigger-c",
  "sluice trigger setup",
  "Install a trigger-CDC engine's source-side state — slot-less continuous CDC for managed Postgres that blocks logical replication, a local SQLite file, or a live Cloudflare D1.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--source-driver</code></td><td class="desc">Trigger-CDC engine to install: <code>postgres-trigger</code> (default), <code>sqlite-trigger</code> (a local SQLite file — <code>--dsn</code> is the file path), or <code>d1-trigger</code> (a live Cloudflare D1 over the HTTP query API — <code>--dsn</code> is the <code>d1://</code> form, token via <code>CLOUDFLARE_API_TOKEN</code>).</td></tr>
  <tr><td><code>--dsn</code></td><td class="desc">Source DSN to install the trigger state into. A PG DSN for <code>postgres-trigger</code>, a SQLite file path for <code>sqlite-trigger</code>, or the <code>d1://</code> form for <code>d1-trigger</code>.</td></tr>
  <tr><td><code>--tables</code></td><td class="desc"><strong>Required</strong>, comma-separated (repeatable): the tables to install per-table row + truncate triggers on. Empty-list discovery is a follow-up — the command errors if it's unset.</td></tr>
  <tr><td><code>--schema</code></td><td class="desc">PG schema the change-log + capture function + per-table triggers live in (<code>postgres-trigger</code> only). Defaults to the DSN's <code>schema</code> query parameter (typically <code>public</code>).</td></tr>
  <tr><td><code>--allow-polled-fingerprint</code></td><td class="desc">Permit the non-superuser polled schema-fingerprint path when event triggers aren't grantable (e.g. Heroku). Default off: the engine refuses loudly so the weaker DDL-detection mode is acknowledged explicitly.</td></tr>
  <tr><td><code>--capture-payload</code></td><td class="desc"><code>full</code> (default) / <code>changed</code> / <code>minimal</code> — how much of each row the trigger records.</td></tr>
  <tr><td><code>--dry-run</code>, <code>-n</code></td><td class="desc">Print the DDL the command would apply and exit; no source-side state is modified.</td></tr>
  </tbody></table>
  ${pre(`sluice trigger setup --dsn 'postgres://user:pass@host:5432/app' \\
    --tables=orders,customers --allow-polled-fingerprint
# then stream with the trigger engine:
sluice sync start --source-driver postgres-trigger --source ... --target-driver mysql --target ... --stream-id app`)}`
)}
${cmd(
  "trigger-teardown-c",
  "sluice trigger teardown",
  "Remove every trace of the trigger engine from the source Postgres database — the counterpart to trigger setup. Run it once the stream is finished to leave the source clean.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--dsn</code></td><td class="desc">Source Postgres DSN to clean up.</td></tr>
  <tr><td><code>--tables</code></td><td class="desc">Tables whose per-table triggers to drop. Empty (default) discovers every table with a sluice-installed trigger in the active schema.</td></tr>
  <tr><td><code>--schema</code></td><td class="desc">PG schema; defaults to the DSN's <code>schema</code> query parameter.</td></tr>
  <tr><td><code>--keep-data</code></td><td class="desc">Retain <code>sluice_change_log</code> (and the meta table) for forensics. Default drops them — the engine's promise is to remove every trace.</td></tr>
  <tr><td><code>--dry-run</code>, <code>-n</code> / <code>--yes</code>, <code>-y</code></td><td class="desc">Print the DDL and exit / skip the destructive-action confirmation prompt.</td></tr>
  </tbody></table>
  ${pre(`sluice trigger teardown --dsn 'postgres://user:pass@host:5432/app' --yes`)}`
)}

<h2 id="schema">schema preview / diff</h2>
${cmd(
  "schema-c",
  "sluice schema preview · diff",
  "Inspect translation without moving data: print the target DDL sluice would emit, or diff a live target against what sluice would produce.",
  `${pre(`sluice schema preview --source-driver mysql --source ... --target-driver postgres
sluice schema diff    --source-driver mysql --source ... --target-driver postgres --target ...`)}`
)}

<h2 id="verify">verify</h2>
${cmd(
  "verify-c",
  "sluice verify",
  "Compare data integrity between source and target — row counts by default, escalating to sampled or full per-row hashing.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--depth</code></td><td class="desc">How thorough: <code>count</code> (default — per-table row-count comparison) or <code>sample</code> (counts + per-table sampled-row content hashes; ~99% confidence on a 5%+ corruption rate). A full per-row hash mode is <em>planned</em>, not yet shipped.</td></tr>
  <tr><td><code>--sample-rows-per-table</code> / <code>--sample-seed</code></td><td class="desc">Sampling size and a deterministic seed.</td></tr>
  <tr><td><code>--strict-hash</code></td><td class="desc">Require byte-identical per-row hashes.</td></tr>
  <tr><td><code>--format</code> / <code>--output</code></td><td class="desc">Report format and output destination (for CI gating).</td></tr>
  </tbody></table>
  ${pre(`sluice verify --source-driver mysql --source ... --target-driver postgres --target ... --depth count
sluice verify --source-driver mysql --source ... --target-driver postgres --target ... --depth sample`)}`
)}

<h2 id="matview">matview refresh</h2>
${cmd(
  "matview-c",
  "sluice matview refresh",
  "Refresh PostgreSQL materialized views on the target (PG-only). Handy as a scheduled job after a sync catches up.",
  `${pre(`sluice matview refresh --target-driver postgres --target ... \\
    --matview daily_totals --target-schema reporting`)}
   <p><code>--matview</code> takes <strong>bare</strong> matview names (comma-separated, repeatable) that match <code>pg_matviews.matviewname</code> case-sensitively; the schema is named separately with <code>--target-schema</code> (default <code>public</code>). Omit <code>--matview</code> to refresh every matview in the schema. Add <code>--concurrently</code> to emit <code>REFRESH MATERIALIZED VIEW CONCURRENTLY</code> (requires a unique index on the matview; readers stay live).</p>`
)}

<h2 id="slot">slot list / drop</h2>
${cmd(
  "slot-c",
  "sluice slot list · drop",
  "Manage source-side Postgres replication slots — list sluice-created slots, or drop an orphaned one left by an interrupted stream.",
  pre(`sluice slot list --source-driver postgres --source ...
sluice slot drop --source-driver postgres --source ... --slot-name sluice_slot`)
)}

<h2 id="diagnose">diagnose</h2>
${cmd(
  "diagnose-c",
  "sluice diagnose",
  "Assemble an operator bundle (source/target capability + role state, debug-zip shape) to attach when filing an issue.",
  `${pre(`sluice diagnose --source-driver mysql --source ... --target-driver postgres --target ... --out ./sluice-diagnose.zip`)}
   <p>Supply the five PlanetScale telemetry flags — <code>--planetscale-org</code>, <code>--planetscale-metrics-token-id</code> / <code>--planetscale-metrics-token</code> (env), <code>--planetscale-metrics-db</code> (defaults to the <code>--target</code> DSN's database), <code>--planetscale-metrics-branch</code> (default <code>main</code>) — to add a target-health metrics snapshot (CPU/mem/storage/lag) to the bundle. Control-plane credential, distinct from <code>--target</code>. See <a href="/docs/commands/#sync-start">sync start</a> for the same flag semantics.</p>`
)}

<h2 id="metrics-watch">metrics-watch</h2>
${cmd(
  "metrics-watch-c",
  "sluice metrics-watch",
  "Standalone PlanetScale control-plane metrics daemon — poll a database's CPU/mem/storage/lag on an interval and fire threshold alerts, with no migration or sync attached. Opens NO connection to the database itself; reads only the PlanetScale metrics API.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--engine</code></td><td class="desc">Required: <code>mysql</code> | <code>postgres</code> | <code>planetscale</code> | <code>vitess</code> — picks the PlanetScale metric vocabulary for the watched database. No DB connection is opened.</td></tr>
  <tr><td><code>--planetscale-org</code></td><td class="desc">Required. Org slug whose metrics endpoint the watch reads. Control-plane only.</td></tr>
  <tr><td><code>--planetscale-metrics-token-id</code> / <code>--planetscale-metrics-token</code></td><td class="desc">Service-token (<code>read_metrics_endpoints</code>) ID + secret. Set via the env vars <code>PLANETSCALE_METRICS_TOKEN_ID</code> / <code>PLANETSCALE_METRICS_TOKEN</code> — never on the command line.</td></tr>
  <tr><td><code>--planetscale-metrics-db</code></td><td class="desc">Required — the database to watch (there is no <code>--target</code> DSN to derive it from).</td></tr>
  <tr><td><code>--planetscale-metrics-branch</code></td><td class="desc">Branch to filter the series to (default <code>main</code>).</td></tr>
  <tr><td><code>--interval</code></td><td class="desc">Poll / print cadence (default <code>60s</code> — the PlanetScale metrics granularity).</td></tr>
  <tr><td><code>--once</code></td><td class="desc">Poll a single sample, print / evaluate it, and exit (the one-shot mode for scripts).</td></tr>
  <tr><td><code>--quiet</code></td><td class="desc">Suppress the per-poll live line; emit only threshold alerts (the alert-only-daemon shape).</td></tr>
  <tr><td><code>--metrics-listen</code></td><td class="desc">Also serve a Prometheus <code>/metrics</code> endpoint re-exporting the watched database's CPU/mem/storage/lag as the <code>sluice_target_*</code> gauge family — turning the daemon into a standalone PlanetScale-metrics exporter. Ignored with <code>--once</code>.</td></tr>
  <tr><td><code>--notify-*</code></td><td class="desc">The full alerter set — <code>--notify-webhook</code> / <code>--notify-slack</code> sinks (env <code>SLUICE_NOTIFY_WEBHOOK</code> / <code>SLUICE_NOTIFY_SLACK</code>) and the <code>--notify-storage-util</code> / <code>--notify-cpu-util</code> / <code>--notify-mem-util</code> / <code>--notify-lag-seconds</code> / <code>--notify-storage-growth-per-min</code> thresholds + <code>--notify-cooldown</code> — identical semantics to <a href="/docs/commands/#sync-start">sync start</a>.</td></tr>
  </tbody></table>
  <p><strong>Run as an alert-only daemon</strong> (tokens via env; fire on 85% storage):</p>
  ${pre(`export PLANETSCALE_METRICS_TOKEN_ID=...
export PLANETSCALE_METRICS_TOKEN=...
sluice metrics-watch --engine planetscale --planetscale-org acme --planetscale-metrics-db app \\
    --notify-storage-util 0.85 --notify-slack "$SLACK_URL" --quiet`)}`
)}
`,
    prev: { href: "/docs/getting-started/", label: "Getting started" },
    next: { href: "/docs/configuration/", label: "Configuration" },
  })
);

// ---- Configuration -------------------------------------------------------
write(
  "configuration",
  page({
    slug: "configuration",
    title: "Configuration",
    subtitle: "Connection strings, environment variables, the YAML config file, and the global flags every command shares.",
    body: `
<h2 id="connection-strings">Connection strings</h2>
<p>Every data-moving command takes a source and target driver + DSN:</p>
<table>
<thead><tr><th>Engine</th><th>Driver name</th><th>DSN format</th></tr></thead>
<tbody>
<tr><td>MySQL</td><td><code>mysql</code></td><td><code>user:pass@tcp(host:3306)/dbname</code></td></tr>
<tr><td>Postgres</td><td><code>postgres</code></td><td><code>postgres://user:pass@host:5432/dbname?sslmode=require</code></td></tr>
<tr><td>PlanetScale</td><td><code>planetscale</code></td><td>MySQL DSN against the PlanetScale host (TLS required).</td></tr>
<tr><td>Vitess (self-hosted)</td><td><code>vitess</code></td><td>MySQL DSN against vtgate — the self-hosted Vitess flavor (VStream CDC; warm-resume since v0.99.44).</td></tr>
<tr><td>SQLite</td><td><code>sqlite</code></td><td>A file path (<code>./app.db</code>) or a <code>wrangler d1 export</code> <code>.sql</code> dump (auto-detected). Migrate source <strong>and target</strong> (no CDC).</td></tr>
<tr><td>Cloudflare D1</td><td><code>d1</code></td><td><code>d1://&lt;account_id&gt;/&lt;database_id&gt;</code> (or <code>d1://&lt;database_id&gt;</code> + <code>CLOUDFLARE_ACCOUNT_ID</code>); token via the env var <code>CLOUDFLARE_API_TOKEN</code> (never a flag). Migrate source.</td></tr>
<tr><td>Postgres (slot-less)</td><td><code>postgres-trigger</code></td><td>Same as <code>postgres</code>; pairs with <a href="/docs/commands/#trigger">trigger setup</a>.</td></tr>
<tr><td>SQLite / D1 (CDC)</td><td><code>sqlite-trigger</code> / <code>d1-trigger</code></td><td>Trigger-based continuous CDC over a SQLite file / live D1; pair with <a href="/docs/commands/#trigger">trigger setup --source-driver</a>.</td></tr>
</tbody>
</table>

<h2 id="env-vars">Environment variables</h2>
<p>Keep credentials out of your shell history by passing DSNs via the environment:</p>
<table>
<thead><tr><th>Variable</th><th>Equivalent flag</th></tr></thead>
<tbody>
<tr><td><code>SLUICE_SOURCE</code></td><td><code>--source</code></td></tr>
<tr><td><code>SLUICE_TARGET</code></td><td><code>--target</code></td></tr>
</tbody>
</table>

<h2 id="config-file">YAML config file</h2>
<p>For anything beyond a handful of flags, pass a YAML file with <code>--config</code> / <code>-c</code>. CLI flags take
precedence over config values. Common keys:</p>
${pre(`# sluice.yaml
include_tables: ["app_*"]
exclude_tables: ["app_audit"]

# force target column types (CLI: --type-override)
mappings:
  - column: products.attrs
    type: jsonb
    binary: true

# replace generated-column bodies verbatim (CLI: --expr-override)
expression_mappings:
  - column: orders.total_cents
    expression: "(price_cents * qty)"

# PII redaction (CLI: --redact)
redactions:
  - rule: users.email=hash:sha256
  - rule: users.ssn=mask:ssn

# dictionaries referenced by tokenize:dict / randomize:dict strategies
dictionaries:
  first_names:
    values: ["Alex", "Sam", "Jordan"]`)}
<p>Then run, for example:</p>
${pre(`sluice migrate -c sluice.yaml --source-driver mysql --source ... --target-driver postgres --target ...`)}

<h2 id="global-flags">Global flags</h2>
<p>These apply to every command:</p>
<table>
<thead><tr><th>Flag</th><th>Default</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td><code>--config</code>, <code>-c</code></td><td>—</td><td class="desc">Path to a YAML config file.</td></tr>
<tr><td><code>--log-level</code>, <code>-l</code></td><td><code>info</code></td><td class="desc">Verbosity: <code>debug</code> / <code>info</code> / <code>warn</code> / <code>error</code>.</td></tr>
<tr><td><code>--log-format</code></td><td><code>text</code></td><td class="desc"><code>text</code> or <code>json</code> — one JSON object per line, for Loki / Datadog / CloudWatch ingestion of a long-running <code>sync</code>. (v0.99.31)</td></tr>
<tr><td><code>--pprof-listen</code></td><td>off</td><td class="desc">Bind net/http/pprof at an address to diagnose stalls (e.g. <code>:6060</code>).</td></tr>
<tr><td><code>--mysql-sql-mode</code></td><td>strict</td><td class="desc">Override sluice's forced strict <code>sql_mode</code>. Pass <code>''</code> (empty) to migrate legacy MySQL data with zero-dates.</td></tr>
<tr><td><code>--zero-date</code></td><td><code>error</code></td><td class="desc">How to carry MySQL zero / partial dates (<code>0000-00-00</code>, <code>YYYY-00-DD</code>, <code>YYYY-MM-00</code>): <code>error</code> refuses loudly naming the column; <code>null</code> carries them as NULL (itself refused on a NOT NULL column); <code>epoch</code> substitutes <code>1970-01-01</code>. A silent-loss-class control — the default is the safe one.</td></tr>
<tr><td><code>--sqlite-date-encoding</code></td><td><code>iso</code></td><td class="desc">How a SQLite / D1 source decodes columns <em>declared</em> date/time (SQLite has no native temporal storage): <code>iso</code> reads ISO-8601 TEXT; <code>unixepoch</code> / <code>unixmillis</code> read INTEGER/REAL unix seconds/milliseconds; <code>julian</code> reads a REAL/INTEGER Julian day. A value whose storage class doesn't match is refused loudly naming the row — never a silently-wrong date (use <code>--type-override &lt;col&gt;=text</code> to carry an outlier raw). Per-source override: <code>?sqlite_date_encoding=…</code> on the source DSN.</td></tr>
<tr><td><code>--max-memory</code></td><td>off</td><td class="desc">Soft ceiling on the Go heap (e.g. <code>2GiB</code>, <code>512MiB</code>), applied via <code>SetMemoryLimit</code> at startup to bound RSS. Unlike <code>--max-buffer-bytes</code> (raw buffered bytes only), this bounds the whole heap. Honors the <code>GOMEMLIMIT</code> env var when unset. (v0.99.10)</td></tr>
<tr><td><code>--version</code>, <code>-V</code></td><td>—</td><td class="desc">Print version and exit.</td></tr>
</tbody>
</table>

<div class="note warn"><strong>Migrating legacy MySQL data?</strong> sluice forces a strict <code>sql_mode</code> on every MySQL connection to close the silent-clamp / silent-zero-date class. Data that was only accepted under a relaxed mode (pre-5.7 zero-dates, silently-truncated values) will refuse loudly — pass <code>--mysql-sql-mode=''</code> to fall through to the server default. Zero / partial dates specifically are governed by <code>--zero-date</code> (default <code>error</code>): use <code>--zero-date=null</code> to carry them as NULL or <code>--zero-date=epoch</code> to substitute <code>1970-01-01</code> rather than refusing.</div>

<h2 id="dsn-tuning">Source-DSN tuning parameters</h2>
<p>A handful of throughput / observability knobs are passed as query parameters on the <strong>source DSN</strong> rather than as CLI flags — they are engine-specific and parsed inside the engine, so they're stripped before reaching the database session. Append them to the source connection string (e.g. <code>...&amp;vstream_copy_table_parallelism=4</code>).</p>
<table>
<thead><tr><th>Parameter</th><th>Applies to</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td><code>copy_table_parallelism=N</code></td><td>native MySQL source</td><td class="desc">ADR-0101/0102 (v0.99.70–71): cold-copy <code>N</code> tables concurrently under one FTWRL window, each a consistent-snapshot reader. Composes with <code>--copy-fanout-degree</code> for W&times;D total write concurrency. Absent / <code>0</code> / <code>1</code> = the serial single-snapshot path. Falls back to serial (loud WARN) without the <code>RELOAD</code> privilege.</td></tr>
<tr><td><code>vstream_copy_table_parallelism=K</code></td><td>VStream (PlanetScale / Vitess) source</td><td class="desc">ADR-0099/0100 (v0.99.67/69): open <code>K</code> concurrent COPY streams over a disjoint table partition for the cold-copy. Absent / <code>0</code> / <code>1</code> = serial. <strong>Not</strong> auto-clamped into the connection-budget preflight — the operator must keep <code>K &times; D &le; --max-target-connections</code> (sluice WARNs naming the contract).</td></tr>
<tr><td><code>vstream_copy_single_stream=true</code></td><td>VStream source</td><td class="desc">ADR-0095 (v0.99.63): opt out of the auto-shard VStream COPY and restore the legacy single interleaved stream (and its ADR-0071 memory-refusal floor). Auto-shard is <strong>on by default</strong> for a fresh cold-start of more than one table.</td></tr>
<tr><td><code>vstream_idle_warn_timeout=DUR</code></td><td>VStream source</td><td class="desc">v0.99.43: tune the idle-stall WARN that fires when the source is alive (heartbeats flowing) but sending no change events — the throttled-or-idle signal. Default <code>30s</code>; <code>0</code> disables the WARN only (the hard liveness/progress guards are unaffected).</td></tr>
</tbody>
</table>

<h2 id="metrics">Prometheus <code>/metrics</code> export</h2>
<p>Pass <code>--metrics-listen ADDR</code> to <a href="/docs/commands/#sync-start">sync start</a> (or <a href="/docs/commands/#metrics-watch">metrics-watch</a>) to bind a Prometheus-format <code>/metrics</code> endpoint (plus <code>/readyz</code> on <code>sync start</code>) for the life of the process. Beyond the stream's apply/throughput counters it exports:</p>
<ul>
<li><code>sluice_build_info{version,commit,go_version}</code> — a constant-<code>1</code> gauge carrying the build metadata.</li>
<li>A Go-runtime block — <code>sluice_go_goroutines</code>, <code>sluice_go_gomaxprocs</code>, heap (<code>sluice_go_memstats_heap_*</code>), and GC stats.</li>
<li>The <code>sluice_target_*</code> gauge family — target CPU / memory / storage utilisation and replica lag — <strong>when PlanetScale telemetry is configured</strong> (<code>--planetscale-org</code> + the metrics-token flags). Without telemetry these gauges are simply absent.</li>
</ul>

<h2 id="created-objects">What sluice creates in your databases</h2>
<p>To make migrations resumable and continuous sync durable, sluice writes a small, predictable set of <code>sluice_</code>-prefixed bookkeeping objects — state tables on the target, and a replication slot / publication / triggers on the source. They're excluded from <code>schema diff</code> and <code>verify</code>, so they never look like drift. For the full inventory — what each object is, when it appears, and how to remove it — see <a href="/docs/database-objects/">Objects sluice creates</a>.</p>
`,
    prev: { href: "/docs/commands/", label: "Command reference" },
  })
);

// ---- Reference: objects sluice creates -----------------------------------
write(
  "database-objects",
  page({
    slug: "database-objects",
    title: "Objects sluice creates in your databases",
    subtitle: "The full inventory of sluice's bookkeeping tables, slots, publications, and triggers — what each is for, when it appears, and how to remove it.",
    body: `
<p>To make migrations resumable and continuous sync durable, sluice creates a small, predictable set of bookkeeping objects in your source and target databases. Every one is prefixed <code>sluice_</code> so you can always find them, and the schema readers <strong>exclude them from <a href="/docs/commands/#schema">schema diff</a> and <a href="/docs/commands/#verify">verify</a></strong> (ADR-0029) so they never register as drift or count against a row comparison. Nothing here is hidden — this page is the complete list of what sluice writes, which command writes it, why, and how to clean it up.</p>

<div class="note"><strong>Where they live.</strong> On <strong>Postgres targets</strong> the bookkeeping tables are created in the target DSN's <code>schema</code> parameter (default <code>public</code>) — they follow <code>--target-schema</code>, they are <em>not</em> hardcoded to <code>public</code>. On <strong>MySQL targets</strong> they live in the connection's default database. The source-side object names (<code>sluice_slot</code>, <code>sluice_pub</code>, <code>sluice_heartbeat</code>) are defaults and all overridable. Every object below is created idempotently (<code>IF NOT EXISTS</code> / <code>CREATE OR REPLACE</code>), so a re-run never errors on an existing one.</div>

<h2 id="target">Target database — bookkeeping tables</h2>
<p>These hold the state that makes <code>migrate --resume</code> and <code>sync start</code> warm-resume work. They persist between runs by design (that's the durable resume frontier); the only built-in way to drop them is the destructive <a href="/docs/commands/#migrate"><code>--reset-target-data</code></a> recovery path, which clears the relevant state and the tables sluice manages.</p>
<table><thead><tr><th>Object</th><th>Created by</th><th>When &amp; why</th><th>Cleaned up by</th></tr></thead><tbody>
<tr><td><code>sluice_cdc_state</code></td><td class="desc"><code>sync start</code></td><td class="desc">At CDC stream open. One row per <code>--stream-id</code>: the durable CDC source position, slot name, source-DSN fingerprint, and stop flag — the warm-resume frontier.</td><td class="desc"><code>--reset-target-data</code> (clears the row); otherwise persists.</td></tr>
<tr><td><code>sluice_migrate_state</code></td><td class="desc"><code>migrate</code></td><td class="desc">At bulk-copy start. One header row per <code>--migration-id</code> for resumable bulk migration (ADR-0082).</td><td class="desc"><code>--reset-target-data</code>; otherwise persists.</td></tr>
<tr><td><code>sluice_migrate_table_progress</code></td><td class="desc"><code>migrate</code></td><td class="desc">At bulk-copy start. One row per table — per-table progress / keyset checkpoint so <code>--resume</code> picks up mid-copy (ADR-0082).</td><td class="desc"><code>--reset-target-data</code>; otherwise persists.</td></tr>
<tr><td><code>sluice_cdc_schema_history</code></td><td class="desc"><code>sync start</code></td><td class="desc">At CDC stream open; rows written only at a real DDL/schema-delta boundary. Position-anchored schema versions so each event decodes in the schema in effect at its position — resume-after-DDL without a re-snapshot (ADR-0049). Grows with DDL count (tiny).</td><td class="desc">Compacted on demand below the retention floor by <a href="/docs/commands/#backup"><code>backup prune</code></a>; <code>--reset-target-data</code>.</td></tr>
<tr><td><code>sluice_target_metrics_history</code></td><td class="desc"><code>sync start</code> <em>(telemetry only)</em></td><td class="desc">Only when <a href="/docs/commands/#sync-start">PlanetScale telemetry</a> is configured (<code>--planetscale-org</code>). A bounded rolling history of polled target-health snapshots (CPU/mem/storage/lag) so <a href="/docs/commands/#diagnose"><code>diagnose</code></a> can show the recent trend (ADR-0107). Advisory — never affects the sync.</td><td class="desc">Rows <strong>auto-pruned</strong> to a rolling window; table via <code>--reset-target-data</code>. Disable with <code>--suppress-target-metrics-history</code>.</td></tr>
<tr><td><code>sluice_shard_consolidation_lease</code></td><td class="desc"><code>sync start</code> <em>(consolidation only)</em></td><td class="desc">Only when consolidating a multi-shard Vitess/PlanetScale source onto one target with cross-shard DDL coordination (ADR-0054). One row per consolidated table records which shard-stream owns applying a coordinated DDL.</td><td class="desc">Lease rows GC-swept automatically; table via <code>--reset-target-data</code>.</td></tr>
</tbody></table>
<div class="note"><code>--reset-target-data</code> is destructive: it clears the relevant state row(s) <em>and</em> drops every source-schema table sluice manages on that target, then cold-starts. Other tables on the target are untouched. See <a href="/docs/commands/#migrate">the migrate reference</a> and ADR-0023.</div>

<h2 id="pg-source">Source database — Postgres logical CDC</h2>
<p>The native <code>postgres</code> CDC engine reads the WAL through a logical replication slot. It creates two persistent server objects plus two optional/transient ones. Full operational detail — failover, slot invalidation, sizing — is in <a href="https://github.com/sluicesync/sluice/blob/main/docs/postgres-source-prep.md">the Postgres source-prep guide</a>.</p>
<table><thead><tr><th>Object</th><th>Kind</th><th>When &amp; why</th><th>Cleaned up by</th></tr></thead><tbody>
<tr><td><code>sluice_slot</code></td><td class="desc">replication slot</td><td class="desc">Created lazily on the first CDC connect (cold-start). Pins WAL and holds the resume LSN (<code>confirmed_flush_lsn</code>). pgoutput plugin; failover-aware on PG 17+.</td><td class="desc"><strong>Never auto-dropped</strong> — explicit <a href="/docs/commands/#slot"><code>sluice slot drop &lt;name&gt;</code></a>. (Auto-dropped only if cold-start <em>setup</em> itself fails.)</td></tr>
<tr><td><code>sluice_pub</code></td><td class="desc">publication</td><td class="desc">Ensured on demand when missing, by <code>migrate</code> and <code>sync start</code>. Defines the table set pgoutput streams — scoped <code>FOR TABLE …</code> by default (ADR-0021), <code>FOR ALL TABLES</code> for multi-schema CDC.</td><td class="desc">No dedicated command — manual <code>DROP PUBLICATION</code> (a <code>DROP SCHEMA</code> won't remove it). sluice rescopes/recreates it itself.</td></tr>
<tr><td><code>sluice_heartbeat</code></td><td class="desc">table</td><td class="desc"><strong>Opt-in</strong> via <code>--source-heartbeat-interval</code> (default off). A periodic INSERT generates WAL so the consumer position keeps advancing on an idle source — preventing slot-invalidation / binlog-purge silent loss. <em>Also created on a MySQL source</em> under the same flag.</td><td class="desc">Rows <strong>auto-pruned</strong> (<code>--source-heartbeat-prune-window</code>, default <code>1h</code>); the table itself is left in place — drop manually.</td></tr>
<tr><td><code>sluice_backup_anchor_&lt;ts&gt;</code></td><td class="desc">temporary slot</td><td class="desc">Created by <a href="/docs/commands/#backup"><code>backup</code></a> at snapshot start to pin a consistent export point for the run.</td><td class="desc"><strong>Transient</strong> — the server auto-drops it when the session closes (even on crash). Legacy leaked anchors are auto-swept on the next backup.</td></tr>
</tbody></table>
<p><strong>MySQL source:</strong> native MySQL CDC reads the binlog and creates <em>nothing</em> on the source except the opt-in <code>sluice_heartbeat</code> table above — there is no slot or publication concept.</p>

<h2 id="trigger-source">Source database — trigger-based CDC</h2>
<p>The slot-less trigger engines capture changes with database triggers instead of a log stream. <a href="/docs/commands/#trigger"><code>trigger setup</code></a> installs every object below; <a href="/docs/commands/#trigger"><code>trigger teardown</code></a> removes all of them (pass <code>--keep-data</code> to retain the change-log for forensics), and <code>trigger prune</code> reaps applied change-log rows. They live in the source schema (<code>--schema</code>, default <code>public</code> on Postgres).</p>

<h3 id="pgtrigger">Postgres trigger engine (<code>postgres-trigger</code>, ADR-0066)</h3>
<table><thead><tr><th>Object</th><th>Kind</th><th>Why</th></tr></thead><tbody>
<tr><td><code>sluice_change_log</code> + <code>sluice_change_log_meta</code></td><td class="desc">tables (+ indexes)</td><td class="desc">Append-only captured-change log (txid, op, PK + before/after JSONB) and a singleton schema-version pin.</td></tr>
<tr><td><code>sluice_capture_change()</code>, <code>sluice_capture_truncate_fn()</code>, <code>sluice_capture_ddl()</code></td><td class="desc">functions</td><td class="desc">Row-capture (payload mode set by <code>--capture-payload</code>), TRUNCATE companion, and the DDL event-trigger handler.</td></tr>
<tr><td><code>sluice_capture</code>, <code>sluice_capture_truncate</code> (per table); <code>sluice_capture_ddl_trg</code></td><td class="desc">triggers</td><td class="desc">One combined <code>AFTER INSERT/UPDATE/DELETE</code> trigger and a TRUNCATE trigger per table, plus one cluster DDL event trigger.</td></tr>
</tbody></table>

<h3 id="sqlitetrigger">SQLite / Cloudflare-D1 trigger engines (<code>sqlite-trigger</code> / <code>d1-trigger</code>, ADR-0135/0136)</h3>
<table><thead><tr><th>Object</th><th>Kind</th><th>Why</th></tr></thead><tbody>
<tr><td><code>sluice_change_log</code> + <code>sluice_change_log_meta</code></td><td class="desc">tables</td><td class="desc">Captured-change log with a monotonic <code>id</code> watermark, and a schema-version pin.</td></tr>
<tr><td><code>sluice_change_log_columns</code></td><td class="desc">table</td><td class="desc">Captured-column fingerprint — since SQLite/D1 have no DDL triggers, a source <code>ALTER</code> is caught here and <code>sync start</code> refuses loudly rather than dropping a new column silently.</td></tr>
<tr><td><code>sluice_capture_&lt;table&gt;_&lt;ins|upd|del&gt;</code></td><td class="desc">triggers</td><td class="desc">Three per table (SQLite has no combined-event trigger form), each writing into the change-log.</td></tr>
</tbody></table>
<div class="note">The two families differ in trigger naming: <code>postgres-trigger</code> uses one combined trigger literally named <code>sluice_capture</code> per table, whereas <code>sqlite-trigger</code>/<code>d1-trigger</code> use three separate <code>sluice_capture_&lt;table&gt;_&lt;op&gt;</code> triggers. Both are fully removed by <code>trigger teardown</code>.</div>

<h2 id="cleanup">Cleanup quick reference</h2>
<table><thead><tr><th>Command</th><th>Removes</th></tr></thead><tbody>
<tr><td><code>sluice slot drop &lt;name&gt;</code></td><td class="desc">The PG source replication slot (the one object sluice never drops on its own).</td></tr>
<tr><td><code>sluice trigger teardown</code></td><td class="desc">Every trigger-engine object on the source; <code>--keep-data</code> retains the change-log.</td></tr>
<tr><td><code>sluice trigger prune</code> / <code>backup prune</code></td><td class="desc">Old change-log rows / below-floor <code>sluice_cdc_schema_history</code> rows (the tables stay).</td></tr>
<tr><td><code>sluice sync start --reset-target-data</code></td><td class="desc">The target bookkeeping state + every source-schema table sluice manages on the target (destructive recovery).</td></tr>
<tr><td><em>manual</em></td><td class="desc"><code>sluice_pub</code> (<code>DROP PUBLICATION</code>), and the <code>sluice_heartbeat</code> table once heartbeats are no longer needed.</td></tr>
</tbody></table>
`,
    prev: { href: "/docs/commands/", label: "Command reference" },
  })
);

// ---- Guide: migrate MySQL -> Postgres ------------------------------------
write(
  "migrate-mysql-to-postgres",
  page({
    slug: "migrate-mysql-to-postgres",
    title: "Migrate MySQL → Postgres",
    subtitle: "The flagship first migration: connect, preview the plan, copy the data, and verify it landed.",
    body: `
<p>A one-shot <a href="/docs/commands/#migrate">migrate</a> translates the source schema, creates the target tables, bulk-copies the rows, then builds indexes and constraints — in that order, so the bulk load runs against constraint-free tables and finishes fast. This guide walks MySQL → Postgres end to end, but the same shape works in <strong>all four directions</strong> (just swap the <code>--source-driver</code> / <code>--target-driver</code> pair). Reach for <code>migrate</code> when you can take a short write-freeze on the source; if you need a zero-downtime cutover, run the <a href="/docs/zero-downtime-cutover/">continuous-sync</a> flow instead — but even then a clean <code>migrate</code> is the fastest way to learn how sluice translates your schema.</p>
<div class="note">Before a production cutover, freeze writes on the source (or accept that rows written during the copy won't be captured — <code>migrate</code> is a point-in-time copy, not a stream). To keep writes flowing throughout, use <a href="/docs/zero-downtime-cutover/">continuous sync</a>.</div>

<h2 id="connect">1. Point sluice at both databases</h2>
<p>Source and target are each a <strong>driver name</strong> plus a <strong>DSN</strong>. Because DSNs carry credentials, pass them through the environment to keep them out of your shell history:</p>
${pre(`export SLUICE_SOURCE='root:rootpw@tcp(localhost:3306)/app'
export SLUICE_TARGET='postgres://postgres:pgpw@localhost:5432/app?sslmode=require'

sluice engines      # confirm 'mysql' and 'postgres' are registered`)}
<p>The MySQL DSN is <code>user:pass@tcp(host:3306)/dbname</code>; the Postgres DSN is a <code>postgres://</code> URL. See <a href="/docs/configuration/#connection-strings">Configuration</a> for every engine's DSN format.</p>

<h2 id="dry-run">2. Dry-run the plan first</h2>
<p><code>--dry-run</code> (<code>-n</code>) reads the source schema and prints exactly what sluice would do — tables, row estimates, the translated types — <strong>without touching the target</strong>. Always do this first:</p>
${pre(`sluice migrate \\
    --source-driver mysql    --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET" \\
    --dry-run`)}
<p>For the actual target DDL sluice will emit — column by column, with cross-engine translation notes — use <a href="/docs/preview-and-validate/">schema preview</a>. That's where you'll catch a type you want to steer with <code>--type-override</code> before any data moves.</p>

<h2 id="run">3. Run the migration</h2>
<p>When the plan looks right, drop <code>--dry-run</code>:</p>
${pre(`sluice migrate \\
    --source-driver mysql    --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET"`)}
<p>sluice copies each table, then builds secondary indexes and constraints in deferred phases. On large schemas it copies several tables at once and splits big tables into parallel chunks automatically — see <code>--table-parallelism</code> / <code>--bulk-parallelism</code> in the <a href="/docs/commands/#migrate">migrate reference</a> if you want to tune the connection budget.</p>
<div class="note"><strong>Cold-start safety.</strong> sluice refuses to bulk-copy into a non-empty target by default — an <code>INSERT</code> into a populated table would collide on the primary key. That refusal is the safety net, not an error to suppress: it means the target already has data. Start from an empty target, or see the recovery flags below.</div>

<h2 id="resume">4. If it's interrupted, resume</h2>
<p>Migration state is checkpointed per table on the target. If a run dies partway (network blip, OOM, Ctrl-C), re-run the identical command with <code>--resume</code> (<code>-r</code>) and it continues from the last committed checkpoint rather than starting over:</p>
${pre(`sluice migrate \\
    --source-driver mysql    --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET" \\
    --resume`)}
<p>To deliberately start clean over an already-populated target, <code>--reset-target-data</code> drops the source-schema tables on the target and re-copies (it prompts for a typed <code>reset</code> confirmation unless you add <code>--yes</code>). It's mutually exclusive with <code>--resume</code>.</p>

<h2 id="verify">5. Verify the copy</h2>
<p>Once the migration finishes, confirm source and target agree. <a href="/docs/commands/#verify">verify</a> compares per-table row counts by default and returns a non-zero exit code on any mismatch (CI-friendly):</p>
${pre(`sluice verify \\
    --source-driver mysql    --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET" \\
    --depth count`)}
<p>For content checking — not just counts — escalate to <code>--depth sample</code> (per-table sampled-row content hashes; ~99% confidence on a 5%+ corruption rate). See the <a href="/docs/preview-and-validate/#verify">validate guide</a> for the depth ladder.</p>

<h2 id="legacy">Migrating legacy MySQL data?</h2>
<p>sluice forces a strict <code>sql_mode</code> on every MySQL connection to close the silent-clamp / silent-zero-date class of corruption. Data that was only storable under a relaxed mode — pre-5.7 zero-dates (<code>0000-00-00</code>), silently-truncated values — will <strong>refuse loudly</strong> rather than land subtly wrong. That's deliberate. Two knobs let you decide how to carry it:</p>
<ul>
  <li><code>--zero-date=null</code> carries zero/partial dates as <code>NULL</code> (refused on a <code>NOT NULL</code> column), or <code>--zero-date=epoch</code> substitutes <code>1970-01-01</code>.</li>
  <li><code>--mysql-sql-mode=''</code> (explicit empty) falls all the way through to the server's default <code>sql_mode</code> for the broadest legacy tolerance.</li>
</ul>
<p>Both are <a href="/docs/configuration/#global-flags">global flags</a> — see Configuration for the full discussion.</p>
`,
    prev: { href: "/docs/getting-started/", label: "Getting started" },
    next: { href: "/docs/how-sluice-copies/", label: "How sluice copies your data" },
  })
);

// ---- Guide: preview & validate -------------------------------------------
write(
  "preview-and-validate",
  page({
    slug: "preview-and-validate",
    title: "Preview & validate before you migrate",
    subtitle: "See the exact target DDL, steer the type translation, and confirm the copy — without guessing.",
    body: `
<p>sluice is correctness-first: it would rather refuse loudly than land data subtly wrong. The flip side is that you can see <em>everything</em> it intends to do before it does it. This guide covers the three read-only inspection commands — <a href="/docs/commands/#schema">schema preview</a>, <a href="/docs/commands/#schema">schema diff</a>, and <a href="/docs/commands/#verify">verify</a> — plus <code>--type-override</code>, the one knob that steers translation when you disagree with a default. Reach for this guide whenever a migration touches types you care about (money, JSON, UUIDs, SQLite's untyped columns) or before any production cutover.</p>

<h2 id="preview">1. Preview the target DDL</h2>
<p><code>schema preview</code> reads the source schema, runs the full cross-engine translation, and prints the <strong>exact DDL the target engine would emit</strong> — with advisory notes on anything non-obvious. It never connects to the target to write; the target DSN is only used to construct the right dialect's writer:</p>
${pre(`sluice schema preview \\
    --source-driver mysql    --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET"`)}
<p>Scope it with <code>--include-table</code> / <code>--exclude-table</code> (glob-aware), write it to a file with <code>-o ddl.sql</code>, or get machine-readable output with <code>--format json</code>. This is where you eyeball how each MySQL type maps to Postgres before a single row moves.</p>

<h2 id="override">2. Steer a type with --type-override</h2>
<p>When you disagree with a default mapping — say you want a MySQL <code>JSON</code> column to land as Postgres <code>jsonb</code> rather than <code>json</code>, or a free-form column forced to <code>text</code> — override it per column. The format is <code>TABLE.COLUMN=TYPE</code>, repeatable, and it's accepted by <code>preview</code>, <code>migrate</code>, and <code>sync start</code> alike, so you can preview the override and then migrate with the identical flag:</p>
${pre(`sluice schema preview \\
    --source-driver mysql --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET" \\
    --type-override products.attrs=text \\
    --type-override events.payload=jsonb`)}
<div class="note">For target-type options that need more than a type name — e.g. <code>jsonb</code> with <code>binary: true</code> — use the YAML <code>mappings:</code> block instead of the CLI flag (the CLI form takes a bare type). See <a href="/docs/configuration/#config-file">Configuration → YAML config</a>.</div>

<h2 id="affinity">SQLite & D1: declared types vs stored affinity</h2>
<p>SQLite (and Cloudflare D1) don't store strict types — a column has a <em>declared</em> type but values live under SQLite's loose <em>affinity</em> rules. sluice infers the target type from the declared type, but two cases need an explicit decision because guessing would risk a silently-wrong value:</p>
<ul>
  <li><strong>Dates &amp; times.</strong> A column <em>declared</em> <code>DATE</code> / <code>DATETIME</code> / <code>TIMESTAMP</code> / <code>TIME</code> could hold ISO text, unix seconds/millis, or a Julian day. You name the encoding with <code>--sqlite-date-encoding</code> (<code>iso</code> default, or <code>unixepoch</code> / <code>unixmillis</code> / <code>julian</code>). A value whose storage class doesn't match is <strong>refused loudly, naming the row</strong> — never coerced to a wrong date.</li>
  <li><strong>Outliers.</strong> If one column genuinely holds raw text you don't want interpreted, carry it as-is with <code>--type-override &lt;col&gt;=text</code>.</li>
</ul>
<p>Preview an import the same way you'd preview any source — point <code>--source-driver</code> at <code>sqlite</code> or <code>d1</code> — to see the resolved target types before committing. Full detail is in the <a href="/docs/import-sqlite-d1/">SQLite/D1 guide</a>.</p>

<h2 id="diff">3. Diff a live target against the source</h2>
<p>When the target already exists — a previous migration, an Atlas/Liquibase-managed schema, a hand-built warehouse — <code>schema diff</code> compares what's actually on the target against what sluice <em>would</em> produce from the source, and reports the drift with copy-paste DDL suggestions. It exits non-zero on any difference, so it gates cleanly in CI:</p>
${pre(`sluice schema diff \\
    --source-driver mysql    --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET"`)}

<h2 id="verify">4. Verify the data landed</h2>
<p>After a migration (or once a <a href="/docs/zero-downtime-cutover/">sync</a> has caught up), <code>verify</code> compares the data itself. It has a depth ladder — start cheap, escalate only if you need stronger guarantees:</p>
<table><thead><tr><th>Depth</th><th>What it does</th></tr></thead><tbody>
<tr><td><code>--depth count</code> (default)</td><td class="desc">Per-table row-count comparison. Fast, catches whole-table and bulk-row loss.</td></tr>
<tr><td><code>--depth sample</code></td><td class="desc">Counts <em>plus</em> per-table sampled-row content hashes — ~99% confidence of catching a 5%+ corruption rate at the default 100 rows/table. Raise <code>--sample-rows-per-table</code> for rarer anomalies; <code>--strict-hash</code> switches the row hash from MD5 to SHA-256.</td></tr>
</tbody></table>
${pre(`# fast count check, CI-gated (non-zero exit on mismatch)
sluice verify --source-driver mysql --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET" --depth count

# content sampling with a larger sample
sluice verify --source-driver mysql --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET" \\
    --depth sample --sample-rows-per-table 500`)}
<p>Both modes accept <code>--format json</code> and <code>-o FILE</code> for piping into a CI gate or alertmanager. A full per-row hash mode is planned but not yet shipped.</p>
`,
    prev: { href: "/docs/how-sluice-copies/", label: "How sluice copies your data" },
    next: { href: "/docs/verify-reconcile/", label: "Verify & reconcile" },
  })
);

// ---- Guide: zero-downtime cutover ----------------------------------------
write(
  "zero-downtime-cutover",
  page({
    slug: "zero-downtime-cutover",
    title: "Zero-downtime migration with continuous sync",
    subtitle: "Cold-start the data, let CDC catch up while the app keeps writing, then cut over in a brief, controlled window.",
    body: `
<p>A one-shot <a href="/docs/migrate-mysql-to-postgres/">migrate</a> is a point-in-time copy: rows written after it starts are missed. <a href="/docs/commands/#sync-start">sync start</a> closes that gap — it takes a consistent snapshot, bulk-copies it, then <strong>streams ongoing changes</strong> (change-data-capture) so the target tracks the source live. That lets you keep the application running on the source the whole time and flip traffic over in a short, controlled window. This is the core "sync, not just migrate" workflow; reach for it whenever downtime isn't acceptable.</p>
<div class="note"><strong>Source prerequisites.</strong> CDC reads the source's native change stream. Postgres needs logical replication (a replication slot + <code>REPLICATION</code> role); MySQL needs the binlog (<code>ROW</code> format). On a managed Postgres that blocks slots (Heroku, some RDS tiers), use the slot-less <a href="/docs/commands/#trigger">trigger engine</a> instead — sluice refuses loudly rather than silently degrading to polling.</div>

<h2 id="start">1. Start the stream</h2>
<p>A stream is identified by <code>--stream-id</code> so it can resume after a restart. The first launch cold-starts (snapshot → bulk copy), then transitions seamlessly into live CDC and keeps running until you stop it:</p>
${pre(`sluice sync start \\
    --source-driver mysql    --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET" \\
    --stream-id app-prod`)}
<p>Restarting with the same <code>--stream-id</code> warm-resumes from the persisted position — it does not re-run the snapshot. To run it as a long-lived service with a health endpoint and an idle-source heartbeat (so the slot/binlog can't be evicted past the consumer during quiet periods), add <code>--metrics-listen :9090</code> and <code>--source-heartbeat-interval 30s</code>; see <a href="https://github.com/sluicesync/sluice/blob/main/docs/operator/running-as-a-service.md">running as a service</a> and the <a href="/docs/commands/#sync-start">sync start reference</a>.</p>

<h2 id="watch">2. Watch it catch up</h2>
<p>From another shell, check the stream's position and freshness. <code>sync health</code> returns a cron-friendly exit code so you can script "are we caught up yet?":</p>
${pre(`sluice sync status --stream-id app-prod --target-driver postgres --target "$SLUICE_TARGET"

# exit non-zero if the last apply was more than 5s ago
sluice sync health --stream-id app-prod --target-driver postgres --target "$SLUICE_TARGET" \\
    --max-stale-seconds 5`)}
<p>Once <code>sync health</code> reports fresh under a tight threshold, the target is tracking the source within seconds — you're ready to cut over. (On a PG→PG pair, also pass <code>--source-driver</code>/<code>--source</code> to expose <code>--max-lag-bytes</code> for byte-distance lag.)</p>

<h2 id="drain">3. Quiesce and drain</h2>
<p>At your chosen cutover moment, stop writes to the source application (the brief window), then drain the last in-flight changes. <code>sync stop --wait</code> blocks until the streamer has applied everything queued and exited cleanly:</p>
${pre(`sluice sync stop --stream-id app-prod \\
    --target-driver postgres --target "$SLUICE_TARGET" \\
    --wait --timeout 10m`)}
<p>On timeout the CLI exits non-zero and the stop request stays in place — so a scripted cutover fails safe rather than proceeding on a half-drained target.</p>

<h2 id="cutover">4. Prime sequences (cutover)</h2>
<p>CDC replicates row changes, not catalog-level sequence positions. So after the drain, the target's <code>SERIAL</code> / <code>AUTO_INCREMENT</code> counters can lag behind the IDs that already exist in its rows — and the first post-cutover <code>INSERT</code> would collide on the primary key. <a href="/docs/commands/#cutover">cutover</a> closes that gap: it re-reads the source sequence state and applies it to the target with a safety margin:</p>
${pre(`sluice cutover \\
    --source-driver mysql    --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET" \\
    --sequence-margin 1000`)}
<div class="note"><code>cutover</code> is idempotent and fails safe: a re-run within the margin reports every table as <code>noop</code>, and if the target's sequence is already <em>ahead</em> of the source by more than the margin it <strong>refuses</strong> (exit code 2) rather than risk a collision — the signal that something already wrote to the target. Run it after the drain and before pointing application traffic at the target.</div>

<h2 id="verify">5. Verify, then flip traffic</h2>
<p>Confirm the data agrees, then point your application at the target:</p>
${pre(`sluice verify --source-driver mysql --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET" --depth count`)}
<p>The full sequence: <strong>start the stream → wait for fresh → freeze source writes → <code>sync stop --wait</code> → <code>cutover</code> → <code>verify</code> → repoint the app</strong>. Only the last three steps fall inside the write-freeze window, so downtime is measured in seconds-to-minutes, not the length of the copy.</p>
<div class="note"><strong>Schema changes during a long-running sync.</strong> By default a stream forwards unambiguous source DDL (ADD/DROP/ALTER COLUMN, CREATE/DROP INDEX, …) onto the target automatically so it stays online through schema evolution — including a destructive <code>DROP COLUMN</code>. To gate DDL through a separate change process, start with <code>--schema-changes=refuse</code>. See the warning box in the <a href="/docs/commands/#sync-start">sync start reference</a>.</div>
`,
    prev: { href: "/docs/verify-reconcile/", label: "Verify & reconcile" },
    next: { href: "/docs/schema-changes/", label: "Schema changes during a sync" },
  })
);

// ---- Guide: import SQLite / Cloudflare D1 --------------------------------
write(
  "import-sqlite-d1",
  page({
    slug: "import-sqlite-d1",
    title: "Import SQLite or Cloudflare D1",
    subtitle: "Move a SQLite file, a wrangler D1 export, or a live Cloudflare D1 into Postgres or MySQL — losslessly.",
    body: `
<p>sluice imports SQLite and <a href="https://developers.cloudflare.com/d1/">Cloudflare D1</a> into Postgres or MySQL through the same <a href="/docs/migrate-mysql-to-postgres/">migrate</a> pipeline as everything else — parallel copy, cross-engine type translation, deferred indexes, <code>--dry-run</code>, <code>verify</code> — with no pgloader or external tool. Reach for this when you're graduating a SQLite/D1 app onto a server database, or pulling D1 data into an analytics warehouse. There are three source shapes; pick by what you have.</p>

<h2 id="file">A local SQLite file</h2>
<p>Point <code>--source-driver sqlite</code> at the file (a bare path, a <code>file:</code> URI, or a <code>sqlite://</code> URL — opened read-only) and migrate as usual:</p>
${pre(`sluice migrate \\
    --source-driver sqlite   --source ./app.db \\
    --target-driver postgres --target 'postgres://user:pass@host:5432/db?sslmode=require'`)}
<p>Large tables parallel-copy automatically (PK-range / keyset chunks, tuned by <code>--bulk-parallelism</code>), the same as any other source. A <code>.db</code> file is read byte-exact — sluice reads the int64 straight from the file.</p>

<h2 id="dump">A wrangler D1 export (.sql dump)</h2>
<p><code>wrangler d1 export</code> emits a <code>.sql</code> text dump. sluice ingests one directly — it sniffs the file's header, materializes the dump in-process (no <code>sqlite3</code> CLI), and auto-skips D1's internal <code>_cf_*</code> tables. So the import is two commands:</p>
${pre(`wrangler d1 export <db> --remote --output dump.sql
sluice migrate --source-driver sqlite --source dump.sql \\
    --target-driver postgres --target '<pg-dsn>'`)}
<div class="note warn"><strong>The export rounds big integers.</strong> Both of D1's <em>default</em> extraction paths — the <code>wrangler d1 export</code> dump and the bare query API — silently lose integers larger than 2<sup>53</sup> (≈ 9 ×10<sup>15</sup>): D1 serializes them through a JavaScript double before sluice ever sees them. For Snowflake-style IDs (Discord/Twitter 64-bit IDs), nanosecond timestamps, or large counters, use the live query-API reader below — it's the only lossless path. For a D1 database <em>without</em> integers that large (the common case), the export path is exact and simple.</div>

<h2 id="live">A live Cloudflare D1 (lossless)</h2>
<p><code>--source-driver d1</code> reads a live D1 over its HTTP query API and is the <strong>lossless</strong> import. It projects every column through <code>typeof()</code> + <code>CAST(… AS TEXT)</code> / <code>hex()</code>, so integers above 2<sup>53</sup> round-trip exactly, INTEGER is distinguished from REAL, and BLOBs decode from hex. Reads don't take D1 offline. The API token is read from the environment only — never a flag, never logged:</p>
${pre(`export CLOUDFLARE_API_TOKEN=...        # required
export CLOUDFLARE_ACCOUNT_ID=...       # optional if the account is in the DSN

sluice migrate \\
    --source-driver d1       --source 'd1://<account_id>/<database_id>' \\
    --target-driver postgres --target '<pg-dsn>'`)}
<p>DSN forms are <code>d1://&lt;account_id&gt;/&lt;database_id&gt;</code> or the short <code>d1://&lt;database_id&gt;</code> (account from <code>CLOUDFLARE_ACCOUNT_ID</code>). A missing token, account, or database id is refused loudly at startup, before any request.</p>

<h2 id="dates">Dates, times, and booleans</h2>
<p>SQLite and D1 have no native temporal or boolean storage. sluice maps a column whose <em>declared</em> type names one (<code>DATE</code> / <code>DATETIME</code> / <code>TIMESTAMP</code> / <code>TIME</code>, <code>BOOL</code> / <code>BOOLEAN</code>) to the right target type, and you tell it how the <em>values</em> are encoded with <code>--sqlite-date-encoding</code>:</p>
<table><thead><tr><th>Encoding</th><th>Temporal values stored as</th></tr></thead><tbody>
<tr><td><code>iso</code> (default)</td><td class="desc">ISO-8601 <strong>TEXT</strong>, e.g. <code>'2024-01-02 03:04:05'</code></td></tr>
<tr><td><code>unixepoch</code></td><td class="desc">INTEGER unix <strong>seconds</strong></td></tr>
<tr><td><code>unixmillis</code></td><td class="desc">INTEGER/REAL unix <strong>milliseconds</strong></td></tr>
<tr><td><code>julian</code></td><td class="desc">REAL/INTEGER <strong>Julian day</strong></td></tr>
</tbody></table>
<p>A value whose storage class doesn't match the chosen encoding — or ISO text matching no layout, or a non-truthy boolean — is <strong>refused loudly, naming the row</strong>, never a silently-wrong date. Carry a genuine outlier raw with <code>--type-override &lt;col&gt;=text</code>. Preview the resolved types first with <a href="/docs/preview-and-validate/">schema preview</a>.</p>
<p>Column <strong>DEFAULT</strong> expressions are carried too: a SQLite <code>datetime('now')</code> / <code>CURRENT_TIMESTAMP</code> default becomes the target's <code>CURRENT_TIMESTAMP</code> (<code>date('now')</code>→<code>CURRENT_DATE</code>, <code>time('now')</code>→<code>CURRENT_TIME</code>). A non-portable default expression is dropped with a loud WARN rather than emitted as an expression the target can't evaluate — the column keeps its type, just without the default.</p>

<h2 id="infer-types">Richer target types with <code>--infer-types</code></h2>
<p>Because SQLite/D1 storage is dynamically typed, the safe default maps a source conservatively and losslessly — <code>INTEGER</code>→<code>bigint</code>, <code>TEXT</code>→<code>text</code>. That never fails and never loses data, but a clean dataset often wants native Postgres types. <code>--infer-types</code> (opt-in, SQLite/D1 source only) promotes <code>INTEGER</code>→<code>boolean</code>, ISO-8601 <code>TEXT</code>→<code>timestamptz</code>/<code>timestamp</code>, JSON <code>TEXT</code>→<code>jsonb</code>, and UUID <code>TEXT</code>→<code>uuid</code> — but <strong>only after validating the actual data</strong>:</p>
${pre(`sluice migrate \\
    --source-driver d1       --source 'd1://<account_id>/<database_id>' \\
    --target-driver postgres --target '<pg-dsn>' \\
    --infer-types`)}
<p>Candidates are picked by name hint (<code>is_*</code>/<code>*_flag</code>; <code>*_at</code>/<code>created</code>/<code>updated</code>; <code>*_json</code>/<code>metadata</code>/<code>payload</code>; <code>*_id</code>/<code>*_uuid</code>) and then each is gated by one aggregate pushed down to the source — a boolean column promotes only if <em>no</em> value is outside <code>(0,1)</code>, a UUID column only if every value matches an anchored hex-UUID <code>GLOB</code>, and so on. A <code>*_id</code> holding <code>cus_abc123</code> fails UUID validation and <strong>stays <code>text</code></strong> — the exact case that's a total-data-loss failure under name-only type guessing. Temporal handling is tz-aware (<code>timestamptz</code> only when every value carries an offset, else naive <code>timestamp</code>); a <strong>mixed</strong> offset/naive column or a <strong>sub-microsecond</strong> fraction is kept <code>text</code> rather than risk a silent UTC-shift or rounding. A structured report names every promotion (with the validated row count) and every column kept safe. An explicit <code>--type-override</code> always wins.</p>
<div class="note"><strong>On a live D1, inference stages locally first (automatic).</strong> Cloudflare D1's query API rejects the rich-type validation patterns (its <code>GLOB</code> complexity limit), so against <code>--source-driver d1</code> sluice first replicates the database into a byte-faithful local SQLite file and validates there — engaged automatically when you pass <code>--infer-types</code> (v0.99.167). The staged copy is lossless (exact storage classes, integers above 2<sup>53</sup> included — unlike <code>wrangler d1 export</code>), so inference sees the original types and decides identically. Pass <code>--stage-local</code> to stage even without inference (a faster local bulk read), or <code>--no-stage-local</code> to force the direct path. A plain D1 migrate without <code>--infer-types</code> streams directly as before. (Not needed for a local SQLite file — it has no such limit.)</div>

<h2 id="orm-tables">ORM bookkeeping tables</h2>
<p>An app's ORM keeps its migration state in a bookkeeping table — Rails <code>schema_migrations</code>, Prisma <code>_prisma_migrations</code>, Drizzle <code>__drizzle_migrations</code>, Laravel <code>migrations</code>, Flyway, Goose, and more. That state describes the <em>source</em> engine's schema history and is meaningless — sometimes actively misleading — on a different target engine. On a <strong>cross-engine</strong> migrate (e.g. D1→Postgres) sluice skips these by default, <strong>announcing each skip by name</strong> so nothing vanishes silently. Copy them anyway with <code>--include-orm-tables</code>; on a same-engine run they're kept by default (the history is still valid) unless you pass <code>--skip-orm-tables</code>. Recognition is by distinctive name plus a column-shape guard for the generic names (<code>migrations</code>, <code>schema_migrations</code>), so an app table that merely shares a name isn't skipped by accident.</p>

<h2 id="target">SQLite as a target</h2>
<p>SQLite is also a migrate <strong>target</strong> (<code>--target-driver sqlite</code>) — emit a <code>.db</code> from any source (decimals are stored byte-exact as <code>TEXT</code> affinity, not lossy <code>REAL</code>), e.g. to then run <code>wrangler d1 import</code>. D1 itself is not a write target; produce a SQLite <code>.db</code> and import it with wrangler.</p>
${pre(`sluice migrate \\
    --source-driver postgres --source '<pg-dsn>' \\
    --target-driver sqlite   --target ./out.db`)}

<h2 id="continuous">Continuous sync (trigger-CDC)</h2>
<p>The base <code>sqlite</code> and <code>d1</code> engines are migrate-only — SQLite has no logical change stream (its WAL is a physical page-log). For <strong>continuous</strong> sync, sluice captures changes with triggers, via the <code>sqlite-trigger</code> (local file) and <code>d1-trigger</code> (live D1) engines. The lifecycle is explicit — <strong>setup → sync → teardown</strong>:</p>
${pre(`# 1. install per-table capture triggers + the change-log (each table needs a PRIMARY KEY)
sluice trigger setup --source-driver sqlite-trigger --dsn ./app.db --tables=users,orders

# 2. cold-start snapshot, then stream changes continuously
sluice sync start --source-driver sqlite-trigger --source ./app.db \\
    --target-driver postgres --target 'postgres://user:pass@host:5432/db?sslmode=require'

# 3. remove every trigger + the change-log when done (--keep-data to retain it)
sluice trigger teardown --source-driver sqlite-trigger --dsn ./app.db --yes`)}
<p>Big integers and BLOBs round-trip exactly through capture and CDC (the trigger encodes each column as a <code>(typeof, text/hex)</code> pair). Enable <code>PRAGMA journal_mode=WAL</code> on a local source so the poller never blocks the app's writes. Because SQLite has no DDL triggers, a source <code>ALTER TABLE</code> isn't auto-captured — re-run <code>trigger setup</code> after a schema change; <code>sync start</code> refuses loudly on schema drift rather than silently dropping a new column. The live <code>d1-trigger</code> path is identical over the HTTP query API (the token is a D1:Edit token); mind D1's per-write billing and the change-log growth — run <code>sluice trigger prune</code> periodically. Full detail: <a href="https://github.com/sluicesync/sluice/blob/main/docs/operator/sqlite-d1-import.md">the SQLite/D1 operator doc</a>.</p>
`,
    prev: { href: "/docs/redact-pii/", label: "Redact PII" },
    next: { href: "/docs/multi-database/", label: "Migrate many databases or schemas" },
  })
);

// ---- Guide: many databases / schemas in one run --------------------------
write(
  "multi-database",
  page({
    slug: "multi-database",
    title: "Migrate many databases or schemas at once",
    subtitle: "Fan a whole MySQL server or a multi-schema Postgres source out to same-named target namespaces in one run.",
    body: `
<p>By default <code>migrate</code> and <code>sync start</code> move the one database (MySQL) or schema (Postgres) named in the source DSN. The multi-namespace flags move <strong>all</strong> of a server's databases, or all of a Postgres source's schemas, in a single run — snapshot and CDC both — fanning each source namespace out to a <strong>same-named</strong> target namespace. Reach for this with a multi-tenant MySQL server (one database per tenant), a Postgres database holding several application schemas, or any "migrate the whole server" job.</p>
<p>The unifying idea is that <em>a MySQL database is the rough equivalent of a Postgres schema</em>. So there's one internal routing with two spellings: use the <code>--*-database</code> form on a <strong>MySQL source</strong> and the <code>--*-schema</code> form on a <strong>Postgres source</strong>. They're synonyms — mixing both spellings in one invocation is a loud error.</p>
<table><thead><tr><th>Flag</th><th>Meaning</th></tr></thead><tbody>
<tr><td><code>--all-databases</code> / <code>--all-schemas</code></td><td class="desc">Every non-system namespace on the source.</td></tr>
<tr><td><code>--include-database</code> / <code>--include-schema</code></td><td class="desc">Only these (comma-separated, repeatable; glob patterns allowed, e.g. <code>app_*</code>).</td></tr>
<tr><td><code>--exclude-database</code> / <code>--exclude-schema</code></td><td class="desc">Every non-system namespace except these.</td></tr>
</tbody></table>
<p>Within a form, include / exclude / all are mutually exclusive. System namespaces are always excluded (<code>information_schema</code>, <code>performance_schema</code>, <code>mysql</code>, <code>sys</code> on MySQL; <code>pg_catalog</code>, <code>information_schema</code>, <code>pg_toast</code>, <code>pg_temp*</code> on Postgres). When any namespace-scope flag is set, the source DSN's database/schema is <strong>optional</strong> — sluice connects to the server (or, on PG, to the database) rather than a single namespace.</p>

<h2 id="pg-schemas">Postgres source: every schema in one run</h2>
<p>A Postgres database holding <code>sales</code>, <code>billing</code>, <code>inventory</code> → one Postgres target, each schema recreated (auto-created if absent) under its own name:</p>
${pre(`sluice migrate \\
    --source-driver postgres --source 'postgres://user:pw@src/appdb?sslmode=require' \\
    --target-driver postgres --target 'postgres://user:pw@dst/appdb?sslmode=require' \\
    --all-schemas`)}
<p>Continuous sync is identical — just <code>sync start</code> with a <code>--stream-id</code>. Scope with globs, or take everything except a couple:</p>
${pre(`# only the app_* schemas (plus public)
sluice migrate ... --include-schema 'app_*,public'

# everything except the staging schemas
sluice migrate ... --exclude-schema 'scratch,tmp_load'`)}

<h2 id="mysql-databases">MySQL server: every database → Postgres in one run</h2>
<p>A MySQL server hosting one database per tenant/service → a single Postgres target, <strong>each MySQL database recreated as a same-named PG schema</strong> (auto-created). Note the source DSN has no database after the <code>/</code> — with <code>--all-databases</code> it's a server connection:</p>
${pre(`sluice migrate \\
    --source-driver mysql    --source 'root:pw@tcp(src:3306)/' \\
    --target-driver postgres --target 'postgres://user:pw@dst/warehouse?sslmode=require' \\
    --all-databases`)}
<p>MySQL <code>shop</code> / <code>crm</code> / <code>analytics</code> land as PG schemas <code>shop</code> / <code>crm</code> / <code>analytics</code> under <code>warehouse</code>. When the target is also MySQL, each source database is recreated via <code>CREATE DATABASE IF NOT EXISTS</code> — same names, no manual pre-creation.</p>

<h2 id="fan-in">Fan-IN: many sources → one target namespace</h2>
<p>The reverse shape — several independent source databases (e.g. per-microservice MySQL databases) consolidated into <strong>one</strong> Postgres analytics schema. This isn't a <code>--all-*</code> fan-out; it's N separate runs, each pinned to the same target namespace with <code>--target-schema</code> (Postgres-target-only; it prefixes every emitted object and auto-creates the schema):</p>
${pre(`# service A → warehouse.analytics
sluice migrate --source-driver mysql --source 'root:pw@tcp(svc-a:3306)/orders' \\
    --target-driver postgres --target 'postgres://user:pw@dst/warehouse?sslmode=require' \\
    --target-schema analytics

# service B → the SAME warehouse.analytics (run separately)
sluice migrate --source-driver mysql --source 'root:pw@tcp(svc-b:3306)/users' \\
    --target-driver postgres --target 'postgres://user:pw@dst/warehouse?sslmode=require' \\
    --target-schema analytics`)}
<div class="note">To avoid table-name collisions across services landing in one schema, pair <code>--target-schema</code> with <code>--inject-shard-column NAME=VALUE</code>, which adds a per-source discriminator and a composite PK. See the <a href="/docs/commands/#migrate">migrate reference</a>.</div>

<h2 id="rename">Rename a namespace on the way</h2>
<p>By default every source namespace lands in a <strong>same-named</strong> target. To route one to a differently-named target — consolidating <code>legacy_app</code> into <code>app</code>, or namespacing each tenant under a prefix — pass <code>--map-database SRC=DST</code> (MySQL source) or <code>--map-schema SRC=DST</code> (Postgres source), repeatable, for both snapshot and CDC:</p>
${pre(`# MySQL databases shop / crm → PG schemas storefront / sales (analytics keeps its name)
sluice migrate \\
    --source-driver mysql    --source 'root:pw@tcp(src:3306)/' \\
    --target-driver postgres --target 'postgres://user:pw@dst/warehouse?sslmode=require' \\
    --all-databases \\
    --map-database shop=storefront \\
    --map-database crm=sales`)}
<p>The spelling rule matches the fan-out flags — <code>--map-database</code> on a MySQL source, <code>--map-schema</code> on a Postgres source; mixing both in one run is a loud error. The rename is purely a target-side routing: source-keyed <code>--redact</code> and <code>--type-override</code> still match on the <em>original</em> source name, so a remap never quietly disables a redaction rule.</p>

<h2 id="edges">The documented edges</h2>
<ul>
  <li><strong>Cross-database / cross-schema foreign keys are refused loudly.</strong> A fan-out validates that FK referents are inside the selected set; an out-of-scope FK fails loudly at the deferred FK pass (after the copy), never silently dropped.</li>
  <li><strong>Separate Postgres <em>databases</em> are one run each.</strong> A PG connection is scoped to a single database, so <code>--all-schemas</code> covers every schema <em>within</em> the connected database; moving N separate PG databases is N runs (one <code>--source</code> DSN each).</li>
  <li><strong>PlanetScale-MySQL is a single keyspace</strong> and isn't a multi-namespace target — fanning several source databases into one PS-MySQL branch would collapse and collide. PlanetScale-Postgres behaves like regular Postgres and takes <code>--all-schemas</code> fine.</li>
  <li><strong>Default routing is same-name; rename with <code>--map-database</code> / <code>--map-schema</code>.</strong> Each source namespace lands in a target namespace of the same name unless you remap it (see below). For the fan-IN shape use <code>--target-schema</code>.</li>
</ul>
`,
    prev: { href: "/docs/import-sqlite-d1/", label: "Import SQLite or Cloudflare D1" },
    next: { href: "/docs/copy-table-subset/", label: "Copy a subset of tables" },
  })
);

// ---- Guide: copy a subset of tables (cross-engine, with continuous sync) --
write(
  "copy-table-subset",
  page({
    slug: "copy-table-subset",
    title: "Copy a subset of tables (cross-engine, with continuous sync)",
    subtitle: "Copy one-to-several tables from an existing Postgres database to a PlanetScale MySQL/Vitess (or plain MySQL) target and keep just those continuously in sync.",
    body: `
<p>You don't have to move a whole database. <code>--include-table</code> / <code>--exclude-table</code> scope a <a href="/docs/commands/#migrate">migrate</a> or a <a href="/docs/commands/#sync-start">sync start</a> to just the tables you choose — for both the bulk copy <strong>and</strong> the CDC stream — so you can copy one-to-several tables from an existing Postgres database into a PlanetScale MySQL/Vitess (or plain MySQL) target and keep only those continuously in sync. This guide covers selecting the tables, how Postgres schemas map onto MySQL databases/keyspaces (the part people get surprised by), the PlanetScale keyspace prerequisite, and foreign-key handling for Vitess targets.</p>

<h2 id="select">Select the tables</h2>
<p>Two mutually-exclusive flags scope any run. Use one or the other, never both:</p>
<ul>
  <li><code>--include-table t1,t2</code> — copy <em>only</em> these (comma-separated, repeatable, and glob-aware, e.g. <code>app_*</code>).</li>
  <li><code>--exclude-table t1,t2</code> — copy everything <em>except</em> these (same syntax).</li>
</ul>
<p>The scope is honored end to end: it filters the bulk copy, the VStream / logical-replication cold-start snapshot, <em>and</em> the live CDC apply. An excluded table in a large source is <strong>never even read</strong> — not merely "not written" — so scoping down a big source is cheap, not just tidy.</p>
${pre(`sluice migrate \\
    --source-driver postgres --source 'postgres://user:pw@src/appdb?sslmode=require&schema=app' \\
    --target-driver mysql    --target 'root:pw@tcp(dst:3306)/app' \\
    --include-table users,orders`)}

<h2 id="schema-mapping">How Postgres schemas map to MySQL</h2>
<p>This is the crux, and it surprises people: <strong>a Postgres <em>schema</em> and a MySQL <em>database</em> are the same namespace tier</strong>. So when the target is MySQL, a PG schema maps to a MySQL <strong>database</strong> — not to a table prefix, and never flattened silently into one place.</p>

<h3 id="single-schema">Default — one schema in, one database out</h3>
<p>By default the source DSN's <code>?schema=app</code> (or <code>public</code>) names the single namespace copied; every other schema on the source is ignored — there is <strong>no flattening</strong>. On a plain MySQL target the <strong>target database must already exist</strong>: sluice does not create it, and a missing one fails loudly rather than guessing:</p>
${pre(`# target database 'app' must already exist on plain MySQL, or:
#   Error 1049 (42000): Unknown database 'app'
sluice migrate \\
    --source-driver postgres --source 'postgres://user:pw@src/appdb?sslmode=require&schema=app' \\
    --target-driver mysql    --target 'root:pw@tcp(dst:3306)/app' \\
    --include-table users,orders`)}

<h3 id="fan-out">Copy more exactly — each schema to its own database</h3>
<p>If you want to bring several schemas across faithfully, fan them out: <code>--all-schemas</code> (every non-system schema) or <code>--include-schema app,reporting</code> (glob-aware). Each PG schema becomes an <strong>auto-created same-named MySQL database</strong>, and same-named tables in different schemas stay <strong>separate</strong> — <code>app.users</code> and <code>reporting.users</code> are two distinct target tables in two distinct databases, never merged. Use a target DSN with a trailing <code>/</code> and no database, so the run connects to the server rather than one database:</p>
${pre(`sluice migrate \\
    --source-driver postgres --source 'postgres://user:pw@src/appdb?sslmode=require' \\
    --target-driver mysql    --target 'root:pw@tcp(dst:3306)/' \\
    --include-schema app,reporting`)}
<p>This is the "copy more of the database, exactly" answer: multiple target databases, one per schema. On PlanetScale each of those target databases is a <strong>keyspace</strong> — see <a href="#planetscale">the keyspace note below</a>, which changes the pre-creation rule.</p>

<h3 id="no-flatten">Flattening many schemas into one database is refused</h3>
<p>Merging two source schemas into a single target database is <strong>deliberately refused</strong>, because it would collide same-named tables and silently lose one. <code>--map-schema app=x --map-schema reporting=x</code> errors:</p>
${pre(`many-to-one is refused; sluice never merges two source namespaces into one target`)}
<p><code>--map-schema old=new</code> is a <strong>1:1 rename only</strong> — e.g. <code>--map-schema app=app_prod</code> routes one schema to one differently-named database. It is not a merge tool.</p>

<h3 id="include-under-fanout"><code>--include-table</code> under fan-out is per-schema</h3>
<p>When you combine table scoping with a fan-out, the table filter applies <strong>per schema, not globally</strong>. So <code>--all-schemas --include-table users</code> copies <em>both</em> <code>app.users</code> and <code>reporting.users</code> — the name is matched inside each schema independently.</p>
<div class="note warn"><strong>Gotcha: a fanned-out schema with no matching table fails the whole run.</strong> If any selected schema has no table matching <code>--include-table</code> (a stray empty <code>public</code> is the classic case), the run ends in a loud non-zero error even though every <em>other</em> schema copied fine. Pair <code>--all-schemas --include-table …</code> with <code>--exclude-schema public</code> (or list exactly the schemas you mean with <code>--include-schema</code>) so no empty namespace is in scope.</div>

<h3 id="mapping-summary">Summary</h3>
<table><thead><tr><th>Scenario</th><th>Target namespaces</th><th>Auto-create target DB?</th><th>Same-named tables</th></tr></thead><tbody>
<tr><td class="desc">Single schema (default)</td><td class="desc">The one schema in the DSN → one database</td><td class="desc">No — database must pre-exist on plain MySQL</td><td class="desc">n/a (one namespace)</td></tr>
<tr><td class="desc">Fan-out (<code>--all-schemas</code> / <code>--include-schema</code>)</td><td class="desc">Each schema → its own same-named database</td><td class="desc">Yes on plain MySQL (keyspace must pre-exist on PlanetScale)</td><td class="desc">Stay separate — never merged</td></tr>
<tr><td class="desc">Flatten (<code>--map-schema a=x --map-schema b=x</code>)</td><td class="desc">Refused</td><td class="desc">—</td><td class="desc">—</td></tr>
<tr><td class="desc"><code>--include-table</code> under fan-out</td><td class="desc">Filter applied per-schema</td><td class="desc">Per the fan-out row above</td><td class="desc">One copy per schema that has the table</td></tr>
</tbody></table>

<h2 id="planetscale">PlanetScale / Vitess keyspaces</h2>
<div class="note warn"><strong>On a PlanetScale/Vitess target, the DSN's database is the <em>keyspace</em>, and sluice does NOT auto-create it.</strong> Unlike plain MySQL — where a fan-out target database is created for you — a PlanetScale/Vitess keyspace must be <strong>pre-provisioned</strong>. <code>pscale database create app</code> gives you the default keyspace (named after the database); create more with <code>pscale keyspace create … --wait</code>. A missing keyspace fails loudly <em>before any data moves</em>:
${pre(`Error 1105 (HY000): VT05003: unknown database 'app' in vschema`)}
So an <code>--all-schemas</code> fan-out to PlanetScale requires <strong>every</strong> target keyspace to exist first — create them all before the run. Use <code>--target-driver planetscale</code> and a DSN of the form <code>…/&lt;keyspace&gt;?tls=true</code> (the PlanetScale MySQL DSN uses <code>?tls=true</code>, not the Postgres <code>sslmode=…</code>).</div>

<h2 id="sync">Keep only the subset in sync</h2>
<p>The same table scope carries onto <code>sync start</code>: it cold-copies <strong>only</strong> the included tables, then tails CDC for <strong>only</strong> those. An insert into an excluded table is never created or streamed on the target — the excluded table is outside the stream entirely (live-confirmed):</p>
${pre(`sluice sync start --stream-id sub \\
    --source-driver postgres   --source 'postgres://user:pw@src/appdb?sslmode=require&schema=app' \\
    --target-driver planetscale --target 'USER:PASS@tcp(aws.connect.psdb.cloud:3306)/<keyspace>?tls=true' \\
    --include-table users`)}
<p>Watch it, gate cutover on freshness, then drain and stop:</p>
${pre(`sluice sync status --stream-id sub \\
    --target-driver planetscale --target "$SLUICE_TARGET"

sluice sync health --stream-id sub \\
    --target-driver planetscale --target "$SLUICE_TARGET" --max-stale-seconds 30

sluice sync stop --stream-id sub \\
    --target-driver planetscale --target "$SLUICE_TARGET" --wait`)}
<div class="note"><strong>Two operational callouts.</strong> First, <code>sync stop</code> requires <code>--target-driver</code> and <code>--target</code> — it reads the stream's state from the target, so it errors with a "missing flags" message without them. Second, a stopped <strong>Postgres</strong> stream leaves its replication slot behind on the source; drop it before starting a fresh stream (<code>SELECT pg_drop_replication_slot('sluice_slot');</code>) or sluice refuses loudly with <em>"replication slot already exists; drop it before starting"</em>. The Postgres source also needs <code>wal_level=logical</code> — see <a href="/docs/postgres-source-prep/">Prepare a Postgres source</a>.</div>

<h2 id="foreign-keys">Foreign keys on a Vitess target</h2>
<p><em>See the full guide: <a href="/docs/foreign-keys-vitess/">Foreign keys on a Vitess / PlanetScale target</a> — the two strategies (skip-and-index vs enable-FK-support) and how to choose. The short version:</em></p>
<p>If your subset carries foreign keys and you're targeting PlanetScale/Vitess — where cross-shard FKs don't work and FK support is opt-in per database — <strong><code>--skip-foreign-keys</code> (v0.99.198+)</strong> skips creating the FK constraints on the target while keeping each FK's referencing columns indexed. It synthesizes a backing index only when an existing target index doesn't already cover those columns as a left-prefix, so you transition an FK-bearing source <em>without stripping the FKs from it first</em>, and joins stay fast. Add it to the <code>migrate</code> or <code>sync start</code> command:</p>
${pre(`sluice migrate \\
    --source-driver postgres    --source 'postgres://user:pw@src/appdb?sslmode=require&schema=app' \\
    --target-driver planetscale --target 'USER:PASS@tcp(aws.connect.psdb.cloud:3306)/<keyspace>?tls=true' \\
    --include-table users,orders \\
    --skip-foreign-keys`)}
<p>It is mutually exclusive with <code>--allow-degraded-fks</code> (opposite intents — one skips FK creation, the other creates FKs and tolerates dirty source rows), and it is never silent: each skipped FK is reported on its own log line (the table, the referencing columns, and the synthesized or already-covering index) plus a summary count. Alternatively, <strong>enable FK support on the PlanetScale database</strong> instead of skipping — turn on "Allow foreign key constraints" in the target database's Settings → General tab (unsharded databases only) so sluice's FK DDL is accepted; see the <a href="/docs/planetscale-region-move/#notes">region-move guide's foreign-key note</a>.</p>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/multi-database/">Migrate many databases or schemas</a> — the full fan-out story across every schema or database at once.</li>
  <li><a href="/docs/planetscale-postgres/">PlanetScale Postgres</a>, <a href="/docs/planetscale-region-move/">Move PlanetScale regions</a>, and <a href="/docs/planetscale-vitess/">PlanetScale &amp; Vitess</a> — the target-side setup for each PlanetScale flavor.</li>
  <li><a href="/docs/verify-reconcile/">Verify &amp; reconcile</a> — confirm only the tables you scoped landed, with matching <code>--include-table</code>.</li>
  <li><a href="/docs/commands/#migrate">Command reference</a> — every flag named here, with defaults.</li>
</ul>
`,
    prev: { href: "/docs/multi-database/", label: "Migrate many databases or schemas" },
    next: { href: "/docs/foreign-keys-vitess/", label: "Foreign keys on a Vitess target" },
  })
);

// ---- Guide: foreign keys on a Vitess / PlanetScale target ----------------
write(
  "foreign-keys-vitess",
  page({
    slug: "foreign-keys-vitess",
    title: "Foreign keys on a Vitess / PlanetScale target",
    subtitle: "Migrating or syncing a foreign-key-bearing source into Vitess or PlanetScale MySQL — the two strategies (skip-and-index, or enable FK support) and how to choose.",
    body: `
<p>When the target is <strong>Vitess</strong> — or <strong>PlanetScale MySQL</strong>, which is managed Vitess — foreign keys need a decision that a plain MySQL or Postgres target doesn't force on you. This guide covers why, the two strategies sluice supports, and which one to pick. It applies to both the one-shot <a href="/docs/commands/#migrate">migrate</a> and the <a href="/docs/commands/#sync-start">sync start</a> cold-start.</p>

<h2 id="why">Why Vitess is different</h2>
<p>Vitess treats foreign keys specially, for two reasons:</p>
<ul>
  <li><strong>Cross-shard FKs don't work.</strong> A sharded keyspace can't enforce a constraint whose parent and child rows live on different shards — there's no shard-spanning transaction to check referential integrity against.</li>
  <li><strong>On PlanetScale, FK support is opt-in per database, and only on <em>unsharded</em> databases.</strong> By default PlanetScale rejects <code>FOREIGN KEY</code> DDL outright (Vitess answers with <code>VT10001</code>); you turn support on per database, and even then only when the database is unsharded.</li>
</ul>
<p>So migrating an FK-bearing source — a Postgres or MySQL database that <em>has</em> foreign keys — into Vitess/PlanetScale needs a call: skip the FKs, or turn FK support on. sluice supports both, and <strong>never silently drops a constraint</strong> — whichever path you take is explicit and logged.</p>

<h2 id="skip">Strategy 1 — skip the constraints, keep the columns indexed</h2>
<p><strong><code>--skip-foreign-keys</code></strong> (v0.99.198+, on <code>migrate</code> and <code>sync start</code>) skips creating the FK constraints on the target, but ensures each skipped FK's <strong>referencing column tuple is still indexed</strong>. It synthesizes a plain backing index <em>only</em> when no existing target index already covers those columns as a left-prefix — never a redundant one.</p>
<div class="note"><strong>Why the index matters.</strong> On a MySQL/Vitess target, MySQL auto-creates an FK's backing index only when the FK <em>itself</em> is created. A naive skip would therefore leave the referencing column unindexed and slow every join through it. sluice keeps the column indexed so joins stay fast — you get the transition without the performance cliff.</div>
<p>This lets an existing FK-bearing database transition <strong>without stripping the FKs from the source first</strong>. It's the right choice for a <strong>sharded</strong> target (where FKs can't be enforced anyway) or any target where FKs are managed out-of-band.</p>
${pre(`sluice migrate \\
    --source-driver postgres    --source 'postgres://user:pw@src/appdb?sslmode=require&schema=app' \\
    --target-driver planetscale --target 'USER:PASS@tcp(aws.connect.psdb.cloud:3306)/<keyspace>?tls=true' \\
    --skip-foreign-keys`)}
<p>The same flag is available on <code>sync start</code>, where it applies to the cold-start schema-apply — steady-state CDC apply never creates FKs, so nothing else changes. It is <strong>mutually exclusive with <code>--allow-degraded-fks</code></strong> (opposite intents — one skips FK creation, the other creates FKs and tolerates dirty source rows) and sluice refuses loudly if both are set. And it is <strong>never silent</strong>: each skipped FK is logged on its own line — the table, the referencing columns, and the synthesized or already-covering index — plus a summary count at the end of the run.</p>

<h2 id="enable">Strategy 2 — enable FK support on an unsharded PlanetScale database</h2>
<p>If the target is an <strong>unsharded</strong> PlanetScale database and you <em>want</em> the foreign keys, turn on <strong>"Allow foreign key constraints"</strong> in the database's <strong>Settings → General</strong> tab in the PlanetScale UI. This is a toggle, not a <code>pscale</code> flag — the operator sets it after creating the database, and it applies to unsharded databases only.</p>
<p>Once it's on, no special sluice flag is needed: sluice's normal foreign-key DDL is accepted and the constraints are created as usual (leave <code>--skip-foreign-keys</code> off). Enable it <em>before</em> you migrate, with no open deploy requests. See the region-move guide's <a href="/docs/planetscale-region-move/#notes">foreign-key note</a> for the full PlanetScale-side caveats (cyclic <code>CASCADE</code> FKs are unsupported; deploy requests don't validate pre-existing rows).</p>

<h2 id="choosing">Which to use</h2>
<table><thead><tr><th>Target</th><th>Foreign keys?</th><th>Strategy</th></tr></thead><tbody>
<tr><td class="desc">Sharded</td><td class="desc">Can't be enforced cross-shard</td><td class="desc"><strong>Skip</strong> — <code>--skip-foreign-keys</code> (columns stay indexed)</td></tr>
<tr><td class="desc">Unsharded</td><td class="desc">Wanted</td><td class="desc"><strong>Enable FK support</strong> in Settings → General, then migrate normally</td></tr>
<tr><td class="desc">Unsharded</td><td class="desc">Not wanted / managed elsewhere</td><td class="desc"><strong>Skip</strong> — <code>--skip-foreign-keys</code></td></tr>
</tbody></table>
<div class="note">The two strategies are not combined. <code>--skip-foreign-keys</code> means <strong>no FK DDL at all</strong> — it doesn't emit constraints for an FK-enabled database to accept. Enable FK support <em>or</em> skip; pick one per target.</div>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/copy-table-subset/">Copy a subset of tables</a> — scope a migrate or sync to just the tables you choose; FK handling in context.</li>
  <li><a href="/docs/planetscale-vitess/">PlanetScale &amp; Vitess</a> — the full target-side setup for a Vitess/PlanetScale-MySQL destination.</li>
  <li><a href="/docs/planetscale-region-move/">Move PlanetScale regions</a> — the FK-enablement note lives in its "Before you start" section.</li>
  <li><a href="/docs/planetscale-postgres/">PlanetScale Postgres</a> — the other PlanetScale flavor, where FKs behave like normal Postgres.</li>
  <li><a href="/docs/commands/#migrate">Command reference</a> — <code>--skip-foreign-keys</code>, <code>--allow-degraded-fks</code>, and every other flag, with defaults.</li>
</ul>
`,
    prev: { href: "/docs/copy-table-subset/", label: "Copy a subset of tables" },
    next: { href: "/docs/postgres-source-prep/", label: "Prepare a Postgres source" },
  })
);

// ---- Guide: continuous sync from a backup chain --------------------------
write(
  "from-backup-sync",
  page({
    slug: "from-backup-sync",
    title: "Continuous sync from a backup chain (the broker)",
    subtitle: "Replay a backup chain into a target as a long-running broker — no direct source↔target connectivity required.",
    body: `
<p>The <strong>broker</strong> (<code>sluice sync from-backup run</code>) replicates by reading a <a href="/docs/commands/#backup">backup chain</a> instead of connecting to the source's CDC stream directly. One <code>sluice</code> process <em>produces</em> the chain from the source; another <em>tails</em> it and applies the changes to a target. The backup store — S3 / GCS / Azure Blob / local FS — is the message log between them. Reach for this when the source and target can't (or shouldn't) talk directly: an air-gapped target, cross-region DR where the chain already crosses the boundary, or fanning one chain out to several targets.</p>
<div class="note">The broker trades latency and throughput for the <strong>decoupled-transport</strong> property. If your source and target <em>can</em> reach each other directly, <a href="/docs/commands/#sync-start">sync start</a> is lower-latency and higher-throughput — use it instead. The broker is for moderate volumes with decoupled transport.</div>

<h2 id="produce">1. Produce the chain</h2>
<p>On the source side, take a full backup to root the chain, then keep it fed with incrementals. On Postgres add <code>--chain-slot</code> to the full so it provisions the replication slot that anchors the chain (incrementals then chain with zero gap):</p>
${pre(`sluice backup full --source-driver postgres --source 'postgres://...source...' \\
    --target s3://my-bucket/app-chain \\
    --backup-endpoint https://<account>.r2.cloudflarestorage.com \\
    --backup-region auto --backup-path-style \\
    --chain-slot`)}
<p>Then feed it. Either run periodic incrementals from a scheduler:</p>
${pre(`sluice backup incremental --source-driver postgres --source 'postgres://...source...' \\
    --target s3://my-bucket/app-chain \\
    --backup-endpoint https://<account>.r2.cloudflarestorage.com \\
    --backup-region auto --backup-path-style`)}
<p>…or run a continuous producer that commits rolling incrementals on a cadence (a long-lived process — run it under systemd / k8s). <code>--rollover-window</code> sets how often it commits an incremental; <code>--retain-rotate-at-chain-length</code> rotates into a fresh segment to keep segments compact for pruning:</p>
${pre(`sluice backup stream run --source-driver postgres --source 'postgres://...source...' \\
    --target s3://my-bucket/app-chain \\
    --backup-endpoint https://<account>.r2.cloudflarestorage.com \\
    --backup-region auto --backup-path-style \\
    --rollover-window 10s \\
    --retain-rotate-at-chain-length 20`)}

<h2 id="replay">2. Replay it into the target</h2>
<p>On the consumer side, point the broker at the same chain. It reads the chain's catalog every <code>--poll-interval</code>, applies any incrementals newer than its persisted position in chain order, and persists progress in the target's <code>sluice_cdc_state</code>. The <code>--stream-id</code> is required so it can resume cleanly after a restart:</p>
${pre(`sluice sync from-backup run \\
    --backup-target s3://my-bucket/app-chain \\
    --backup-endpoint https://<account>.r2.cloudflarestorage.com \\
    --backup-region auto --backup-path-style \\
    --target-driver postgres --target 'postgres://...target...' \\
    --stream-id app-broker \\
    --apply-concurrency 4 \\
    --poll-interval 10s`)}
<div class="note"><strong><code>--apply-concurrency</code> matters for cross-region targets.</strong> Each incremental's merged change stream is fanned across <code>W</code> in-order PK-hash lanes (same key → same lane → applied in source order), each committing concurrently on its own connection. Without it, a large incremental replayed into a high-latency target applies through a single RTT-bound stream and the broker falls behind. <code>0</code> (default) = <code>auto:4</code>; <code>1</code> = explicit serial; <code>W&gt;1</code> honored. Exactly-once is preserved — every change in an incremental carries the same chain position, so the lanes persist the identical resume position the serial path would.</div>

<h2 id="coldstart">3. Cold-start vs warm-resume</h2>
<p>On its <strong>first</strong> launch against a chain, the broker has no <a href="/docs/database-objects/#target"><code>sluice_cdc_state</code></a> row for the chosen <code>--stream-id</code>, so it doesn't know where in the chain to begin and refuses loudly. There are two ways past that, mutually exclusive:</p>
<ul>
  <li><strong><code>--reset-target-data</code></strong> — drop the target's tables, run a chain restore (full + every incremental up to the tail), then transition to live polling. The full from-the-chain rebuild; suitable when the target is empty or you want a clean rebuild. Prompts (type <code>reset</code>) unless <code>--yes</code>.</li>
  <li><strong><code>--at-chain-id &lt;ID&gt;</code></strong> — operator-asserted resume: tell the broker the target is already at chain ID <code>&lt;ID&gt;</code> (e.g. you just ran a manual <a href="/docs/commands/#restore">sluice restore</a> to bring the target up to a known checkpoint). It writes a fresh state row and tails forward from there — no re-bulking.</li>
</ul>
<p>The common case is the post-<code>restore</code> cold-start: bulk-copy the chain once with <code>sluice restore</code>, then launch the broker with <code>--at-chain-id</code> set to that restore's tail manifest. Pass the flag <strong>only on the first launch</strong>; every subsequent restart warm-resumes from <code>sluice_cdc_state</code> automatically and needs neither flag:</p>
${pre(`# first launch after a fresh restore
sluice sync from-backup run --backup-target s3://my-bucket/app-chain \\
    --target-driver postgres --target 'postgres://...target...' \\
    --stream-id app-broker --apply-concurrency 4 --poll-interval 10s \\
    --at-chain-id 9b12b8ccdc3e7fa9725825ab032e6d6d41d3db09

# every restart after that — warm-resume, no recovery flag
sluice sync from-backup run --backup-target s3://my-bucket/app-chain \\
    --target-driver postgres --target 'postgres://...target...' \\
    --stream-id app-broker --apply-concurrency 4 --poll-interval 10s`)}

<h2 id="stop">4. Stopping cleanly</h2>
<p>Stop the broker by writing a stop signal to the chain destination — the running process observes it on its next tick and exits cleanly. Because the signal lives in the store, you can stop a broker from a different host without process access (both sides agree on the chain, not on the host):</p>
${pre(`sluice sync from-backup stop --backup-target s3://my-bucket/app-chain`)}
<div class="note">The broker follows segment-rotation seams automatically and is restart-resilient on both sides — its idempotent applier absorbs any overlap on resume. Two consumers must use <strong>distinct</strong> <code>--stream-id</code>s for distinct targets, or they'll race on position writes. To rest the chain encrypted, the broker accepts the same encryption flags as the rest of the backup family — see the <a href="/docs/commands/#backup">backup reference</a>.</div>
`,
    prev: { href: "/docs/encrypted-backups/", label: "Take encrypted backups" },
    next: { href: "/docs/agent-skills/", label: "Drive sluice from an AI agent" },
  })
);

// ---- Guide: drive sluice from an AI agent (skills) -----------------------
write(
  "agent-skills",
  page({
    slug: "agent-skills",
    title: "Drive sluice from an AI agent",
    subtitle: "sluice ships task-scoped agent skills — plain-markdown playbooks that let Claude Code, Cursor, or any skill-aware assistant run a migration, verify a sync, or operate a backup chain on your behalf, inside the same safety gate.",
    body: `
<p>sluice ships a set of <strong>agent skills</strong>: task-scoped operator playbooks that let an AI coding agent — <a href="https://www.anthropic.com/claude-code">Claude Code</a>, Cursor, or anything that follows the <a href="/llms.txt">open agent-skills convention</a> — drive the <code>sluice</code> CLI for one concrete job. Each skill is a plain <code>SKILL.md</code> file: no plugins, nothing agent-specific, versioned in the source repo alongside the CLI it drives. They live under <a href="https://github.com/sluicesync/sluice/tree/main/skills"><code>skills/</code></a> in the repository.</p>

<h2 id="why">Why sluice ships them</h2>
<p>sluice already exposes a machine-readable surface built for assistants: an <a href="https://github.com/sluicesync/sluice/blob/main/AGENTS.md"><code>AGENTS.md</code></a> command taxonomy, an <a href="/llms.txt"><code>llms.txt</code></a> docs index, per-command <code>--format json</code> envelopes, stable <code>SLUICE-E-*</code> error codes, and a documented exit taxonomy. A skill sits <em>on top</em> of that surface. It does not re-document the CLI — it references those canonical sources and encodes the <strong>decision tree</strong> for a single task: what to run, how to read the result back, what to report, and where a human must approve before anything changes. One skill, one task, one go/no-go.</p>

<h2 id="catalog">The catalog</h2>
<p>Nine skills ship today, in two tiers.</p>
<h3>Tier 1 — the core loop</h3>
<table><thead><tr><th>Skill</th><th>Use it to</th><th>Writes?</th></tr></thead><tbody>
<tr><td><code>migrate-preflight</code></td><td class="desc">Assess a migrate or sync before running it → a go/no-go with the risks named.</td><td>read-only</td></tr>
<tr><td><code>fidelity-verify</code></td><td class="desc">Confirm a completed migrate / sync / restore is faithful → a fidelity report.</td><td>read-only</td></tr>
<tr><td><code>sluice-error-triage</code></td><td class="desc">Turn a <code>SLUICE-E-*</code> code + exit code into a root cause and a recovery path.</td><td>read-only</td></tr>
<tr><td><code>backup-chain-operator</code></td><td class="desc">Plan and operate an encrypted <a href="/docs/encrypted-backups/">backup chain</a> (full → incremental → compact → prune → restore-test).</td><td>gated</td></tr>
</tbody></table>
<h3>Tier 2 — operational + engine-specific</h3>
<table><thead><tr><th>Skill</th><th>Use it to</th><th>Writes?</th></tr></thead><tbody>
<tr><td><code>cdc-sync-operator</code></td><td class="desc">Stand up and operate <a href="/docs/zero-downtime-cutover/">continuous sync</a> (cold-start → CDC → cutover).</td><td>gated</td></tr>
<tr><td><code>planetscale-migration</code></td><td class="desc">Migrate or sync against <a href="/docs/planetscale-vitess/">PlanetScale / Vitess</a> (VStream, reparent, ownership, metrics-watch).</td><td>gated</td></tr>
<tr><td><code>fleet-operator</code></td><td class="desc">Operate a <a href="/docs/operate-fleet/"><code>sync run</code> fleet</a> — many syncs in one process.</td><td>gated</td></tr>
<tr><td><code>redaction-setup</code></td><td class="desc">Configure and verify <a href="/docs/redact-pii/">PII redaction</a> during migrate / sync.</td><td>gated</td></tr>
<tr><td><code>sqlite-d1-import</code></td><td class="desc"><a href="/docs/import-sqlite-d1/">Import SQLite / Cloudflare D1</a> (<code>--stage-local</code>, <code>--infer-types</code>, big-int / CPU gotchas).</td><td>gated</td></tr>
</tbody></table>

<h2 id="safety">The safety gate</h2>
<p>Every skill honors sluice's command taxonomy — the same gate a careful human operator uses:</p>
<ul>
  <li><strong>Read-only</strong> commands (<code>--dry-run</code>, <code>verify</code>, <code>schema preview</code> / <code>diff</code>, <code>sync health</code> / <code>status</code>, <code>backup verify</code>, <code>engines</code>) run freely.</li>
  <li><strong>State-changing</strong> commands (<code>migrate</code>, <code>sync start</code> / <code>run</code>, <code>backup *</code>, <code>restore</code>, <code>cutover</code>) run only as part of an approved task.</li>
  <li><strong>Destructive flags</strong> (<code>--reset-target-data</code>, <code>--force-cold-start</code>, <code>--yes</code>, <code>backup prune</code> / <code>compact</code> without <code>--dry-run</code>) are <strong>never</strong> passed without explicit human approval for <em>that specific invocation</em>.</li>
</ul>
<div class="note">Every skill also follows sluice's own discipline: <strong>verify by reading state back, never trust an exit code alone</strong>, and treat <code>status:"refused"</code> / exit 3 as a decision point — surface <code>error.hint</code> and wait, don't retry the command unchanged.</div>

<h2 id="getting-started">Getting started</h2>
<ol>
  <li><strong>Install the CLI.</strong> You need the <code>sluice</code> binary — <code>brew install sluicesync/tap/sluice</code>, <code>go install sluicesync.dev/sluice/cmd/sluice@latest</code>, or the <code>ghcr.io/sluicesync/sluice</code> container (see <a href="/docs/getting-started/#install">Getting started</a>).</li>
  <li><strong>Install the skills.</strong> Run the setup script from a checkout of the repo — it detects the agents present and installs each <code>SKILL.md</code> into the right place:
${pre(`./skills/install.sh`)}
  For Claude Code that is <code>~/.claude/skills/&lt;name&gt;/SKILL.md</code> (personal, all projects) or <code>.claude/skills/&lt;name&gt;/SKILL.md</code> (checked into a project); Cursor and others have equivalents. Because the skills are just markdown, you can also copy the directories by hand.</li>
  <li><strong>Describe the task in natural language.</strong> The matching skill's trigger loads it automatically — "migrate this Postgres DB to PlanetScale" pulls in <code>migrate-preflight</code>; "why did this restore fail?" pulls in <code>sluice-error-triage</code> — or invoke one explicitly (<code>/migrate-preflight</code>).</li>
  <li><strong>Review the go/no-go.</strong> The skill drives the CLI on your behalf and returns a go/no-go, a report, or a gated action — and stops at the safety gate for your approval before anything writes.</li>
</ol>

<h2 id="learn-more">Learn more</h2>
<ul>
  <li><a href="https://github.com/sluicesync/sluice/tree/main/skills"><code>skills/</code> in the repository</a> — every <code>SKILL.md</code>, the catalog, and <code>install.sh</code>.</li>
  <li><a href="/llms.txt"><code>llms.txt</code></a> and <a href="/llms-full.txt"><code>llms-full.txt</code></a> — the AI-assistant docs index the skills point at.</li>
  <li><a href="https://github.com/sluicesync/sluice/blob/main/AGENTS.md"><code>AGENTS.md</code></a> — the command taxonomy, standard workflow, JSON-envelope shape, and env-first credentials that the safety gate is built on.</li>
</ul>
`,
    prev: { href: "/docs/from-backup-sync/", label: "Sync from a backup chain" },
    next: { href: "/docs/commands/", label: "Command reference" },
  })
);


// nav-label: How sluice copies your data
write(
  "how-sluice-copies",
  page({
    slug: "how-sluice-copies",
    title: "How sluice copies your data",
    subtitle: "Same-engine vs cross-engine: which internal path a copy takes, and why the fast path never trades correctness for speed.",
    body: `
<p>Every migration and sync moves rows through one of two internal paths. Which one runs is automatic — you don't pick it — but the distinction explains sluice's performance profile and, more importantly, why it never trades correctness for speed.</p>

<h2 id="ir-path">The IR path — the default, and the only path for cross-engine</h2>
<p>Everything cross-engine — MySQL → Postgres, Postgres → MySQL, SQLite → anything — flows through sluice's <strong>internal representation</strong> (IR): a typed, dialect-neutral model of your schema and values. The source reader decodes each row into IR; the target writer encodes IR into the target's wire format. The IR is where every cross-engine capability lives: type translation (MySQL <code>TINYINT(1)</code> ↔ PG <code>BOOLEAN</code>; PG <code>UUID</code> / <code>INET</code> / <code>ARRAY</code> ↔ their MySQL equivalents), <a href="/docs/redact-pii/">PII redaction</a>, <code>--type-override</code> / <code>--expr-override</code>, and the value-fidelity checks that refuse loudly rather than silently coerce. That generality is the point of sluice — but it has a cost: every value is decoded and re-encoded, even when source and target are the same engine and nothing needs to change.</p>

<h2 id="pg-fast-lane">Postgres → Postgres — the fast lane that skips the round trip</h2>
<p>When both sides are Postgres and there is no transformation to apply, the bytes the source emits are exactly the bytes the target wants, so the decode → IR → re-encode round trip buys nothing. sluice detects this and byte-pipes the server's native <code>COPY</code> stream straight from source to target (<code>COPY (SELECT …) TO STDOUT</code> → <code>COPY … FROM STDIN</code>), never materializing an IR row. This is the same tactic <a href="https://github.com/planetscale/pgcopydb">pgcopydb</a> uses, and it closes most of the per-stream throughput gap against it. It composes with sluice's parallel copy — each table, and each primary-key-range chunk of a large table, byte-pipes independently.</p>

<h2 id="mysql-same-engine">MySQL → MySQL — no translation to do, plus a native loader</h2>
<p>A same-engine MySQL copy still flows through the IR (there is no raw byte-pipe for MySQL today), but with source and target identical there is nothing to <em>translate</em> — every type round-trips exactly — and sluice writes through MySQL's native bulk loader (<code>LOAD DATA LOCAL INFILE</code>) on the parallel copy path, the fastest ingest MySQL offers. (PlanetScale blocks <code>LOAD DATA LOCAL</code>, so a PlanetScale target falls back to batched multi-row <code>INSERT</code>.)</p>

<h2 id="same-fidelity">The fast lane is not "more accurate" — it is the same fidelity, less work</h2>
<p>Worth stating plainly: the Postgres byte-pipe is <strong>not a more exact copy</strong> than the IR path. Both are exact. It is faster precisely <em>because</em> it only runs when there is provably nothing to change — so it can move bytes instead of re-deriving them.</p>

<h2 id="safety-gate">The safety gate — why speed never costs you correctness</h2>
<p>The Postgres byte-pipe is guarded by one auditable check that proves there is no transform to skip. The moment any of these is present, sluice falls back to the IR path automatically — <strong>per table</strong>, without you configuring anything:</p>
<ul>
  <li><code>--redact</code> (PII redaction)</li>
  <li><code>--type-override</code> or <code>--expr-override</code></li>
  <li>shard-column injection (<code>--inject-shard-column</code>)</li>
  <li>an OID / wire-format-sensitive type — extension types like pgvector / hstore, <code>bit</code>, or PostGIS <code>geometry</code> — whose per-type codec must run</li>
</ul>
<p>Add a redaction rule to a Postgres → Postgres migrate and the raw lane silently steps aside for exactly the tables that need it; drop the rule and it re-engages. The fast lane is opportunistic and conservative by construction.</p>

<div class="note"><strong>Scope today.</strong> The Postgres byte-pipe runs on the cold-copy phase of <code>migrate</code> (not the <code>sync</code> cold-start or a resume yet). Format is text by default (safe across Postgres major versions); binary is opt-in on matched server majors.</div>
${pre(`# same-engine PG->PG migrate; the raw COPY lane engages automatically
sluice migrate \\
    --source-driver postgres --source 'postgres://user:pass@src:5432/app?sslmode=require' \\
    --target-driver postgres --target 'postgres://user:pass@dst:5432/app?sslmode=require' \\
    --raw-copy-format auto      # text (default) | binary | auto (binary when majors match)`)}

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/commands/#migrate">migrate reference</a> — the parallelism flags (<code>--table-parallelism</code>, <code>--bulk-parallelism</code>) and <code>--raw-copy-format</code>.</li>
  <li><a href="/docs/redact-pii/">Redact PII</a> — the transforms that route a copy onto the IR path.</li>
  <li><a href="/docs/preview-and-validate/">Preview &amp; validate</a> — see the plan before you run it.</li>
</ul>
`,
    prev: { href: "/docs/migrate-mysql-to-postgres/", label: "Migrate MySQL → Postgres" },
    next: { href: "/docs/preview-and-validate/", label: "Preview & validate before you migrate" },
  })
);

// nav-label: Verify & reconcile after
write(
  "verify-reconcile",
  page({
    slug: "verify-reconcile",
    title: "Verify & reconcile after a migration",
    subtitle: "Confirm every row landed and no structural drift crept in — then know exactly what to do when it didn't.",
    body: `
<p><a href="/docs/preview-and-validate/">Preview &amp; validate</a> is the <em>pre</em>-migration companion to this guide: it shows the DDL and steers translation before a row moves. This guide is the <em>post</em>-migration half — after <code>migrate</code> finishes, or after a <a href="/docs/zero-downtime-cutover/">sync</a> has caught up, you want proof that the data actually landed and that the target's shape still matches what sluice would produce. Two read-only commands give you that proof: <a href="/docs/commands/#verify">verify</a> compares the rows, <a href="/docs/commands/#schema">schema diff</a> compares the structure. Both exit non-zero on a discrepancy, so either one drops straight into a cron job or a CI gate.</p>

<h2 id="verify-data">1. Verify the rows landed</h2>
<p><code>verify</code> compares the data itself, on a depth ladder — start cheap, escalate only when you need a stronger guarantee. It never writes to the target.</p>
<table><thead><tr><th>Depth</th><th>What it does</th></tr></thead><tbody>
<tr><td><code>--depth count</code> (default)</td><td class="desc">Per-table row-count comparison. Fast, works across engines, and catches whole-table loss and bulk-row loss.</td></tr>
<tr><td><code>--depth sample</code></td><td class="desc">Counts <em>plus</em> per-table sampled-row content hashes — ~99% confidence of catching a 5%+ corruption rate at the default 100 rows/table. <strong>Same-engine only</strong> (see below).</td></tr>
</tbody></table>
<p>For a cross-engine migration (MySQL&nbsp;→&nbsp;Postgres and the like), <code>count</code> is the mode you run. Server-side row hashing renders values in each engine's own text format, so a cross-engine sample would report false mismatches; sluice refuses <code>--depth=sample</code> loudly when the source and target engines differ rather than hand you a misleading result. Sample mode is for same-engine checks (MySQL&nbsp;→&nbsp;MySQL, Postgres&nbsp;→&nbsp;Postgres).</p>
${pre(`# cross-engine: row-count parity, the everyday post-migrate check
sluice verify --source-driver mysql    --source "$SLUICE_SOURCE" \\
              --target-driver postgres --target "$SLUICE_TARGET" \\
              --depth count

# same-engine: escalate to sampled content hashing
sluice verify --source-driver postgres --source "$SLUICE_SOURCE" \\
              --target-driver postgres --target "$SLUICE_TARGET" \\
              --depth sample --sample-rows-per-table 500`)}
<p>Tune sample mode with <code>--sample-rows-per-table</code> (raise it for tables with rare anomalies), <code>--sample-seed</code> (deterministic — the same seed picks the same rows on both sides; change it to reshuffle), and <code>--strict-hash</code> (SHA-256 instead of MD5, for an extra confidence margin or a compliance posture that requires it). Scope any run with <code>--include-table</code> / <code>--exclude-table</code> (glob-aware, mutually exclusive).</p>
<div class="note"><strong>Full per-row hashing is planned, not yet shipped.</strong> Today the ladder stops at <code>sample</code>; <code>count</code> plus a well-sized same-engine sample is the strongest check available.</div>

<h2 id="json-exit">2. JSON output and cron-friendly exit codes</h2>
<p>Both depths accept <code>--format json</code> and <code>-o FILE</code>, so <code>verify</code> pipes cleanly into a CI gate or an alertmanager pipeline. The JSON carries per-table deltas — source vs target counts, sampled-row count, and the mismatched primary keys when sample mode finds drift — so you get the offending rows, not just a red/green.</p>
${pre(`sluice verify --source-driver mysql    --source "$SLUICE_SOURCE" \\
              --target-driver postgres --target "$SLUICE_TARGET" \\
              --depth count --format json -o verify.json`)}
<p>The exit code is the contract for automation:</p>
<table><thead><tr><th>Exit</th><th>Meaning</th></tr></thead><tbody>
<tr><td><code>0</code></td><td class="desc">Clean — every checked table matched.</td></tr>
<tr><td><code>1</code></td><td class="desc">Mismatch — at least one table differs (a count delta, or a sampled-row hash mismatch).</td></tr>
<tr><td><code>2</code></td><td class="desc">Operational error — couldn't connect, unsupported engine, bad flags. Distinct from <code>1</code> so a gate never conflates "the data differs" with "the check couldn't run".</td></tr>
</tbody></table>
<div class="note"><strong>Redacted migrations.</strong> If you migrated with <code>--redact</code>, the target values differ from the source <em>by design</em> — so a same-engine <code>--depth=sample</code> run will report those rows as content mismatches. Verify redacted migrations with <code>--depth=count</code> (row parity is still meaningful), or scope the sample to unredacted tables with <code>--include-table</code>.</div>

<h2 id="schema-drift">3. Confirm no structural drift</h2>
<p>Row parity doesn't prove the <em>shape</em> is right — an index that failed to build, a column that came back with the wrong type, a constraint that never applied. <code>schema diff</code> reads the live target and compares it against what sluice would produce from the source, then prints the delta with <strong>copy-paste DDL suggestions</strong> to reconcile it. It's read-only — there is no <code>--apply</code> flag by design (ADR-0029); the DDL is for you to review and run. Like <code>verify</code>, it exits non-zero on any difference.</p>
${pre(`sluice schema diff --source-driver mysql    --source "$SLUICE_SOURCE" \\
                   --target-driver postgres --target "$SLUICE_TARGET"`)}
<p>Its exit codes mirror <code>verify</code>: <code>0</code> clean, <code>1</code> drift detected (the gate fails; a one-line summary goes to stderr, the full diff to stdout or <code>-o FILE</code>), <code>2</code> operational error. Trim the noise when part of the target is managed out-of-band: <code>--ignore-charset-collation</code> suppresses MySQL charset/collation diffs, <code>--ignore-extras</code> hides tables/columns/indexes that exist only on the target, and <code>--skip-views</code> drops view comparison entirely. <code>--format json</code> is available for CI. If you steered any types at migrate time with <code>--type-override</code>, pass the identical flags here so the diff compares against the schema you actually intended.</p>

<h2 id="on-mismatch">4. What to do on a mismatch</h2>
<p>A non-zero exit tells you <em>where</em> — the table, and (in sample mode) the mismatched primary keys. From there:</p>
<ul>
  <li><strong>Structural drift (<code>schema diff</code> flagged it).</strong> Read the suggested DDL. If it's a missing index or constraint on an otherwise-correct table, applying the suggestion is often enough. If a column type is wrong, fix it with a <code>--type-override</code> and re-migrate that table rather than hand-patching.</li>
  <li><strong>A count shortfall on a fresh migration.</strong> Re-run <code>migrate</code>. A plain re-run is idempotent for tables that copied cleanly and fills the gap. If the target table is in a partially-written state you want to discard, <code>migrate --reset-target-data</code> is the destructive recovery: it deletes the migrate-state row, drops every source-schema table on the target, and runs a fresh cold-start (it prompts for confirmation — type <code>reset</code>, or pass <code>--yes</code> in automation). See <a href="https://github.com/sluicesync/sluice/blob/main/docs/adr/adr-0023-reset-target-data.md">ADR-0023</a>.</li>
  <li><strong>A drift that appears on a <a href="/docs/zero-downtime-cutover/">running sync</a>.</strong> The equivalent recovery is <code>sync start --reset-target-data</code> — drop the target, restore, then transition back to live polling. Don't reach for it on a transient lag; let the sync catch up and re-verify first.</li>
  <li><strong>The mismatch is on the source side.</strong> If <code>verify</code> reports the <em>target</em> has more rows, or the counts drift on every re-run, suspect the source: rows written after the copy started, a source table still taking writes without a sync, or a filter (<code>--include-table</code>) that differs between the migrate and the verify. Re-verify with the same table scope you migrated.</li>
</ul>

<h2 id="decision-table">5. Symptom → first look</h2>
<table><thead><tr><th>Symptom</th><th>First look</th></tr></thead><tbody>
<tr><td class="desc"><code>verify --depth=count</code> exits 1, target has fewer rows</td><td class="desc">Re-run <code>migrate</code>; if partially written, <code>migrate --reset-target-data</code>.</td></tr>
<tr><td class="desc">Target has <em>more</em> rows than source</td><td class="desc">Source took writes after the copy — reconcile the window, or move to continuous sync before cutover.</td></tr>
<tr><td class="desc"><code>--depth=sample</code> exits 1 on a redacted migration</td><td class="desc">Expected — redacted target content differs. Use <code>--depth=count</code>.</td></tr>
<tr><td class="desc"><code>verify</code> exits 2 (not 1)</td><td class="desc">Operational, not data: connectivity, engine name, or flags. Check the DSNs and <code>--*-driver</code> values.</td></tr>
<tr><td class="desc"><code>schema diff</code> exits 1, missing index/constraint</td><td class="desc">Apply the suggested DDL from the diff output.</td></tr>
<tr><td class="desc"><code>schema diff</code> flags a wrong column type</td><td class="desc">Re-migrate the table with a <code>--type-override</code>; don't hand-patch.</td></tr>
<tr><td class="desc"><code>--depth=sample</code> refused for a cross-engine pair</td><td class="desc">By design — use <code>--depth=count</code> across engines.</td></tr>
</tbody></table>

<h2 id="next-steps">Next steps</h2>
<ul>
  <li><a href="/docs/preview-and-validate/">Preview &amp; validate before you migrate</a> — the pre-migration half: DDL preview and type steering.</li>
  <li><a href="/docs/commands/#verify">Command reference: verify</a> and <a href="/docs/commands/#schema">schema preview / diff</a> — every flag in one place.</li>
  <li><a href="/docs/zero-downtime-cutover/">Zero-downtime migration (continuous sync)</a> — when the source keeps taking writes, verify after the sync catches up.</li>
</ul>
`,
    prev: { href: "/docs/preview-and-validate/", label: "Preview & validate before you migrate" },
    next: { href: "/docs/zero-downtime-cutover/", label: "Zero-downtime migration (continuous sync)" },
  })
);

// nav-label: Schema changes during sync
write(
  "schema-changes",
  page({
    slug: "schema-changes",
    title: "Schema changes during a live sync",
    subtitle: "How sluice keeps a running sync online while the source schema evolves — what forwards automatically, what refuses loudly, and how to recover.",
    body: `
<p>A source schema rarely stands still. Columns get added, types get widened, indexes come and go while a continuous sync is running. sluice does not manage those migrations for you — tools like Atlas, sqitch, Flyway, and liquibase do that — but it does keep the stream online through them. By default it forwards the operator's own committed DDL onto the target, so a routine <code>ALTER TABLE</code> no longer wedges the sync. This page covers what forwards automatically, the narrow set of changes that still refuse loudly, and the drained-migrate recovery when one does.</p>

<h2 id="the-flag">The control: --schema-changes</h2>
<p>A single tristate flag on <code>sync start</code> (and per-sync in a <code>sync run</code> fleet spec) governs the behavior, introduced in <a href="https://github.com/sluicesync/sluice/blob/main/docs/adr/adr-0091-default-on-schema-change-forwarding.md">ADR-0091</a>:</p>
<table>
<thead><tr><th>Mode</th><th>Behavior</th></tr></thead>
<tbody>
<tr><td><code>--schema-changes=forward</code> <em>(default)</em></td><td class="desc">Apply every unambiguous source schema change on the target automatically, logging each applied DDL at INFO. The sync stays online through routine schema evolution.</td></tr>
<tr><td><code>--schema-changes=refuse</code></td><td class="desc">The conservative pre-v0.92 behavior: any source DDL surfaces loudly with a structured drift diff and the drained-model recovery hint. For operators who gate DDL through a separate change-management process.</td></tr>
</tbody>
</table>
<div class="note"><strong>This is a behavior change on upgrade.</strong> A stream that previously refused on source DDL now forwards it. Set <code>--schema-changes=refuse</code> to keep the old drained-model default. Note also that <code>--schema-changes</code> is a no-op under Shape A (<code>--inject-shard-column</code>): the multi-shard boundary router already forwards every shape via its lease. The older <code>--forward-schema-add-column</code> boolean is deprecated — forwarding is on by default and covers every shape, so the flag is subsumed; setting it logs a deprecation warning and forwards.</div>

<h2 id="what-forwards">What forwards, by source engine</h2>
<p>Under <code>forward</code>, the intercept can emit any shape's DDL, but a change only reaches the target if the source's CDC stream actually carries its detail on the wire. Postgres logical replication (pgoutput) carries less than MySQL's <code>information_schema</code> re-read, so the honest matrix differs by <em>source</em> engine. This is the ground-truth table from ADR-0091 §1d — do not assume a shape forwards without checking it:</p>
<table>
<thead><tr><th>Shape</th><th>MySQL source</th><th>Postgres source</th></tr></thead>
<tbody>
<tr><td>ADD COLUMN</td><td class="desc">forwards</td><td class="desc">forwards</td></tr>
<tr><td>DROP COLUMN</td><td class="desc">forwards</td><td class="desc">forwards</td></tr>
<tr><td>ALTER COLUMN TYPE (same- or cross-engine)</td><td class="desc">forwards</td><td class="desc">forwards</td></tr>
<tr><td>ALTER NULLABILITY</td><td class="desc">forwards</td><td class="desc">refuses<sup>1</sup></td></tr>
<tr><td>Column REORDER</td><td class="desc">no-op<sup>2</sup></td><td class="desc">no-op<sup>2</sup></td></tr>
<tr><td>CREATE / DROP INDEX</td><td class="desc">refuses<sup>3</sup></td><td class="desc">refuses<sup>1</sup></td></tr>
<tr><td>ADD / DROP / MODIFY CHECK</td><td class="desc">refuses<sup>3</sup></td><td class="desc">refuses<sup>1</sup></td></tr>
<tr><td>RENAME COLUMN</td><td class="desc">refuses (§rename)</td><td class="desc">forwards via attnum<sup>4</sup></td></tr>
<tr><td>RENAME TABLE / multi-shape combo</td><td class="desc">refuses</td><td class="desc">refuses</td></tr>
</tbody>
</table>
<p style="font-size:0.9em">
<sup>1</sup> pgoutput's relation message carries only column name + type + the replica-identity key flag — no nullability flag, no secondary-index or CHECK metadata. The wire never signals these on a Postgres source, so they produce no boundary to forward. A resulting incompatibility surfaces as a loud apply error on the next affected row, not silent corruption.<br>
<sup>2</sup> sluice decodes rows by column name, never by position, so a pure reorder needs no DDL — it is a safe no-op.<br>
<sup>3</sup> MySQL's CDC projection reads only <code>{schema, name, columns, primary key}</code> on a DDL boundary; it does not project secondary indexes or CHECK constraints. Forwarding them would need a new catalog projection (perf-only for indexes; cross-engine expression-translation-hazardous for checks), so both are deferred.<br>
<sup>4</sup> A Postgres RENAME is proven via the stable <code>pg_attribute.attnum</code> — see <a href="#rename">RENAME COLUMN</a>.
</p>
<p>Every forwarded DDL is logged at INFO as it lands, so the applied change is visible in the sync's log stream. Cross-engine type ALTERs are retargeted through the same translation path a cold-start <code>CREATE TABLE</code> uses; a widening ALTER forwards cleanly, while a narrowing or incompatible one is rejected by the target engine and surfaces as a loud, retryable refuse (position not advanced).</p>

<h2 id="always-refuses">What always refuses, even under forward</h2>
<p>Two shapes never auto-apply, because forwarding the wrong guess would silently lose data:</p>

<h3 id="rename">RENAME COLUMN</h3>
<p>A column rename and a <code>DROP x + ADD y</code> of the same type are <strong>indistinguishable from the replication stream alone</strong> — both present as exactly one dropped column and one added column. Guessing RENAME when the truth is drop+add keeps stale data under the new name; guessing drop+add when the truth is RENAME drops the column's data on the target. The only safe disambiguation is a stable column identity that survives a rename:</p>
<ul>
  <li><strong>Postgres has one</strong> — <code>pg_attribute.attnum</code> is stable across a rename. The PG CDC reader carries it as the column's stable id; the intercept forwards a rename <em>only</em> when the before and after columns share the same non-zero attnum (proven rename, data preserved) and refuses otherwise. Because the proof is definitive, a bug here can only ever refuse safely, never mis-forward.</li>
  <li><strong>MySQL has no equivalent</strong> — <code>ORDINAL_POSITION</code> changes on reorder and there is no creation id, so a MySQL-source rename is fundamentally unprovable from catalog state. It refuses, permanently. Drain and rename on both ends explicitly.</li>
</ul>

<h3 id="volatile-default">ADD COLUMN with a computed / volatile DEFAULT</h3>
<p>An <code>ADD COLUMN</code> whose DEFAULT is a non-deterministic function is refused, because evaluating it in the target's session diverges from the per-row values the source already inserted (ADR-0058 §2a). The refused functions include <code>NOW()</code> / <code>CURRENT_TIMESTAMP</code> / <code>clock_timestamp()</code>, <code>nextval()</code>, <code>gen_random_uuid()</code>, <code>random()</code>, and MySQL's <code>UUID()</code> / <code>RAND()</code> — matched schema-qualified or bare, and detected even when wrapped (e.g. <code>COALESCE(NULL, NOW())</code>). A constant DEFAULT forwards normally. If the probe of a column's default can't be read at all, sluice refuses on uncertainty rather than risk a wrong value.</p>
<p>Multi-shape combos (more than one structural change in a single boundary) also refuse — the IR delta can't be unambiguously ordered — as does a target DDL apply that fails on lock contention, permissions, or an unrecognized type. Every one of these leaves the CDC position un-advanced, so a retry replays the boundary once you've reconciled by hand.</p>

<h2 id="drift-diff">The refusal message</h2>
<p>When a change refuses, the error is deliberately greppable and names the specific offending object plus the operator action. It carries three parts: the classify error (which shape / how many changes), a structured drift diff that names the exact columns / indexes / constraints that differ, and a recovery hint. The hint spells out the drained model:</p>
<ul>
  <li>Run <code>sluice sync stop --wait</code> to drain in-flight changes.</li>
  <li>Apply the schema change on the target (manually, or via <code>sluice schema migrate</code>).</li>
  <li>Resume with <code>sluice sync start --resume</code>.</li>
  <li>It also notes that <code>--schema-changes=refuse</code> keeps the drained model as the default for any subsequent source DDL.</li>
</ul>

<h2 id="drained-migrate">Operator runbook: recovering a refused change</h2>
<p>When a change refuses — or when you run <code>--schema-changes=refuse</code> deliberately — the recovery is the drained-schema-migrate sequence. Stop the stream with <code>--wait</code> so the CLI blocks until the streamer confirms a graceful drain (the in-flight batch is committed and the CDC position is persisted past the last applied event), apply the DDL to whichever side needs it, then resume from the persisted position:</p>
${pre(`# 1. Drain and stop — --wait blocks until the drain is confirmed
sluice sync stop --wait \\
    --stream-id app-prod \\
    --target-driver postgres --target 'postgres://...target...'

# 2. Apply the schema change on source and/or target as appropriate
psql "$SOURCE_DSN" -c 'ALTER TABLE accounts RENAME COLUMN label TO name;'
psql "$TARGET_DSN" -c 'ALTER TABLE accounts RENAME COLUMN label TO name;'

# 3. Resume from the persisted CDC position
sluice sync start --resume \\
    --stream-id app-prod \\
    --source-driver mysql    --source 'root:rootpw@tcp(localhost:3306)/app' \\
    --target-driver postgres --target 'postgres://...target...'`)}
<p>The <code>--resume</code> flag picks up the persisted CDC position (source LSN / GTID set / VStream cursor), so pre-stop events apply cleanly and the first event after resume sees the new shape on both sides. Without <code>--resume</code>, sluice refuses to bulk-copy into a populated target. The order "stop &rarr; ALTER source &rarr; ALTER target &rarr; start" is robust regardless of which side commits the DDL first, as long as both sides carry the new shape before resume.</p>
<div class="note"><strong>Plan the target-side change first.</strong> <code>sluice schema diff</code> runs the source schema through sluice's translation pipeline and reports drift against the target's actual schema — apply the ALTER on the source, run the diff, and it surfaces the missing-on-target columns / type mismatches with suggested <code>ALTER</code> statements as a starting point. It does not know your data volume or lock duration, so review them before running.</div>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/commands/#sync-start">sync start reference</a> — the <code>--schema-changes</code> row and the full sync flag set.</li>
  <li><a href="/docs/migrate-mysql-to-postgres/">Migrate MySQL to Postgres</a> — the one-shot migration the drained model resumes onto.</li>
  <li><a href="/docs/commands/#schema">schema diff / schema migrate</a> — pre-flight drift and apply the target-side change.</li>
</ul>
`,
    prev: { href: "/docs/zero-downtime-cutover/", label: "Zero-downtime migration (continuous sync)" },
    next: { href: "/docs/redact-pii/", label: "Redact PII" },
  })
);

// nav-label: Redact PII
write(
  "redact-pii",
  page({
    slug: "redact-pii",
    title: "Redact PII while you migrate & sync",
    subtitle: "Seed staging, dev, analytics, and vendor handoffs from production without letting personal data leave with the rows.",
    body: `
<p>You need a realistic copy of production in a place production data isn't allowed to go — a staging database, a developer laptop, an analytics warehouse, a vendor's environment. The schema, the row shapes, and the referential structure all have to survive; the emails, card numbers, and national IDs must not. sluice does this inline with <code>--redact</code>: PII is transformed <strong>between the source reader and the target writer</strong>, so the sensitive value never lands on the target and never touches the backup on disk. There is no separate scrubbing pass to forget to run.</p>

<h2 id="how-it-works">How --redact works</h2>
<p>Each rule names a column and a strategy:</p>
${pre(`--redact '[schema.]table.column=STRATEGY[:options]'`)}
<p>The flag is <strong>repeatable</strong> — pass it once per column. Rules are applied in the bulk-copy hot path and the CDC apply path alike; the strategy's output replaces the source value verbatim at the named column before it reaches the target. When no <code>--redact</code> is configured the pipeline short-circuits before any per-row work, so operators who don't use redaction pay nothing for the feature.</p>
${pre(`sluice migrate \\
    --source-driver postgres --source "$SRC" \\
    --target-driver postgres --target "$DST" \\
    --redact users.email=hash:sha256`)}
<p>Every rule also has a YAML form under a <code>redactions:</code> block in the config file (see <a href="/docs/configuration/">Configuration</a>). CLI and YAML mix: CLI rules are processed first, YAML appends, and a duplicate on the same <code>schema.table.column</code> is last-write-wins with a WARN. Keep the bulk in version-controlled YAML; reach for the flag for per-environment overrides (<code>--redact users.email=null</code> in staging).</p>

<h2 id="where-it-applies">Where redaction applies</h2>
<p>The same rule set is honoured uniformly across every path that moves rows, so a column can't leak through a surface you forgot about:</p>
<table>
<thead><tr><th>Command</th><th>Behaviour</th></tr></thead>
<tbody>
<tr><td><code>sluice migrate</code></td><td class="desc">One-shot bulk copy — every row passes through the redactor.</td></tr>
<tr><td><code>sluice sync start</code></td><td class="desc">Both phases honour <code>--redact</code>: the cold-start snapshot copy <em>and</em> the live CDC apply stream.</td></tr>
<tr><td><code>sluice backup full</code> / <code>incremental</code></td><td class="desc">Backup chunks are PII-clean on disk; a later restore copies them through unchanged.</td></tr>
<tr><td><code>sluice schema preview</code></td><td class="desc">No data moves — it annotates the generated <code>CREATE TABLE</code> DDL with which columns are redacted (see below).</td></tr>
</tbody>
</table>

<h2 id="strategies">The strategy families</h2>
<p>sluice ships 26 strategies across five families. Pick the one that matches the column's shape.</p>

<h3>Constant &amp; foundational</h3>
<table>
<thead><tr><th>Strategy</th><th>Behaviour</th></tr></thead>
<tbody>
<tr><td><code>null</code></td><td class="desc">Replace with <code>NULL</code>. Refuses on <code>NOT NULL</code> columns — use <code>static:</code> there instead.</td></tr>
<tr><td><code>static:&lt;value&gt;</code></td><td class="desc">Replace every value with one literal constant.</td></tr>
<tr><td><code>truncate:&lt;n&gt;</code></td><td class="desc">Keep the first N runes (rune-counted; UTF-8 and emoji safe).</td></tr>
<tr><td><code>hash:sha256</code></td><td class="desc">SHA-256 hex digest — deterministic, no key required.</td></tr>
<tr><td><code>hash:hmac-sha256</code></td><td class="desc">Keyed HMAC-SHA256 hex digest — requires <code>--keyset-source</code> (see below).</td></tr>
</tbody>
</table>

<h3>Format-preserving masks</h3>
<p>Generic masks keep some characters and blank the rest (default mask char <code>X</code>):</p>
<table>
<thead><tr><th>Strategy</th><th>Behaviour</th></tr></thead>
<tbody>
<tr><td><code>mask:inner:&lt;m1&gt;,&lt;m2&gt;[,&lt;char&gt;]</code></td><td class="desc">Keep first M1 + last M2 runes; mask the middle. <code>mask:inner:4,4</code> on <code>4111111111111111</code> → <code>4111XXXXXXXX1111</code>.</td></tr>
<tr><td><code>mask:outer:&lt;m1&gt;,&lt;m2&gt;[,&lt;char&gt;]</code></td><td class="desc">Mask the first M1 + last M2; keep the middle.</td></tr>
</tbody>
</table>
<p>Country- and format-specific presets validate the input shape and preserve just the non-identifying part:</p>
<table>
<thead><tr><th>Preset</th><th>Behaviour</th></tr></thead>
<tbody>
<tr><td><code>mask:ssn</code></td><td class="desc">US SSN — preserve last 4 (<code>XXX-XX-NNNN</code>).</td></tr>
<tr><td><code>mask:pan</code> / <code>mask:pan-relaxed</code></td><td class="desc">Card PAN — preserve first 6 + last 4. <code>mask:pan</code> requires a valid Luhn checksum; <code>mask:pan-relaxed</code> skips the check.</td></tr>
<tr><td><code>mask:email</code></td><td class="desc">First char of the local part + masked middle + full <code>@domain</code>.</td></tr>
<tr><td><code>mask:ca-sin</code></td><td class="desc">Canadian SIN — preserve last 3 (Luhn-validated).</td></tr>
<tr><td><code>mask:uk-nin</code></td><td class="desc">UK National Insurance number — keep prefix letters + suffix, mask the digits.</td></tr>
<tr><td><code>mask:iban</code></td><td class="desc">IBAN — preserve country code, check digits, 2 BBAN, and last 4.</td></tr>
<tr><td><code>mask:uuid</code></td><td class="desc">UUID — preserve hyphens + first 4 + last 4 hex. See the caveat below.</td></tr>
</tbody>
</table>
<div class="note"><strong><code>mask:uuid</code> on a native <code>uuid</code> column.</strong> The masked output contains <code>X</code> characters that aren't valid hex, so a target column typed <code>uuid</code> (Postgres) refuses at preflight — before any data moves — unless you also map that column to text with <code>--type-override=table.col=text</code>.</div>

<h3>Realistic synthetic values (randomize)</h3>
<p>The <code>randomize:*</code> generators produce fresh, valid-shape fake values — ideal when staging needs data that <em>looks</em> real. Output is <strong>replay-stable per source row</strong>: the same source primary key always regenerates the same target value across CDC resume, cold-start re-apply, and backup → restore (<a href="https://github.com/sluicesync/sluice/blob/main/docs/adr/adr-0039-randomize-strategy-determinism.md">ADR-0039</a>).</p>
<table>
<thead><tr><th>Strategy</th><th>Output</th></tr></thead>
<tbody>
<tr><td><code>randomize:int:&lt;min&gt;,&lt;max&gt;</code></td><td class="desc">Integer in <code>[min, max]</code> inclusive.</td></tr>
<tr><td><code>randomize:email</code></td><td class="desc"><code>rand-local@rand-domain.test</code> (IETF-reserved TLD).</td></tr>
<tr><td><code>randomize:us-phone</code></td><td class="desc">NANP-valid <code>XXX-XXX-XXXX</code>.</td></tr>
<tr><td><code>randomize:uuid</code></td><td class="desc">RFC 4122 UUIDv4 (passes strict UUID column validation).</td></tr>
<tr><td><code>randomize:ssn</code></td><td class="desc">US SSN avoiding reserved ranges.</td></tr>
<tr><td><code>randomize:pan[:&lt;brand&gt;]</code></td><td class="desc">Luhn-valid card PAN; optional <code>visa</code> / <code>mastercard</code> / <code>amex</code>.</td></tr>
<tr><td><code>randomize:ca-sin</code></td><td class="desc">Luhn-valid Canadian SIN.</td></tr>
<tr><td><code>randomize:uk-nin</code></td><td class="desc">UK NIN matching the HMRC prefix alphabet.</td></tr>
<tr><td><code>randomize:iban[:&lt;country&gt;]</code></td><td class="desc">IBAN with mod-97 check digits; optional <code>DE</code> / <code>GB</code> / <code>FR</code>.</td></tr>
</tbody>
</table>
<div class="note"><strong>Every <code>randomize:*</code> rule needs a primary key</strong> on the source table — the replay seed is derived from the row's PK. The pipeline refuses loudly at startup if a <code>randomize:*</code> rule targets a heap (no-PK) table; add a PK on the source, or pick a non-random strategy.</div>

<h3>Dictionary strategies</h3>
<p>Dictionary strategies map source values into a named lookup table declared in YAML (<a href="https://github.com/sluicesync/sluice/blob/main/docs/adr/adr-0040-dictionary-strategy-determinism.md">ADR-0040</a>):</p>
<table>
<thead><tr><th>Strategy</th><th>Keyed by</th><th>Use case</th></tr></thead>
<tbody>
<tr><td><code>randomize:dict:&lt;name&gt;</code></td><td class="desc">Source PK (replay-stable)</td><td class="desc">Per-row random pick with controlled cardinality.</td></tr>
<tr><td><code>tokenize:dict:&lt;name&gt;</code></td><td class="desc">Source value (HMAC)</td><td class="desc">Stable per-value surrogates — the <em>same</em> input value maps to the same dict entry in every table and column.</td></tr>
</tbody>
</table>
<p>The distinction is the point: <code>randomize:dict</code> can send two rows with the same value but different PKs to different entries, whereas <code>tokenize:dict</code> guarantees every occurrence of a value (anywhere) maps to the same surrogate — so analytics joins on the redacted column stay coherent. Dictionaries must be declared in YAML; a CLI reference to an undeclared dict name refuses at parse time.</p>

<h2 id="determinism">Determinism</h2>
<p>Redaction output is deterministic, which is what makes it safe to re-run — CDC resume and backup → restore reproduce identical surrogates on the same data. There are four contracts:</p>
<table>
<thead><tr><th>Semantics</th><th>Strategies</th><th>Guarantee</th></tr></thead>
<tbody>
<tr><td class="desc">Stateless</td><td class="desc"><code>null</code>, <code>static:</code>, <code>truncate:</code>, <code>hash:sha256</code>, all <code>mask:*</code></td><td class="desc">Same input → same output on any sluice run, anywhere.</td></tr>
<tr><td class="desc">Keyed</td><td class="desc"><code>hash:hmac-sha256</code></td><td class="desc">Same input + same keyset key → same output.</td></tr>
<tr><td class="desc">PK-keyed replay-stable</td><td class="desc"><code>randomize:*</code> (incl. <code>randomize:dict</code>)</td><td class="desc">Same source row (table + column + PK) → same output across re-runs.</td></tr>
<tr><td class="desc">Input-keyed cross-stream</td><td class="desc"><code>tokenize:dict</code></td><td class="desc">Same input value + same key → same output across tables, columns, and streams.</td></tr>
</tbody>
</table>
<p>To correlate a redacted column <em>across</em> tables (a join key), use <code>tokenize:dict</code> or <code>hash:hmac-sha256</code>; the other strategies don't carry cross-table consistency on the same source value.</p>

<h2 id="keyset">The operator keyset (--keyset-source)</h2>
<p>The two keyed strategies — <code>hash:hmac-sha256</code> and <code>tokenize:dict</code> — resolve their HMAC secret from an operator-controlled <strong>keyset</strong> (<a href="https://github.com/sluicesync/sluice/blob/main/docs/adr/adr-0041-operator-keyset-persistence.md">ADR-0041</a>). Any rule using either strategy <strong>requires</strong> <code>--keyset-source</code>; sluice refuses loudly at preflight otherwise. The keyset is a small YAML document holding one or more named keys, each with generations so old surrogates keep resolving after a rotation. It resolves from three sources:</p>
${pre(`# keyset YAML on disk
--keyset-source=file:/etc/sluice/keyset.yaml

# keyset YAML in an env var (container / secret-manager friendly)
--keyset-source=env:SLUICE_KEYSET

# sluice-managed sluice_keysets table on a DSN — shared across streams
--keyset-source=db:postgres://user:pw@host:5432/keysetdb`)}
<p>A rule names which key it uses via the trailing <code>:&lt;keyname&gt;</code> segment (or a YAML <code>key:</code> field); omit it to use the keyset's declared default or its sole entry. Two rules that name the same key produce cross-consistent surrogates:</p>
${pre(`--redact users.email=hash:hmac-sha256:customer_pii
--redact users.first_name=tokenize:dict:first_names:customer_pii`)}
<p>The <code>db:</code> form is the cross-stream stability primitive: two streams pointing at the same keyset DSN turn <code>alice@example.com</code> into the <em>same</em> surrogate on staging-1 and staging-2. For two independent installs to agree (cross-org exchange), install the same <code>file:</code> keyset at both ends.</p>
<div class="note"><strong>No hot-reload.</strong> The keyset is snapshotted once at process startup; a rotation takes effect only on the next restart. After a rotation, new rows get surrogates under the new active generation while existing target rows keep theirs — a clean rotation means re-running the migration under the new key. The security model is <em>stable hashing, not secrecy</em>: protect the key bytes with your storage layer — sluice does not encrypt them at rest.</div>

<h2 id="schema-preview">Preview redaction before you run</h2>
<p><code>sluice schema preview</code> annotates the generated DDL so you can eyeball which columns are covered before moving a single row. The annotation is comment-only — the <code>CREATE TABLE</code> itself is unchanged, so the output stays drop-in usable:</p>
${pre(`sluice schema preview \\
    --source-driver postgres --source "$SRC" \\
    --target-driver postgres --target "$DST" \\
    --redact users.email=hash:sha256 \\
    --redact users.ssn=mask:ssn`)}
${pre(`CREATE TABLE users (
  id    SERIAL PRIMARY KEY,
  email TEXT NOT NULL,    -- REDACTED via hash:sha256
  ssn   TEXT,             -- REDACTED via mask:ssn
  ...
);`)}

<h2 id="audit-log">The audit log</h2>
<p>Every command that moves rows emits exactly one INFO line at startup recording the configured redaction surface — the scope, the column count, and the distinct strategy names:</p>
${pre(`sluice: redaction configured scope=migrate columns=5 strategies=[hash:sha256 mask:pan randomize:email tokenize:dict:first_names truncate:4]`)}
<p>Per-column rules are deliberately <strong>not</strong> logged — the mapping itself is sensitive (<code>--redact billing.credit_card=truncate:4</code> reveals which column holds card numbers), and per-row surrogates are never logged. When a keyset loads, a second line records its source scheme and per-key generations, with any DSN credentials redacted.</p>

<h2 id="examples">Worked examples</h2>
<h3>Mask and hash for an analytics copy</h3>
${pre(`sluice migrate \\
    --source-driver postgres --source "$SRC" \\
    --target-driver postgres --target "$DST" \\
    --redact users.email=hash:sha256 \\
    --redact users.phone=mask:inner:3,4 \\
    --redact users.ssn=randomize:ssn`)}

<h3>Realistic synthetic data for a live staging sync</h3>
<p>Redaction is honoured on the CDC stream too, so staging stays continuously fresh <em>and</em> continuously scrubbed. YAML config plus a stream id:</p>
${pre(`# sluice.yaml
redactions:
  - table: users.email
    strategy: randomize
    form: email
  - table: users.phone
    strategy: randomize
    form: us-phone
  - table: customers.pan
    strategy: randomize
    form: pan
    brand: visa`)}
${pre(`sluice sync start -c sluice.yaml \\
    --source-driver postgres --source "$SRC" \\
    --target-driver postgres --target "$DST" \\
    --stream-id staging-refresh`)}

<h3>Cross-table stable surrogates for a vendor handoff</h3>
<p>Use <code>tokenize:dict</code> with one shared key so a customer's name is the same token in every table — the vendor can still join, but never sees the real value:</p>
${pre(`# sluice.yaml
dictionaries:
  first_names:
    entries: [Alpha, Bravo, Charlie, Delta, Echo, Foxtrot]

redactions:
  - table: users.first_name
    strategy: tokenize
    dict: first_names
    key: customer_pii
  - table: orders.customer_first_name
    strategy: tokenize
    dict: first_names
    key: customer_pii`)}
${pre(`sluice migrate -c sluice.yaml \\
    --source-driver postgres --source "$SRC" \\
    --target-driver postgres --target "$DST" \\
    --keyset-source=file:/etc/sluice/keyset.yaml`)}

<h2 id="non-goals">What redaction is not</h2>
<ul>
  <li><strong>Not a PII discovery scanner.</strong> sluice redacts the columns <em>you</em> name; it does not crawl the schema to find which columns hold personal data. Identifying them is your (or your compliance team's) job.</li>
  <li><strong>Not encryption at rest.</strong> Redaction transforms values in flight so the sensitive original never reaches the target or the backup. Protecting the keyset secret and the target storage itself is your storage layer's responsibility — sluice does not encrypt the key bytes at rest.</li>
</ul>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/configuration/">Configuration</a> — the YAML <code>redactions:</code>, <code>dictionaries:</code>, and keyset blocks in full.</li>
  <li><a href="/docs/commands/">Command reference</a> — the flag set for <code>migrate</code>, <code>sync</code>, <code>backup</code>, and <code>schema preview</code>.</li>
  <li><a href="/docs/getting-started/">Getting started</a> — install sluice and run your first migration and sync.</li>
</ul>
`,
    prev: { href: "/docs/schema-changes/", label: "Schema changes during a sync" },
    next: { href: "/docs/import-sqlite-d1/", label: "Import SQLite or Cloudflare D1" },
  })
);

// nav-label: Prepare a Postgres source
write(
  "postgres-source-prep",
  page({
    slug: "postgres-source-prep",
    title: "Prepare a Postgres source",
    subtitle: "What a Postgres source needs before it can feed a continuous sync — the required GUCs, the REPLICATION role attribute, replication-slot lifecycle, and the slot-less path for managed Postgres.",
    body: `
<p>A one-shot <a href="/docs/commands/#migrate">migrate</a> from Postgres needs only <code>SELECT</code> and works anywhere, including locked-down managed tiers. <strong>Continuous sync</strong> is different: sluice's default Postgres CDC engine reads changes through a logical replication slot, which needs a handful of cluster settings and a role privilege. This guide is the practical checklist — set these before <code>sync start</code>, and if your host forbids them, jump to the <a href="#slotless">slot-less trigger path</a> at the end.</p>

<h2 id="required-gucs">Required GUCs</h2>
<p>Logical replication is gated by a small set of server parameters. Check them as a superuser on the source:</p>
${pre(`SHOW wal_level;                  -- must be 'logical'
SHOW max_replication_slots;      -- >= 2 x replicas
SHOW max_wal_senders;            -- >= 2 x replicas, and >= max_replication_slots
SHOW max_slot_wal_keep_size;     -- '> 4GB' recommended; '-1' = unlimited (risky)`)}
<ul>
  <li><code>wal_level = logical</code> — required. Changing it needs a <strong>cluster restart</strong>; it cannot be set live.</li>
  <li><code>max_replication_slots</code> and <code>max_wal_senders</code> — sized for your replica count; both need a restart to change.</li>
  <li><code>max_slot_wal_keep_size</code> — strongly recommended <code>&gt; 4GB</code> (live-reloadable). The default <code>-1</code> means "retain WAL until the disk fills," which is its own bad day; a bounded cap lets a slot recover from a short consumer outage without one stuck slot filling the disk.</li>
  <li>For PG 17+ HA, also enable <code>sync_replication_slots = on</code> and <code>hot_standby_feedback = on</code> — see <a href="#failover">slot survival under failover</a>.</li>
</ul>
<p>If <code>wal_level</code> is not <code>logical</code>, sluice's CDC reader fails the precondition check at startup — before it touches any slot — with a clear message rather than a mid-stream surprise:</p>
${pre(`postgres: cdc: wal_level is "replica"; must be 'logical' for logical replication
(set wal_level=logical in postgresql.conf and restart)`)}
<div class="note"><strong>Logical WAL costs more.</strong> Flipping <code>wal_level</code> from <code>replica</code> to <code>logical</code> raises the WAL byte-rate — roughly 1.2x–1.6x on a typical OLTP workload, more on wide <code>TEXT</code>/<code>JSONB</code> rows under <code>REPLICA IDENTITY FULL</code>. That multiplier also applies to WAL a lagging slot retains, so budget <code>max_slot_wal_keep_size</code> (and your backup/replica bandwidth) accordingly. Measure your own workload at <code>logical</code> before depending on it in production.</div>

<h2 id="replication-role">The REPLICATION role attribute</h2>
<p>The role sluice connects as must be a superuser <strong>or</strong> carry the <code>REPLICATION</code> attribute — creating a logical slot requires it:</p>
${pre(`ALTER ROLE sluice_user WITH REPLICATION;`)}
<p>sluice does <strong>not</strong> silently degrade to polling when this is missing. A preflight probe (reading the world-readable <code>pg_roles.rolsuper OR rolreplication</code>) runs <em>before</em> the CDC reader opens, and refuses loudly — naming the role and every recovery path — rather than letting slot creation fail opaquely mid-cold-start with a raw <code>ERROR: permission denied to create replication slot</code> (SQLSTATE 42501):</p>
${pre(`the source connecting role "app_user" is not a superuser and lacks the
REPLICATION attribute. Slot-based Postgres CDC (--source-driver=postgres) creates
a logical replication slot at cold start ... Recovery: (a) grant the attribute:
ALTER ROLE app_user REPLICATION; (b) re-run with a superuser or replication-enabled
role; (c) on managed Postgres that forbids the REPLICATION attribute (Heroku
Postgres Essential, Render Basic, Supabase free), use --source-driver=postgres-trigger`)}
<p>There is deliberately no <code>--allow-missing-replication</code> escape hatch: the role genuinely cannot create a slot, so the honest choices are to grant the attribute, swap roles, or use the <a href="#slotless">slot-less engine</a>. This refusal fires only on the slot-based CDC path — a pure bulk <code>migrate</code> is unaffected.</p>

<h2 id="slot-name">The replication slot</h2>
<p>sluice creates one logical slot per stream, named <code>sluice_slot</code> by default. Override it with <code>--slot-name</code>; sluice prepends <code>sluice_</code> if your value doesn't already start with it (so <code>--slot-name shard_a</code> creates <code>sluice_shard_a</code>). The convention lets you find every sluice-owned slot with <code>WHERE slot_name LIKE 'sluice\\_%'</code>. Give concurrent sluice instances against the same source distinct slot names — without them they collide on the default.</p>
<p>List and drop slots from the CLI without dropping to psql:</p>
${pre(`# List every slot on the source (columns mirror pg_replication_slots)
sluice slot list --source-driver postgres --source 'postgres://user:pass@host:5432/app'

# Drop a named slot (prompts for confirmation; --yes skips it,
# --force drops an active slot, --if-exists treats a missing slot as success)
sluice slot drop sluice_slot --source-driver postgres --source 'postgres://user:pass@host:5432/app'`)}
<p>When you start a stream and setup fails partway (publication permissions, <code>START_REPLICATION</code> rejection, cancellation), the freshly-created slot is auto-dropped before the error returns — so failed cold-start attempts don't leave <code>sluice_slot</code>-named slots behind. Auto-cleanup deliberately skips a slot that pre-existed the call (it may carry someone else's progress) and a slot whose pump already emitted positioned changes (that's user data); for those, <code>sluice slot drop</code> is the explicit path.</p>

<h2 id="failover">Slot survival under failover</h2>
<p>This is the part that bites people. <strong>A logical slot is a primary-local object by default</strong> — when the primary fails over, the slot does not move to the new primary, and a slot left behind is <strong>silently</strong> lost: no error, no warning, your CDC stream just begins missing changes. Confirm one slot-preservation mechanism is actually configured before betting production on it:</p>
<ul>
  <li><strong>PlanetScale Postgres (Patroni):</strong> add the slot name to the <em>"Logical slot name"</em> field under <em>Cluster configuration &rarr; Parameters &rarr; Failover</em> (comma-delimited for multiple consumers). Slots not listed there are lost on failover.</li>
  <li><strong>Self-hosted Patroni:</strong> declare it under <code>slots:</code> as a permanent logical slot (type <code>logical</code>, plugin <code>pgoutput</code>).</li>
  <li><strong>PG 17+ native sync:</strong> <code>sync_replication_slots = on</code> plus <code>hot_standby_feedback = on</code>.</li>
  <li><strong>Vanilla Postgres without HA:</strong> nothing to do — there's no failover — but still monitor <a href="#slot-health">slot health</a>.</li>
</ul>
<div class="note"><strong>The idle-slot trap.</strong> Even with all three mechanisms configured, a slot that hasn't <em>advanced</em> during the slot-sync window can still be lost on failover: the standby's copy stays at an old LSN, and promotion leaves it pointing at recycled WAL (<code>wal_status='lost'</code> on resume). The durable fix is to keep the slot advancing — run <code>sync start</code> continuously (its CDC reader sends a standby-status keepalive every 10s), and on quiet sources inject lightweight WAL. sluice has this built in.</div>

<h3 id="heartbeat">Keeping an idle slot alive</h3>
<p>Set <code>--source-heartbeat-interval</code> and sluice INSERTs a row into a source-owned table (default <code>sluice_heartbeat</code>) on each interval; the write generates WAL, advancing the consumer position against an idle source and preventing slot eviction (ADR-0061 / F17):</p>
${pre(`sluice sync start \\
    --source-driver postgres --source 'postgres://user:pass@host:5432/app' \\
    --target-driver mysql    --target 'user:pass@tcp(host:3306)/app' \\
    --stream-id app \\
    --source-heartbeat-interval 30s`)}
<p>It is <strong>opt-in</strong> (<code>0</code>, off, by default) because the INSERT is a behaviour change on the source that regulated systems must enable explicitly. The heartbeat table is auto-created and periodically pruned (<code>--source-heartbeat-prune-window</code>, default <code>1h</code>); on a role without <code>CREATE TABLE</code> the streamer WARNs once and continues without it. Rename the table with <code>--source-heartbeat-table-name</code>, or silence the warning with <code>--no-source-heartbeat</code>.</p>

<h2 id="slot-health">Slot health and telemetry</h2>
<p>A logical slot moves through these states, visible in <code>pg_replication_slots.wal_status</code>:</p>
<table>
<thead><tr><th>wal_status</th><th>Meaning</th></tr></thead>
<tbody>
<tr><td><code>reserved</code></td><td class="desc">Healthy — all required WAL is on disk.</td></tr>
<tr><td><code>extended</code></td><td class="desc">Healthy but the consumer is behind; the slot holds more WAL than <code>max_wal_size</code>.</td></tr>
<tr><td><code>unreserved</code></td><td class="desc">Required WAL has left <code>pg_wal</code> but is still recoverable.</td></tr>
<tr><td><code>lost</code></td><td class="desc">Required WAL is gone. The slot exists but cannot be used — silent-loss-class for CDC.</td></tr>
</tbody>
</table>
<p>When sluice sees a slot in <code>unreserved</code> or <code>lost</code> state it refuses to start replication and points at the recovery path — <code>sluice slot drop</code> on the source, then restart with an empty position to force a fresh snapshot, and raise <code>max_slot_wal_keep_size</code> to prevent recurrence. After dropping the slot, get past the cold-start refusal on the (partially-streamed) target with <code>sync start --reset-target-data --yes</code> (clears sluice's state and drops the source-schema tables it manages, then re-snapshots; see <a href="https://github.com/sluicesync/sluice/blob/main/docs/adr/adr-0023-reset-target-data.md">ADR-0023</a>).</p>
<p>For proactive monitoring, sluice surfaces PG 14+ per-slot decode-spill counters (large transactions spilling the ReorderBuffer to disk — sustained spill is what can fill <code>pg_replslot/</code> and invalidate a slot) in two places:</p>
${pre(`# sync health prints them when the source is PG 14+ and the slot has decoded
sluice sync health --source-driver postgres --source ... \\
    --target-driver postgres --target ... --stream-id app
  ...
  spill_txns: 17
  spill_bytes: 5242880

# Prometheus /metrics (when --metrics-listen is set on sync start)
sluice_pg_slot_spill_txns_total{stream_id="app",slot="sluice_slot"} 17
sluice_pg_slot_spill_bytes_total{stream_id="app",slot="sluice_slot"} 5242880`)}
<p>Both counters are cumulative since slot creation, so alert on the <em>rate</em> (<code>rate(sluice_pg_slot_spill_bytes_total[5m])</code>). sluice deliberately omits the lines — rather than printing <code>0</code> — when it can't tell (PG &lt; 14, the slot hasn't decoded yet, or a non-Postgres source), so "no signal" is never mistaken for "no spill." If they climb, raise <code>logical_decoding_work_mem</code> on the source (live-reloadable) and split oversized application transactions.</p>

<h2 id="slotless">Managed / locked-down Postgres: the slot-less trigger engine</h2>
<p>When the host forbids logical replication — Heroku Postgres, RDS without the right grants, Supabase / Crunchy starter tiers — you cannot get a replication slot at all. sluice's answer is the <code>postgres-trigger</code> engine: per-table plpgsql triggers write every change into a capture table (<code>sluice_change_log</code>) and the engine tails it — Bucardo-style CDC with no slot and no <code>REPLICATION</code> attribute (<a href="https://github.com/sluicesync/sluice/blob/main/docs/adr/adr-0066-postgres-trigger-cdc.md">ADR-0066</a>). The lifecycle is explicit — <strong>setup &rarr; run &rarr; teardown</strong> — so the source-side DDL is visible at the CLI, never silently applied on first sync.</p>
<p><strong>1. Install the capture triggers.</strong> <code>--tables</code> is required. On a tier that also denies event-trigger creation (needed for automatic DDL detection), add <code>--allow-polled-fingerprint</code> to opt into the weaker polled schema-fingerprint fallback — the command refuses loudly without it so you acknowledge the trade-off:</p>
${pre(`sluice trigger setup \\
    --source-driver postgres-trigger \\
    --dsn 'postgres://user:pass@host:5432/app' \\
    --tables orders,customers,line_items \\
    --allow-polled-fingerprint`)}
<p><strong>2. Stream with the trigger engine.</strong> The source driver is <code>postgres-trigger</code>; everything else is an ordinary <a href="/docs/commands/#sync-start">sync start</a>:</p>
${pre(`sluice sync start \\
    --source-driver postgres-trigger --source 'postgres://user:pass@host:5432/app' \\
    --target-driver postgres         --target 'postgres://user:pass@target:5432/app?sslmode=require' \\
    --stream-id app`)}
<p><strong>3. Tear down cleanly</strong> when the stream is finished — this drops every per-table trigger and (by default) the <code>sluice_change_log</code> table, leaving zero residue. Pass <code>--keep-data</code> to retain the change-log for forensics, or <code>--yes</code> to skip the confirmation prompt:</p>
${pre(`sluice trigger teardown \\
    --source-driver postgres-trigger \\
    --dsn 'postgres://user:pass@host:5432/app' --yes`)}
<p>The connecting role needs <code>CREATE</code> on the target schema, <code>TRIGGER</code> on each replicated table, and <code>INSERT</code> on <code>sluice_change_log</code> — a much smaller ask than <code>REPLICATION</code>. Tune how much of each row the capture writes with <code>--capture-payload</code> (<code>full</code> / <code>changed</code> / <code>minimal</code>), and reap durably-applied change-log rows while the sync runs with <code>sluice trigger prune</code>. The full command surface is in the <a href="/docs/commands/#trigger">trigger reference</a>, and the trigger-CDC walkthrough lives in <a href="/docs/getting-started/#trigger-cdc">Getting started</a>.</p>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/commands/#sync-start">sync start</a> — every flag for the continuous-sync command, including <code>--metrics-listen</code> and the notify thresholds.</li>
  <li><a href="/docs/commands/#trigger">trigger setup / teardown</a> — the slot-less engine's full reference.</li>
  <li><a href="/docs/getting-started/#trigger-cdc">Getting started: trigger-based CDC</a> — a worked slot-less walkthrough.</li>
</ul>
`,
    prev: { href: "/docs/foreign-keys-vitess/", label: "Foreign keys on a Vitess target" },
    next: { href: "/docs/managed-postgres-slotless/", label: "Managed Postgres (slot-less)" },
  })
);

// nav-label: Managed Postgres (slot-less)
write(
  "managed-postgres-slotless",
  page({
    slug: "managed-postgres-slotless",
    title: "Sync from managed Postgres without a replication slot",
    subtitle: "Heroku Postgres, RDS without grants, Supabase / Crunchy starter tiers — managed Postgres that forbids logical replication still streams via sluice's trigger-based postgres-trigger engine. No slot, no REPLICATION attribute.",
    body: `
<p>sluice's default Postgres CDC engine reads the write-ahead log through a <a href="/docs/postgres-source-prep/#slot-name">logical replication slot</a> — which needs the connecting role to be a superuser or carry the <code>REPLICATION</code> attribute. Plenty of managed tiers forbid exactly that. For those, sluice ships a deliberate slot-less path: the <code>postgres-trigger</code> engine captures changes with per-table triggers instead of a slot. This guide covers when you need it, the explicit <strong>setup &rarr; run &rarr; teardown</strong> lifecycle, and the flagship <a href="#heroku">Heroku Postgres &rarr; PlanetScale</a> move.</p>

<h2 id="when">When you need slot-less CDC</h2>
<p>A one-shot <a href="/docs/commands/#migrate">migrate</a> from Postgres needs only <code>SELECT</code> and runs anywhere, including the most locked-down tiers. <strong>Continuous sync</strong> is where the slot requirement bites: creating a logical replication slot requires the <code>REPLICATION</code> role attribute, and these managed tiers don't grant it:</p>
<ul>
  <li><strong>Heroku Postgres</strong> — no <code>rolreplication</code>, no <code>CREATE_REPLICATION_SLOT</code>, no event-trigger creation. The canonical case.</li>
  <li><strong>AWS RDS without the right grants</strong> — logical replication is off unless the parameter group and role grants are set up for it.</li>
  <li><strong>Supabase / Crunchy Bridge starter tiers</strong> — the starter roles don't carry the attribute.</li>
  <li><strong>PlanetScale Postgres custom <code>pscale_api_*</code> roles</strong> — these API roles lack <code>REPLICATION</code>; slot-based CDC into PS-PG needs the Default <code>postgres</code> role. (Full detail in the <a href="/docs/planetscale-postgres/">PlanetScale Postgres guide</a>.)</li>
</ul>
<p>sluice does <strong>not</strong> silently degrade to polling when the slot path is unavailable. The slot-based reader runs a preflight probe <em>before</em> it opens — reading the world-readable <code>pg_roles.rolsuper OR rolreplication</code> — and refuses loudly, naming the role and pointing straight at this engine, rather than letting slot creation fail opaquely mid-cold-start with a raw <code>ERROR: permission denied to create replication slot</code>:</p>
${pre(`the source connecting role "app_user" is not a superuser and lacks the
REPLICATION attribute. Slot-based Postgres CDC (--source-driver=postgres) creates
a logical replication slot at cold start ... Recovery: (a) grant the attribute:
ALTER ROLE app_user REPLICATION; (b) re-run with a superuser or replication-enabled
role; (c) on managed Postgres that forbids the REPLICATION attribute (Heroku
Postgres Essential, Render Basic, Supabase free), use --source-driver=postgres-trigger`)}
<p>There is deliberately no <code>--allow-missing-replication</code> escape hatch: the role genuinely cannot create a slot, so the honest choices are to grant the attribute, swap roles, or take this slot-less path. The <code>postgres-trigger</code> engine installs per-table plpgsql <code>AFTER</code> triggers that write every change into a capture table (<code>sluice_change_log</code>); the engine tails that log — Bucardo-style CDC with no slot and no <code>REPLICATION</code> attribute (<a href="https://github.com/sluicesync/sluice/blob/main/docs/adr/adr-0066-postgres-trigger-engine-variant.md">ADR-0066</a>). The lifecycle is explicit, so the source-side DDL is visible at the CLI, never silently applied on first sync.</p>

<h2 id="setup">1. Install the capture triggers</h2>
<p><code>sluice trigger setup</code> installs the change-log table, the capture function, and the per-table triggers. <code>--tables</code> is required — name every table you want captured:</p>
${pre(`sluice trigger setup \\
    --source-driver postgres-trigger \\
    --dsn 'postgres://user:pass@host:5432/app' \\
    --tables orders,customers,line_items \\
    --allow-polled-fingerprint`)}
<p>On a tier that <em>also</em> denies event-trigger creation (Heroku is one) automatic DDL detection can't use an event trigger, so add <code>--allow-polled-fingerprint</code> to opt into the weaker polled schema-fingerprint fallback. The command refuses loudly without it, so you explicitly acknowledge the trade-off rather than silently getting the degraded DDL-detection mode. The connecting role needs <code>CREATE</code> on the target schema, <code>TRIGGER</code> on each replicated table, and <code>INSERT</code> on <code>sluice_change_log</code> — a much smaller ask than <code>REPLICATION</code>. Preview the exact DDL without touching the source with <code>--dry-run</code>; the full set of objects it installs is listed under <a href="/docs/database-objects/#trigger-source">Objects sluice creates</a>.</p>
<div class="note">Tune how much of each changed row the capture writes with <code>--capture-payload</code> (<code>full</code>, the default, keeps the full before- and after-image; <code>changed</code> trims the after-image to PK + changed columns; <code>minimal</code> reduces the apply to a last-write-wins PK match — safe for one-way CDC with no concurrent target writers, and it reaches toward roughly 2× source-write overhead instead of more).</div>

<h2 id="run">2. Stream with the trigger engine</h2>
<p>The source driver is <code>postgres-trigger</code>; everything else is an ordinary <a href="/docs/commands/#sync-start">sync start</a> — cold-copy first, then CDC tailed off the trigger log, with the same value fidelity, warm-resume, and encryption as any sluice sync:</p>
${pre(`sluice sync start \\
    --source-driver postgres-trigger --source 'postgres://user:pass@host:5432/app' \\
    --target-driver postgres         --target 'postgres://user:pass@target:5432/app?sslmode=require' \\
    --stream-id app`)}
<div class="note"><strong>Cross-engine directions.</strong> A <code>postgres-trigger</code> source can stream to a <strong>Postgres</strong> target <em>and</em> to a <strong>MySQL</strong> / PlanetScale-MySQL target — PG&nbsp;↔&nbsp;MySQL is sluice's supported cross-engine direction, and the trigger engine counts as a Postgres source for that purpose. Set <code>--target-driver mysql</code> (or <code>planetscale</code>) and the target DSN accordingly. The same PG-native shapes that have no clean MySQL form — PostGIS geometry, <code>pg_trgm</code> operator-class indexes, <code>EXCLUDE</code> constraints — refuse loudly before any data moves, exactly as they do for the vanilla <code>postgres</code> source.</div>
<p>The source change-log grows for the life of a continuous sync; reap durably-applied rows while the sync runs with <code>sluice trigger prune</code> (it reads the target's durably-applied frontier as the only safe lower bound and refuses to prune blind). See the <a href="/docs/commands/#trigger">trigger reference</a> for its flags.</p>

<h2 id="teardown">3. Tear down cleanly</h2>
<p>When the stream is finished, <code>sluice trigger teardown</code> drops every per-table trigger and (by default) the <code>sluice_change_log</code> table, leaving zero residue on the source:</p>
${pre(`sluice trigger teardown \\
    --source-driver postgres-trigger \\
    --dsn 'postgres://user:pass@host:5432/app' --yes`)}
<p><code>--yes</code> skips the destructive-action confirmation prompt (for scripted/CI use). Pass <code>--keep-data</code> to retain the change-log table for forensics instead of dropping it. Teardown is idempotent — re-running against a partially-uninstalled source proceeds cleanly via <code>DROP ... IF EXISTS</code>.</p>

<h2 id="heroku">Heroku Postgres → PlanetScale</h2>
<p>Heroku Postgres forbids replication slots outright, so it's the canonical <code>postgres-trigger</code> scenario. The three commands above work standalone against a Heroku source — read the <code>DATABASE_URL</code> fresh at each invocation (Heroku rotates it under failover) and append <code>?sslmode=require</code> (Heroku rejects non-TLS connections):</p>
${pre(`sluice trigger setup \\
    --source-driver postgres-trigger \\
    --dsn "$(heroku config:get DATABASE_URL --app myapp)?sslmode=require" \\
    --tables users,orders,items \\
    --allow-polled-fingerprint

sluice sync start \\
    --source-driver postgres-trigger \\
    --source "$(heroku config:get DATABASE_URL --app myapp)?sslmode=require" \\
    --target-driver postgres \\
    --target 'postgres://...your-target...?sslmode=require' \\
    --stream-id heroku-myapp`)}
<p>For a hands-off, dashboard-driven move there's a packaged wrapper: <strong><a href="https://github.com/sluicesync/sluice-heroku-migrator">sluice-heroku-migrator</a></strong> — a fork of PlanetScale's <code>heroku-migrator</code> with the replication engine swapped from <strong>Bucardo</strong> to sluice's <code>postgres-trigger</code> engine. Because sluice is a lightweight Go binary rather than an embedded PostgreSQL daemon, it deploys on a Standard-1x/2x dyno regardless of database size. It packages the same setup &rarr; sync &rarr; cutover flow this guide runs by hand — with TCP keepalives tuned for cloud NAT and psql-based status/cutover — behind a four-phase dashboard (Setup, Data Sync, Traffic Switch, Complete). You deploy it as a Heroku container app, set the <code>HEROKU_URL</code>, <code>PLANETSCALE_URL</code>, and <code>PASSWORD</code> config vars, and drive the phases from its dashboard. Prerequisites it enforces: every table has a primary key, the required extensions exist on the PlanetScale side, schema migrations are paused during the move, and the target has 1.5–2× the Heroku data size provisioned. The wrapper only automates the manual flow above — nothing it does isn't reproducible with the three sluice commands directly.</p>
<div class="note">The <code>--tables</code>-first, explicit-lifecycle shape is what makes the trigger engine safe to run on someone else's managed database: nothing is installed on the source until you name it, and teardown removes every trace. This is a deliberate operability contrast with trigger tools that install capture state implicitly and leave residue behind.</div>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/postgres-source-prep/">Prepare a Postgres source</a> — the slot-based path's required GUCs, the <code>REPLICATION</code> attribute, and slot lifecycle (the engine this guide is the alternative to).</li>
  <li><a href="/docs/getting-started/#trigger-cdc">Getting started: trigger-based CDC</a> — a worked slot-less walkthrough.</li>
  <li><a href="/docs/commands/#trigger">trigger setup / teardown / prune</a> — the slot-less engine's full command reference.</li>
  <li><a href="/docs/verify-reconcile/">Verify &amp; reconcile</a> — confirm the target matches the source after the copy, identical to any sluice sync.</li>
</ul>
`,
    prev: { href: "/docs/postgres-source-prep/", label: "Prepare a Postgres source" },
    next: { href: "/docs/planetscale-vitess/", label: "PlanetScale & Vitess" },
  })
);

// nav-label: PlanetScale & Vitess
write(
  "planetscale-vitess",
  page({
    slug: "planetscale-vitess",
    title: "PlanetScale & Vitess",
    subtitle: "Migrate and continuously sync from PlanetScale-MySQL or any Vitess deployment through the VStream gRPC feed.",
    body: `
<p>PlanetScale (and self-hosted Vitess) don't expose MySQL's binary log directly — row changes come through Vitess's <strong>VStream</strong> gRPC API instead. sluice speaks that protocol through a MySQL-engine <em>flavor</em>: the same reader, decoder, and pipeline you use for vanilla MySQL, with a Vitess-shaped CDC transport and a capability set that reflects the platform's constraints. This guide covers selecting the flavor, tuning the cold-start copy, warm-resume across a purged position, and reading the throttler/lag signals that are unique to a Vitess-fronted source.</p>

<h2 id="select">Selecting the flavor</h2>
<p>Two driver names register the VStream-backed flavor; pick by deployment shape:</p>
<table><thead><tr><th>Driver</th><th class="desc">Use for</th></tr></thead><tbody>
<tr><td><code>planetscale</code></td><td class="desc">PlanetScale's hosted MySQL. TLS by default; auth is HTTP Basic where the username/password are your service-token <em>name</em> and <em>value</em>; the default shard convention is <code>-</code>.</td></tr>
<tr><td><code>vitess</code></td><td class="desc">A Vitess cluster you run yourself (etcd + vtctld + vtgate + vttablets). Shares PlanetScale's VStream engine code; point it at your vtgate.</td></tr>
</tbody></table>
${pre(`sluice sync start \\
    --source-driver planetscale --source "$SLUICE_SOURCE" \\
    --target-driver postgres    --target "$SLUICE_TARGET"`)}
<div class="note"><strong>What auto-detection does — and doesn't.</strong> A <code>*.connect.psdb.cloud</code> / <code>*.private-connect.psdb.cloud</code> host is recognised automatically so sluice excludes Vitess's <code>_vt_*</code> shadow tables — <em>even</em> when you connect with the plain <code>mysql</code> driver. Choosing the transport is still explicit, though: the <code>mysql</code> driver against a PlanetScale host gives you binlog CDC, not VStream. Pass <code>--source-driver planetscale</code> to get the VStream feed. Non-PlanetScale Vitess (custom domains) needs a manual <code>--exclude-table='_vt_*'</code>.</div>

<h2 id="preconditions">Source preconditions</h2>
<p>Key constraints inherited from the Vitess platform (sluice already accounts for these — they're context, not steps):</p>
<ul>
  <li>No direct binlog access — CDC goes through VStream gRPC (the flavor declares <code>CDCVStream</code>, which the streamer's capability check accepts).</li>
  <li>No <code>LOAD DATA INFILE</code>; the cold-copy uses batched inserts.</li>
  <li>Sharded keyspaces are supported on both the standalone-CDC and snapshot→CDC paths. vtgate fans the COPY phase out per shard, then the same stream tails CDC across all shards.</li>
</ul>
<p>A VStream <strong>source</strong> password needs only read access. If a <strong>PlanetScale branch is the <em>target</em></strong>, the password's role must allow DDL — sluice creates the destination tables plus its control tables (<code>sluice_cdc_state</code>, <code>sluice_cdc_schema_history</code>, …) on cold-start, and a <code>reader</code>/<code>writer</code>/<code>readwriter</code> role is denied DDL on a production branch. Mint the target password with <code>pscale password create &lt;db&gt; &lt;branch&gt; --role admin</code>. If the target branch has Safe Migrations enabled, pre-create the tables and pass <code>--schema-already-applied</code>.</p>

<h2 id="sharding">Sharded keyspaces</h2>
<p>All optional; ride on the standard MySQL DSN as extra <code>?key=value</code> parameters:</p>
<table><thead><tr><th>DSN param</th><th class="desc">Purpose</th></tr></thead><tbody>
<tr><td><code>vstream_shards</code></td><td class="desc">Comma-separated shard list (default <code>-</code>; e.g. <code>vstream_shards=-80,80-</code>). vttestserver dev clusters typically use <code>0</code>.</td></tr>
<tr><td><code>vstream_auto_discover_shards=true</code></td><td class="desc">Discover the layout at Open time via <code>SHOW VITESS_SHARDS LIKE '&lt;keyspace&gt;/%'</code>. Mutually exclusive with <code>vstream_shards</code>; recommended when the layout isn't known statically.</td></tr>
<tr><td><code>vstream_endpoint</code></td><td class="desc">Override the vtgate gRPC endpoint. Default <code>&lt;sql-host&gt;:443</code>, matching PlanetScale's convention.</td></tr>
<tr><td><code>vstream_transport</code></td><td class="desc"><code>tls</code> (default) or <code>plaintext</code> (localhost vttestserver / dev only).</td></tr>
<tr><td><code>vstream_auth</code></td><td class="desc"><code>basic</code> (default) or <code>none</code> (vanilla Vitess with no VStream auth).</td></tr>
</tbody></table>
<p>A mid-stream reshard surfaces as a typed <code>ShardLayoutChangedError</code>; the continuous-sync streamer's outer loop reopens the reader on the new layout automatically.</p>

<h2 id="cold-start">VStream cold-start throughput</h2>
<p>The snapshot copy is bounded differently from a native-MySQL copy because vtgate forces a single cross-region-RTT-bound INSERT connection (it blocks <code>LOAD DATA</code>). Two axes widen it:</p>
<table><thead><tr><th>Flag</th><th class="desc">Axis</th></tr></thead><tbody>
<tr><td><code>--copy-fanout-degree</code></td><td class="desc"><strong>Write</strong> fan-out (ADR-0097, PlanetScale-MySQL <em>target</em>): PK-hash-partition the incoming snapshot row stream out to N concurrent batched-INSERT writers, each on its own connection. <code>0</code> = auto (4); <code>1</code> = serial. Bounded by the target connection budget.</td></tr>
<tr><td><code>--vstream-copy-table-parallelism</code></td><td class="desc"><strong>Read</strong> axis (ADR-0099, Vitess/PlanetScale source): the number of concurrent single-table COPY streams the auto-shard cold-copy runs. <code>0</code> = fall back to the DSN <code>vstream_copy_table_parallelism</code> param, then the engine default (1 = serial). An explicit flag wins over the DSN param.</td></tr>
</tbody></table>
<div class="note">The generic <code>--table-parallelism</code> / <code>--bulk-parallelism</code> cold-start knobs are <strong>inert on a VStream source</strong> (setting one emits a one-time WARN). Use the two flags above instead. <code>--copy-table-parallelism</code> is for self-managed non-Vitess MySQL, not PlanetScale.</div>

<h2 id="warm-resume">Warm-resume &amp; auto-resnapshot</h2>
<p>On restart, sluice resumes from the persisted VGTID position. PlanetScale's binlog-retention window is finite, so a resume from a position older than the source's retained binlogs is routine — and by default (ADR-0093, parity with the self-hosted binlog path) sluice <strong>auto-recovers with a fresh cold-start re-snapshot</strong> rather than failing. On an idempotent VStream source the upsert copy absorbs the overlap and the target is <em>not</em> dropped.</p>
<p>When a full re-snapshot is expensive (very large tables) and you'd rather decide deliberately, pass <code>--no-auto-resnapshot</code>. sluice then fails loudly with an actionable error naming the recovery commands (<code>--restart-from-scratch</code> / <code>--reset-target-data</code>) instead of re-copying. It gates both the pre-flight fall-through and the reactive VStream recovery.</p>

<h2 id="throttler-lag">The throttler &amp; lag reality</h2>
<p>Some VStream delays you act on; some you wait out. The measured findings reset a few intuitions:</p>
<ul>
  <li><strong>The #1 real-world stall is a co-tenant VReplication migration on the same keyspace</strong> (an <code>OnlineDDL</code> on a large table), not your own write rate — its copy moves the <em>shared</em> shard-lag metric that gates every app. A write-heavy primary <em>alone</em> rarely trips the default 5s lag throttler on a healthy cluster.</li>
  <li><strong>Upsizing the cluster or vtgate does not clear a replica-lag throttle.</strong> The lever is source-side: reduce load, and avoid huge single transactions during bulk-copy and cutover.</li>
</ul>
<h3>The mid-stream throttle signature</h3>
<p>When a throttle engages mid-stream, vtgate strips the in-band <code>throttled</code> flag from the events sluice sees, so the symptom is: <strong>heartbeats still flowing, zero change events, and <code>sluice_lag_seconds</code> climbing while <code>sluice_seconds_since_last_event</code> stays low</strong> (&lt; 6s). No gRPC error arrives, so the stream stays connected and catches up when the throttle clears. sluice surfaces the symptom as a rate-limited WARN — <em>"alive (heartbeats flowing) but NO change events for Ns"</em> — once per quiet spell. Out-of-band, check <code>SHOW VITESS_THROTTLED_APPS</code> on the primary. The soft window is tunable per-DSN with <code>vstream_idle_warn_timeout</code> (a Go duration; <code>0</code> disables the WARN only, not the hard liveness guards).</p>
<div class="note"><strong>Corrected finding — a genuinely idle source does NOT fire this WARN on real PlanetScale.</strong> vtgate emits periodic idle VGTIDs that re-arm sluice's soft-idle timer, so the WARN is specific to a <em>throttle</em> or a large-transaction stall — not routine quiet. (Older guidance said an idle source produces the same WARN; on a real PlanetScale endpoint it does not.) If you see the WARN, treat it as a throttle/large-tx signal and check the throttled-apps list.</div>
<p>A tablet failover / planned reparent terminates the stream; the streamer's outer loop reconnects from the persisted position — a single brief <code>seconds_since_last_event</code> spike is almost always transient. See the in-repo <a href="https://github.com/sluicesync/sluice/blob/main/docs/vitess-vstream-troubleshooting.md">VStream troubleshooting runbook</a> for the full cause catalogue.</p>

<h2 id="storage-grow">Storage auto-grow &amp; primary reparent</h2>
<p>A non-Metal PlanetScale instance crossing a storage boundary briefly disrupts in-flight writes while the volume grows and a new primary is promoted. sluice rides these windows automatically — <strong>no flags required</strong> — across cold-copy write, source read, and the post-copy index/constraint phase. You'll see <code>WARN</code> lines naming the transient (Vitess <code>1105 "not serving"</code> / read-only) and the retry; they're expected and self-clearing. A genuine, non-transient failure still surfaces loudly and promptly.</p>

<h2 id="telemetry">Target-health telemetry (optional)</h2>
<p>sluice can consume PlanetScale's <strong>control-plane metrics</strong> (target CPU, memory, storage, replication lag) to back off apply pressure proactively and to fire operator alerts. This reads the PlanetScale metrics API, not the database — it uses a service token that is <strong>distinct from the data-plane <code>--target</code> DSN</strong>. The opt-in is all-or-nothing: an org without a complete token pair is a loud refusal.</p>
${pre(`export PLANETSCALE_METRICS_TOKEN_ID=...   # granted read_metrics_endpoints
export PLANETSCALE_METRICS_TOKEN=...
sluice sync start \\
    --source-driver planetscale --source "$SLUICE_SOURCE" \\
    --target-driver postgres    --target "$SLUICE_TARGET" \\
    --planetscale-org acme \\
    --planetscale-metrics-db app \\
    --notify-storage-util 0.85 --notify-cpu-util 0.90 \\
    --notify-slack "$SLACK_WEBHOOK"`)}
<p>When telemetry is on, sluice's <code>/metrics</code> export gains the <code>sluice_target_*</code> gauge family (CPU/mem/storage/lag), and the live signals clamp the startup apply-lane count and damp the AIMD high-water under pressure. The token id and secret should always come from the environment, never the command line.</p>
<h3>Watching a database without a sync</h3>
<p>To watch a PlanetScale database's health for dashboards or alert-only operation — with no sync attached and no database connection opened — use <a href="/docs/commands/#metrics-watch">metrics-watch</a>. It polls only the control-plane endpoint, fires the same <code>--notify-*</code> alerts, and with <code>--metrics-listen ADDR</code> becomes a standalone PlanetScale-metrics Prometheus exporter:</p>
${pre(`sluice metrics-watch \\
    --engine planetscale --planetscale-org acme --planetscale-metrics-db app \\
    --notify-storage-util 0.85 --notify-slack "$SLACK_WEBHOOK" --quiet`)}
<p>It supports <code>--once</code> (single sample, for scripts) and <code>--interval</code> (default 60s, the PlanetScale metrics granularity).</p>

<h2 id="pspg-target">PlanetScale-Postgres as a target</h2>
<p>PlanetScale-Postgres (PS-PG) is <em>not</em> Vitess-fronted for sluice's purposes — the vanilla <code>postgres</code> engine handles it cleanly, and its endpoints (<code>*.pg.psdb.cloud</code>) don't carry <code>_vt_*</code> shadow tables. One operational note: the tables sluice creates are owned by whichever role connects, and PlanetScale's non-superuser API role (<code>pscale_api_*</code>) will own them if you connect as it. If you want the tables owned by the Default <code>postgres</code> role, connect as that role. For CDC into PS-PG, ensure <code>wal_level=logical</code> and the connecting role has the <code>REPLICATION</code> attribute.</p>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/operate-fleet/">Operate a sync fleet</a> — dashboards, alerting, and lag observability across many streams.</li>
  <li><a href="/docs/commands/#sync-start">sync start reference</a> — every flag named here, with defaults.</li>
  <li><a href="/docs/zero-downtime-cutover/">Zero-downtime migration</a> — the snapshot→CDC cutover flow this guide's flags feed.</li>
</ul>
`,
    prev: { href: "/docs/managed-postgres-slotless/", label: "Managed Postgres (slot-less)" },
    next: { href: "/docs/planetscale-region-move/", label: "Move PlanetScale regions" },
  })
);

// nav-label: Move PlanetScale regions
write(
  "planetscale-region-move",
  page({
    slug: "planetscale-region-move",
    title: "Move a PlanetScale database between regions",
    subtitle: "PlanetScale has no native region move — create the database in the new region and let sluice copy it across, with zero downtime or in one shot.",
    body: `
<p>A PlanetScale database is pinned to its region at creation, and there is <strong>no native, in-place region move</strong>. The path is the same in spirit for every setup — create a <strong>new</strong> database in the <em>target</em> region and let sluice copy the data across (both ends are MySQL→MySQL, so no cross-engine type translation is involved) — but the exact shape depends on how your data is laid out. This guide covers three cases: <a href="#case-single"><strong>Case 1 — a single unsharded database</strong></a> (the common one), <a href="#case-multi"><strong>Case 2 — several unsharded databases</strong></a>, and <a href="#case-sharded"><strong>Case 3 — a sharded keyspace</strong></a>. Read <a href="#notes">Before you start</a> and <a href="#connect">Provision the target</a> first — they apply to all three — then jump to the case that matches your setup.</p>

<h2 id="notes">Before you start &amp; gotchas</h2>
<ul>
  <li><strong>Foreign keys — enable them on the target first.</strong> PlanetScale does not accept <code>FOREIGN KEY</code> DDL by default (Vitess rejects it with <code>VT10001</code>). If your schema uses foreign keys, turn on <strong>"Allow foreign key constraints"</strong> in the <em>target</em> database's <strong>Settings → General</strong> tab <em>before</em> you migrate — with no open deploy requests — so sluice's foreign-key DDL is accepted and the constraints are preserved (<a href="https://planetscale.com/docs/vitess/foreign-key-constraints#how-to-enable-foreign-key-constraints">how to enable them</a>). It is supported on <em>unsharded</em> databases only, cyclic foreign keys with <code>CASCADE</code> are not supported, and deploy requests do not validate the referential integrity of pre-existing rows. If you would rather not carry the foreign keys at all, dropping them also works — sluice emits each column's covering index as a separate statement, so those are kept. For the skip-vs-enable decision in full — including <code>--skip-foreign-keys</code>, which keeps the columns indexed for you — see <a href="/docs/foreign-keys-vitess/">Foreign keys on a Vitess / PlanetScale target</a>.</li>
  <li><strong>Sharding.</strong> A normal unsharded PlanetScale database (the default) needs no special flag on <strong>v0.99.190+</strong>; <code>--allow-cross-shard-merge</code> applies only to a genuinely <em>sharded</em> source keyspace — see the note under <a href="#connect">Provision the target</a>.</li>
  <li><strong>One run per keyspace.</strong> A PlanetScale database is a single keyspace, and each <code>sync start</code> / <code>migrate</code> moves one source keyspace to one target. To move several databases, run one per database (each with its own <code>--stream-id</code> and target) or supervise them with a <a href="/docs/operate-fleet/">sync fleet config</a> — no single run spans multiple source keyspaces.</li>
  <li><strong>The <code>sync stop --wait</code> drain message.</strong> On VStream teardown, <code>sync stop --wait</code> may print a "did not complete drain within …" timeout even though the stream <em>did</em> drain and exit cleanly. Verify the process actually exited rather than treating that message alone as a failure.</li>
  <li><strong>Throughput is target-tier-CPU-bound.</strong> The bulk copy is limited by the target cluster's CPU; scale the tier for a faster copy.</li>
</ul>

<h2 id="connect">Provision the target &amp; connect</h2>
<p>Create the destination database in the new region, sized to match (or exceed) the source. A PS-10 branch takes roughly 7–8 minutes to reach <code>READY</code>:</p>
${pre(`pscale database create app-sa --region aws-sa-east-1 --cluster-size PS-10`)}
<p>Both the source and the target reach PlanetScale through the <strong>same</strong> global connect host, <code>aws.connect.psdb.cloud:3306</code> — PlanetScale routes to the right region by <em>credential</em>, not by hostname. The connection strings are standard go-sql-driver MySQL DSNs, and <code>?tls=true</code> is <strong>required</strong> on both:</p>
${pre(`# source (CDC read) — export as SLUICE_SOURCE
USERNAME:PASSWORD@tcp(aws.connect.psdb.cloud:3306)/app-us?tls=true

# target (write) — export as SLUICE_TARGET
USERNAME:PASSWORD@tcp(aws.connect.psdb.cloud:3306)/app-sa?tls=true`)}
<p><code>USERNAME</code> is the generated <code>username</code> field returned by <code>pscale password create &lt;db&gt; &lt;branch&gt; &lt;label&gt;</code> — <em>not</em> the label you pass on the command line — and <code>PASSWORD</code> is its <code>plain_text</code> value. Prefer environment variables (<code>SLUICE_SOURCE</code> / <code>SLUICE_TARGET</code>) over putting the DSN in argv, so credentials don't land in your shell history or process list.</p>
<div class="note warn"><strong>The target driver is <code>planetscale</code>, not <code>mysql</code>.</strong> The <code>mysql</code> engine cold-copies with <code>LOAD DATA INFILE</code>, which Vitess/PlanetScale blocks; the <code>planetscale</code> engine uses batched inserts and speaks VStream for CDC. Use <code>--source-driver planetscale</code> and <code>--target-driver planetscale</code> on both ends.</div>
<div class="note"><strong>The target password needs <code>--role admin</code>.</strong> sluice creates the data tables plus (for a sync) small control tables, and lesser roles (<code>reader</code>/<code>writer</code>/<code>readwriter</code>) are denied DDL on a production branch. Mint it with <code>pscale password create app-sa main mover --role admin</code>. The source password only needs read access.</div>
<div class="note"><strong>No special flag for a normal database.</strong> On <strong>v0.99.190+</strong>, an ordinary <em>unsharded</em> PlanetScale database — the default, one keyspace per database — syncs and migrates with no extra flags. <code>--allow-cross-shard-merge</code> is only for a genuinely <em>sharded</em> source keyspace, where it opts out of the guard that stops rows from different shards colliding on a shared key (prefer <code>--inject-shard-column</code> when the key isn't globally unique across shards). On sluice ≤ v0.99.189 an unsharded database needed <code>--allow-cross-shard-merge</code> as a workaround for a shard-detection bug fixed in v0.99.190 — upgrade and drop it.</div>

<h2 id="case-single">Case 1 — a single unsharded database</h2>
<p>The overwhelming majority of PlanetScale databases are a single unsharded keyspace — this is the straightforward case. Pick a <strong>zero-downtime continuous sync + cutover</strong> (recommended) or a <strong>one-shot migrate</strong>; both are MySQL→MySQL. Datasets that need this are typically well under 10&nbsp;GB.</p>

<h3 id="zero-downtime">Option A — zero-downtime (recommended)</h3>
<p>A continuous sync snapshots and bulk-copies the source, then streams live CDC — so the source stays <strong>writable the whole time</strong> and you flip traffic in a brief, controlled window. Start with a dry-run to review the plan, then launch the long-lived stream:</p>
${pre(`# review the plan first
sluice sync start --stream-id region-move \\
    --source-driver planetscale --source "$SLUICE_SOURCE" \\
    --target-driver planetscale --target "$SLUICE_TARGET" \\
    --dry-run --format json

# launch the long-lived stream (snapshot -> bulk copy -> live CDC)
sluice sync start --stream-id region-move \\
    --source-driver planetscale --source "$SLUICE_SOURCE" \\
    --target-driver planetscale --target "$SLUICE_TARGET" \\
    --apply-batch-size 50`)}
<p>Watch it catch up from another shell, and gate cutover on freshness:</p>
${pre(`sluice sync status --stream-id region-move \\
    --target-driver planetscale --target "$SLUICE_TARGET"

sluice sync health --stream-id region-move \\
    --target-driver planetscale --target "$SLUICE_TARGET" --max-stale-seconds 30`)}
<p>At ~1.2&nbsp;GB the cold-start-to-tailing transition took about <strong>5 minutes</strong> in testing (bulk copy ~4&nbsp;MB/s, PS-10 CPU-bound — a larger cluster tier is the throughput lever). Once the stream is tailing, cut over: <code>cutover</code> primes the target's <code>AUTO_INCREMENT</code> past the source's, with a safety margin, so the application can start writing to the target without primary-key collisions. Then stop the stream and verify:</p>
${pre(`sluice cutover \\
    --source-driver planetscale --source "$SLUICE_SOURCE" \\
    --target-driver planetscale --target "$SLUICE_TARGET"

sluice sync stop --stream-id region-move \\
    --target-driver planetscale --target "$SLUICE_TARGET" --wait

sluice verify \\
    --source-driver planetscale --source "$SLUICE_SOURCE" \\
    --target-driver planetscale --target "$SLUICE_TARGET"`)}
<div class="note"><strong>Wait for caught-up before cutover.</strong> A <em>trickle</em> of changes can take tens of seconds to ~2 minutes to appear on the target — that latency is PlanetScale VStream's roughly 60&nbsp;s server-side delivery cadence, <em>not</em> sluice (the applier commits within seconds of <em>receiving</em> an event). Under sustained write load, lag stays low. So before you cut over, wait for <code>sync health</code> / <code>verify</code> to report caught-up rather than trusting a fixed timer.</div>
<div class="note"><strong>Keep <code>--apply-batch-size</code> in the 25–50 range on a PS target.</strong> Above 50, a batch's apply transaction can trip Vitess's 20-second transaction killer. 50 is a safe default here.</div>

<h3 id="one-shot">Option B — one-shot migrate</h3>
<p>If you can take a short maintenance window, a one-shot migrate is simpler — one command, no control tables left behind, and <code>identity_sync</code> auto-primes <code>AUTO_INCREMENT</code> so there's no separate cutover step:</p>
${pre(`sluice migrate \\
    --source-driver planetscale --source "$SLUICE_SOURCE" \\
    --target-driver planetscale --target "$SLUICE_TARGET" --dry-run

sluice migrate \\
    --source-driver planetscale --source "$SLUICE_SOURCE" \\
    --target-driver planetscale --target "$SLUICE_TARGET"

sluice verify \\
    --source-driver planetscale --source "$SLUICE_SOURCE" \\
    --target-driver planetscale --target "$SLUICE_TARGET"`)}
<p>The catch: a migrate is a point-in-time copy with <strong>no CDC</strong>, so any row written to the source after it starts is missed. That means you must <strong>freeze writes to the source for the entire copy window</strong> — about <strong>14 minutes</strong> for the 1.2&nbsp;GB test dataset. It's a good fit for a small database you can quiesce briefly.</p>

<h3 id="which">Which to choose</h3>
<p>Zero-downtime (Option A) is the better default for a real region move: no write freeze, and in testing it was also about <strong>3× faster on the bulk copy</strong> than one-shot (~5 minutes vs ~14 minutes for the same 1.2&nbsp;GB). One-shot (Option B) wins only on simplicity, when a brief maintenance window is acceptable and you'd rather not run a long-lived stream or a separate cutover.</p>

<h2 id="case-multi">Case 2 — several unsharded databases</h2>
<p>A PlanetScale database is one keyspace, and each <code>sync start</code> / <code>migrate</code> moves exactly one source keyspace to one target — so moving several databases means <strong>one run per database</strong>, each with its own <code>--stream-id</code> and its own target. There is nothing exotic here: it is Case 1 repeated per keyspace, run in parallel or supervised together.</p>
<p>Per database: create the target database in the new region, mint its <code>--role admin</code> password, and run the same Case-1 flow (Option A or Option B) with a distinct <code>--stream-id</code>. Moving two databases (<code>app-us-1</code>→<code>app-sa-1</code> and <code>app-us-2</code>→<code>app-sa-2</code>) is just two independent invocations, each pointed at its own source and target:</p>
${pre(`# database 1
sluice sync start --stream-id app-1-region-move \\
    --source-driver planetscale --source "$SLUICE_SOURCE_1" \\
    --target-driver planetscale --target "$SLUICE_TARGET_1" \\
    --apply-batch-size 50

# database 2 — independent stream, independent target
sluice sync start --stream-id app-2-region-move \\
    --source-driver planetscale --source "$SLUICE_SOURCE_2" \\
    --target-driver planetscale --target "$SLUICE_TARGET_2" \\
    --apply-batch-size 50`)}
<div class="note"><strong>Supervise many at once with a fleet config.</strong> Running each sync as its own process gets unwieldy past a handful. A <a href="/docs/operate-fleet/">sync fleet config</a> collapses them into one supervised, failure-isolated process — one entry per database, each with its own stream-id and target — so a whole fleet of region moves runs and reloads from a single place.</div>

<h2 id="case-sharded">Case 3 — a sharded keyspace</h2>
<p>A genuinely <em>sharded</em> PlanetScale keyspace — multiple shards behind a vindex — is supported as a source on <strong>sluice v0.99.191+</strong>; earlier versions failed the cold copy with 0&nbsp;rows. Because vtgate merges all shards into one logical stream, sluice's cross-shard-collision guard requires you to opt in: pass <code>--allow-cross-shard-merge</code> when your key is globally unique across shards (a hash vindex puts each id on exactly one shard, so ids are disjoint and the merge is safe), or <code>--inject-shard-column</code> to add a shard-discriminator column instead.</p>
<div class="note"><strong>Multi-keyspace sources are shard-complete (v0.99.196+).</strong> If your database holds several keyspaces, sluice cross-checks shard discovery against <code>SHOW VITESS_TABLETS</code>: vtgate's <code>SHOW VITESS_SHARDS</code> can silently omit a fully-serving secondary sharded keyspace, so trusting it alone could miss an entire keyspace's shards. sluice unions the two sources and warns on any discrepancy, so a sync or backup never silently skips a shard. A single-keyspace source was never affected (<a href="/docs/commands/">migrate</a> isn't either — its bulk copy is a plain scatter query vtgate fans out across every serving shard).</div>

<h3 id="sharded-merge">Sub-case A — merge into an unsharded target</h3>
<p>The simplest path, and it works out of the box: point the sharded source at an <em>unsharded</em> target database with <code>--allow-cross-shard-merge</code>, and every shard's rows land in the one target table. Live-proven — all rows copied, no <code>FailedPrecondition</code>. Note the source DSN's database is the <em>keyspace</em> name (here <code>sks</code>):</p>
${pre(`sluice migrate \\
    --source-driver planetscale \\
    --source "USER:PASS@tcp(aws.connect.psdb.cloud:3306)/sks?tls=true" \\
    --target-driver planetscale --target "$SLUICE_TARGET" \\
    --allow-cross-shard-merge`)}

<h3 id="sharded-preserve">Sub-case B — preserve sharding (sharded → sharded)</h3>
<p>To keep the data sharded, create a target keyspace sharded with the <strong>same</strong> vschema / vindex. sluice's cold copy <em>and</em> live CDC then route every row to the correct target shard — validated: INSERT / UPDATE / DELETE across both shards land on the matching shard, with under 20&nbsp;seconds of CDC lag.</p>
<div class="note"><strong>Control tables live in a sidecar keyspace — handled automatically on v0.99.193+.</strong> A <em>sharded</em> target can't hold sluice's internal control tables (<code>sluice_cdc_state</code>, <code>sluice_cdc_schema_history</code>, <code>sluice_shard_consolidation_lease</code>) directly — Vitess requires every table in a sharded keyspace to carry a vindex. On <strong>v0.99.193+</strong> sluice handles this: it <strong>auto-detects the database's default unsharded keyspace</strong> and creates its control tables there, so a sharded→sharded sync just works with no manual setup. Pass <code>--control-keyspace &lt;name&gt;</code> only to override (and if the database has several unsharded keyspaces, sluice asks you to choose one). On a sharded target the control-table write then rides the data transaction cross-keyspace (best-effort, not two-phase) — safe in practice, since a hard crash warm-resumes cleanly from the persisted position with no duplicates or gaps. On sluice <em>before</em> v0.99.193 this aborted with <code>VT09001: … does not have a primary vindex</code> before any rows copied; upgrade to v0.99.193+. (The merge sub-case A and a one-shot <em>full</em> backup/restore below never need a sidecar; a <em>chain</em> restore into a sharded target does — see <a href="#sharded-backup">below</a>.)</div>

<h3 id="sharded-backup">Backup / restore a sharded source</h3>
<p>If you just want a point-in-time copy of a sharded keyspace into a plain database, <code>backup full</code> reads a sharded source with <strong>no special flag</strong> — it flattens the shards into one logical stream — and <code>restore</code> into a PlanetScale MySQL database needs no <code>--allow-cross-shard-merge</code>, because the backup already flattened it:</p>
${pre(`sluice backup full \\
    --source-driver planetscale \\
    --source "USER:PASS@tcp(aws.connect.psdb.cloud:3306)/sks?tls=true" \\
    --output-dir ./sks-backup

sluice restore \\
    --from-dir ./sks-backup \\
    --target-driver planetscale --target "$SLUICE_TARGET"`)}
<p><strong>Restoring back into a sharded keyspace.</strong> Flattening on the backup side doesn't lock you into an unsharded target. Restore into a keyspace that's sharded with the <strong>same</strong> vindex and Vitess re-routes every row to its correct shard by the vindex hash — the same routing the live sync in <a href="#sharded-preserve">sub-case B</a> uses — so per-shard placement on the target matches the source exactly. Create the target keyspace sharded with a matching vschema first, then point <code>restore</code> at it (the <code>--target</code> database is the keyspace name):</p>
${pre(`sluice restore \\
    --from-dir ./sks-backup \\
    --target-driver planetscale \\
    --target "USER:PASS@tcp(aws.connect.psdb.cloud:3306)/sks?tls=true"`)}
<div class="note"><strong>A full restore just works; a chain restore needs the same sidecar as sync (v0.99.195+).</strong> A single <strong>full</strong> restore into a sharded target needs no extra flags — it writes only your data tables, which Vitess shards by their vindex, and creates no control tables; per-shard placement matches the source. A <strong>chain</strong> restore (a full plus one or more incrementals) is different: replaying the incrementals writes sluice's CDC control tables (<code>sluice_cdc_state</code> and friends), which a sharded keyspace can't hold — so <code>restore --control-keyspace &lt;name&gt;</code> routes them to an unsharded sidecar keyspace, <strong>auto-detected on v0.99.195+</strong> exactly like the <a href="#sharded-preserve">sync case above</a> (pass the flag only to override, or if the database has several unsharded keyspaces). Before v0.99.195 a chain restore into a sharded target aborted with <code>… does not have a primary vindex</code>; a single full restore was always fine.</div>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/planetscale-vitess/">PlanetScale &amp; Vitess</a> — the flavor, cold-start throughput knobs, and VStream lag reality in depth.</li>
  <li><a href="/docs/zero-downtime-cutover/">Zero-downtime migration</a> — the snapshot→CDC cutover flow, engine-agnostic.</li>
  <li><a href="/docs/commands/#sync-start">sync start reference</a> — every flag named here, with defaults.</li>
</ul>
`,
    prev: { href: "/docs/planetscale-vitess/", label: "PlanetScale & Vitess" },
    next: { href: "/docs/planetscale-postgres/", label: "PlanetScale Postgres" },
  })
);

// nav-label: PlanetScale Postgres
write(
  "planetscale-postgres",
  page({
    slug: "planetscale-postgres",
    title: "Migrate & sync PlanetScale Postgres",
    subtitle: "PlanetScale Postgres is managed PostgreSQL, so sluice drives it with the plain postgres engine — native logical-replication CDC, not the planetscale driver.",
    body: `
<p>PlanetScale Postgres is <strong>managed PostgreSQL, not Vitess</strong> — no keyspaces, no sharding, no VStream. So unlike PlanetScale <em>MySQL</em> (which needs the <code>planetscale</code> driver and the VStream feed — see <a href="/docs/planetscale-region-move/">the region-move guide</a>), you drive it with sluice's ordinary <strong><code>postgres</code></strong> engine: <code>COPY</code>-based cold copy and native <strong>logical-replication (replication-slot) CDC</strong>. Both a zero-downtime <a href="#sync">sync</a> and a one-shot <a href="#migrate">migrate</a> work end-to-end (validated on v0.99.194). Cross-engine value translation applies as usual only if the <em>other</em> side is MySQL or SQLite; Postgres→Postgres is byte-exact.</p>

<h2 id="connect">Provision &amp; connect</h2>
<p>Create the database with the Postgres engine — <code>--engine postgresql</code> is the pscale flag that selects managed Postgres rather than Vitess/MySQL. <code>--replicas 0</code> is a single node; <code>2</code> or more gives you HA. The default branch is <code>main</code>:</p>
${pre(`pscale database create app --engine postgresql --region <region> --replicas 0 --wait`)}
<p><strong>Connections use Postgres <em>roles</em>, not the MySQL password/connect flow.</strong> <code>pscale connect</code> is Vitess-only and refuses a Postgres database. Instead, take a DSN from a role's <code>database_url</code> field:</p>
<ul>
  <li><strong>Default role</strong> — <code>pscale role reset-default app main --format json</code> returns the stable <code>postgres</code> role's <code>database_url</code>.</li>
  <li><strong>Custom role</strong> — <code>pscale role create app main mover --inherited-roles postgres --format json</code>.</li>
</ul>
<p>The DSN is a standard libpq URL. Note the database is literally <code>postgres</code> and the port is 5432:</p>
${pre(`postgresql://<user>:<pass>@<region>.pg.psdb.cloud:5432/postgres?sslmode=verify-full`)}
<p>Prefer environment variables (<code>SLUICE_SOURCE</code> / <code>SLUICE_TARGET</code>) over putting the DSN in argv, so credentials don't land in your shell history or process list.</p>
<div class="note"><strong>Keep <code>sslmode=verify-full</code> — it works out of the box.</strong> The <code>database_url</code> PlanetScale emits already carries <code>sslmode=verify-full</code>, and you should keep it. PlanetScale Postgres presents a <strong>Let's Encrypt</strong> certificate (chaining to ISRG Root&nbsp;X1) — a public CA in every standard trust store — and the certificate's hostname matches, so <code>verify-full</code> validates cleanly. sluice's Postgres driver (pgx) checks it against your OS system trust store automatically: Windows, macOS, and a standard Linux host all connect with <code>verify-full</code> as-is (add <code>&amp;sslrootcert=system</code> only if you want it explicit). The one exception is a <strong>minimal Linux container with no <code>ca-certificates</code> package</strong> — the stock <code>postgres</code> Docker image is one — where the fix is to install <code>ca-certificates</code>, not to weaken TLS. Dropping to <code>sslmode=require</code> skips hostname and CA verification and isn't necessary here — see PlanetScale's <a href="https://planetscale.com/docs/vitess/connecting/secure-connections#ca-root-configuration">note on why verify-full matters</a>.</div>

<h2 id="sync">Zero-downtime sync</h2>
<p>A continuous sync snapshots and bulk-copies the source, then tails native logical-replication CDC — so the source stays <strong>writable the whole time</strong> and you flip traffic in a brief, controlled window. PlanetScale Postgres ships <code>wal_level=logical</code> with 20 replication slots, so slot-based CDC works out of the box:</p>
${pre(`sluice sync start --stream-id ps-pg \\
    --source-driver postgres --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET"`)}
<p>Watch it catch up from another shell, gate cutover on freshness, then stop and drain:</p>
${pre(`sluice sync status --stream-id ps-pg \\
    --target-driver postgres --target "$SLUICE_TARGET"

sluice sync health --stream-id ps-pg \\
    --target-driver postgres --target "$SLUICE_TARGET" --max-stale-seconds 30

sluice sync stop --stream-id ps-pg \\
    --target-driver postgres --target "$SLUICE_TARGET" --wait`)}
<p>sluice creates the slot, snapshots, tails, and applies live INSERT / UPDATE / DELETE with fidelity; <code>sync stop --wait</code> then drains cleanly. Two source-side requirements gate this:</p>
<div class="note warn"><strong>Two requirements on the source role.</strong>
<ol>
  <li><strong>Connect the source as the Default <code>postgres</code> role.</strong> Custom <code>pscale_api_*</code> roles lack the <code>REPLICATION</code> attribute and can't create a slot — sluice refuses loudly up front with a <code>SLUICE-E</code> error that names the fix (grant a replication role, or fall back to <code>--source-driver=postgres-trigger</code>). The Default <code>postgres</code> role <em>has</em> <code>REPLICATION</code>; use it for the source.</li>
  <li><strong>The connecting role must own the source tables.</strong> Publication management needs table ownership, otherwise you hit <code>must be owner of table</code> / <code>42501</code>. Cleanest is to create and own the source schema as <code>postgres</code> from the start.</li>
</ol>
</div>
<div class="note"><strong>Slot-less fallback.</strong> <code>--source-driver postgres-trigger</code> is a trigger-based, slot-less CDC path for managed Postgres that forbids replication (see <a href="/docs/getting-started/#trigger-cdc">trigger-based CDC</a>). You don't need it here — the Default <code>postgres</code> role unlocks native slot-based CDC — but it's the escape hatch if a platform ever denies the <code>REPLICATION</code> attribute.</div>

<h2 id="migrate">One-shot migrate</h2>
<p>A migrate is a point-in-time <code>COPY</code> with no CDC — a good fit when you can quiesce source writes for the copy window. Copy, then verify:</p>
${pre(`sluice migrate \\
    --source-driver postgres --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET"

sluice verify \\
    --source-driver postgres --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET"`)}
<p>Postgres→Postgres value fidelity is byte-exact — <code>numeric</code>, <code>timestamptz</code>, <code>jsonb</code>, and boolean all round-trip unchanged.</p>
<div class="note"><strong>Give the target tables a stable owner.</strong> migrate emits a WARN that the target tables land owned by the ephemeral <code>pscale_api_*</code> role a fresh DSN connects as. Connect the <em>target</em> as the Default <code>postgres</code> role (<code>pscale role reset-default app main</code>) so the tables get a durable owner instead of a short-lived API role.</div>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/postgres-source-prep/">Prepare a Postgres source</a> — replication-slot lifecycle, slot invalidation, and failover for the native CDC engine.</li>
  <li><a href="/docs/planetscale-region-move/">Move PlanetScale regions</a> — the PlanetScale <em>MySQL</em> story (the <code>planetscale</code> driver, VStream, sharded keyspaces).</li>
  <li><a href="/docs/commands/#sync-start">Command reference</a> — every flag named here, with defaults.</li>
</ul>
`,
    prev: { href: "/docs/planetscale-region-move/", label: "Move PlanetScale regions" },
    next: { href: "/docs/planetscale-postgres-upgrade/", label: "Upgrade PlanetScale Postgres" },
  })
);

// nav-label: Upgrade PlanetScale Postgres
write(
  "planetscale-postgres-upgrade",
  page({
    slug: "planetscale-postgres-upgrade",
    title: "Upgrade or re-platform a PlanetScale Postgres database",
    subtitle: "PlanetScale Postgres has no in-place major-version upgrade or CPU-architecture swap — provision a new instance on the target, let sluice sync across, then cut over.",
    body: `
<p>PlanetScale Postgres has <strong>no hands-off, in-place major-version upgrade</strong> — and no in-place CPU-architecture swap. The near-zero-downtime path is the same pattern the <a href="/docs/planetscale-region-move/">region-move guide</a> uses, along a different axis: <strong>provision a new PlanetScale Postgres instance on the target version (or architecture), use sluice to cold-copy and continuously sync the data across, verify, then cut traffic over.</strong> Because sluice's Postgres CDC is <strong>logical</strong> replication — row-level changes, not physical WAL pages — it carries data across a major-version boundary the way logical replication is the standard tool for near-zero-downtime PG major upgrades, and it's indifferent to the underlying CPU architecture. <strong>Live-validated: a real PlanetScale PG 17.10 → PG 18.4 move — cold-copy + continuous CDC + verify all clean, byte-identical value fidelity, no version-specific surprises.</strong></p>

<h2 id="when">When you need this</h2>
<p>Two axes, one flow:</p>
<ul>
  <li><strong>Major-version upgrade</strong> (e.g. 17→18, and 18→19 when it lands) — to stay current and pick up new PostgreSQL features and performance work. PlanetScale doesn't upgrade a database's major version in place, so you move to a fresh instance created on the newer version.</li>
  <li><strong>CPU-architecture change</strong> (ARM→x86, or back) — when your instance is on an architecture whose instance sizes are constrained and you need to move to the other. The architecture is chosen when the instance is created, so this too is a spin-up-new-instance move.</li>
</ul>
<p>Both reduce to the same three steps: <strong>spin up a new instance on the target, sync, cut over.</strong> sluice doesn't touch or even observe the architecture — logical replication is arch-transparent, so an ARM-source → x86-target sync is <em>identical</em> to the version-upgrade flow below. The live test's source and target both ran on <code>aarch64</code>; the version delta is the harder case (it crosses a catalog/format boundary) and it passed clean. The architecture case adds no schema or catalog difference at all — it's the same PG data on different silicon — so it's the strictly-simpler variant of the same procedure, not a separate one.</p>

<h2 id="provision">Provision the target</h2>
<p>Create the new instance on the target major version. <code>--major-version</code> selects the PG major; the default is the latest (18 today), and 17 is also available — pin it explicitly if you want a specific target:</p>
${pre(`pscale database create <new-db> --engine postgresql --major-version <NEW> \\
    --region <region> --replicas 0 --wait`)}
<p>For an <strong>architecture change</strong>, provision the new instance on the target architecture instead. The architecture is selected at instance creation on PlanetScale (the exact instance-type surface can vary — see <a href="https://planetscale.com/docs">PlanetScale's instance-type docs</a> rather than pinning a specific flag here). Everything downstream is identical to the version case.</p>
<p>Take the target DSN from the <strong>Default <code>postgres</code> role</strong> and <strong>keep its <code>sslmode=verify-full</code></strong> — PlanetScale Postgres uses a public Let's Encrypt certificate that sluice validates against the system trust store, so verify-full connects as-is (details in the <a href="/docs/planetscale-postgres/#connect">PlanetScale Postgres guide</a>):</p>
${pre(`pscale role reset-default <new-db> main --force --format json   # -> database_url

# DST_NEW = that database_url (keep sslmode=verify-full)`)}
<div class="note warn"><strong>Both ends connect as the Default <code>postgres</code> role.</strong> The <em>source</em> needs the <code>REPLICATION</code> attribute to create the logical-replication slot, which the custom <code>pscale_api_*</code> roles lack; the <em>target</em> wants a durable table owner. The Default <code>postgres</code> role has <code>REPLICATION</code> and owns the schema — use it on both. (Same requirement, and the same <code>SLUICE-E</code> refusal if you don't, as the <a href="/docs/planetscale-postgres/#sync">PlanetScale Postgres sync guide</a>.)</div>

<h2 id="sync">Sync across the version</h2>
<p>This is the exact validated sequence. One <code>sync start</code>, both ends the plain <code>postgres</code> driver:</p>
${pre(`sluice sync start --stream-id pg-upgrade \\
    --source-driver postgres --source "$SRC_OLD" \\
    --target-driver postgres --target "$DST_NEW"`)}
<p>sluice cold-copies every row, then logs <code>bulk-copy complete; entering CDC mode</code> and tails logical-replication CDC — so the old instance stays <strong>fully writable</strong> the entire time while the new one catches up. Watch freshness from another shell and gate cutover on it:</p>
${pre(`sluice sync status --stream-id pg-upgrade \\
    --target-driver postgres --target "$DST_NEW"

sluice sync health --stream-id pg-upgrade \\
    --target-driver postgres --target "$DST_NEW" --max-stale-seconds 30`)}
<p><strong>Live result (PG 17.10 → 18.4):</strong> 50 rows cold-copied, then 6 INSERT / 1 UPDATE / 1 DELETE on the source replicated to the PG&nbsp;18 target in about <strong>15 seconds</strong>. A subsequent <code>verify</code> reported <code>1 table checked, 1 clean, 0 mismatched</code>, and <code>numeric</code> / <code>timestamptz</code> / <code>jsonb</code> / boolean values were <strong>byte-identical across the version boundary</strong> — no copy or CDC WARNs.</p>

<h2 id="cutover">Verify and cut over</h2>
<p>Gate cutover on a clean <code>verify</code> plus a fresh <code>sync health</code>:</p>
${pre(`sluice verify \\
    --source-driver postgres --source "$SRC_OLD" \\
    --target-driver postgres --target "$DST_NEW"`)}
<p>Then drain the stream cleanly and repoint your application's <code>DATABASE_URL</code> at the new (upgraded) instance:</p>
${pre(`sluice sync stop --stream-id pg-upgrade \\
    --target-driver postgres --target "$DST_NEW" --wait`)}
<div class="note"><strong><code>verify</code> lists sluice's own bookkeeping tables as informational.</strong> A clean sync leaves sluice's control tables (<code>sluice_cdc_schema_history</code>, <code>sluice_shard_consolidation_lease</code>) on the target; <code>verify</code> reports them as target-only rows for transparency, <em>not</em> as mismatches. Your data tables are what the <code>0 mismatched</code> line covers.</div>

<h2 id="gotchas">Gotchas</h2>
<ul>
  <li><strong>Source and target both connect as the Default <code>postgres</code> role</strong> — the source for <code>REPLICATION</code> (slot creation), the target for durable table ownership. Custom <code>pscale_api_*</code> roles lack <code>REPLICATION</code>.</li>
  <li><strong>Keep <code>sslmode=verify-full</code></strong> on both DSNs — PlanetScale Postgres uses a public Let's Encrypt certificate that sluice validates against the system trust store, so verify-full connects as-is. No downgrade to <code>require</code> is needed; the only snag is a minimal Linux container with no <code>ca-certificates</code> package, where you install it rather than weakening TLS.</li>
  <li><strong><code>--major-version</code> defaults to the latest.</strong> If you want a specific target major, pin it explicitly; otherwise a fresh instance lands on the newest version PlanetScale offers.</li>
  <li><strong>No version-specific surprises at 17→18</strong> for the core type set — <code>numeric</code>, <code>timestamptz</code>, <code>jsonb</code>, boolean all round-tripped byte-identically, with no copy/CDC WARNs. A wider or more exotic type surface deserves its own <code>verify</code> before cutover regardless.</li>
  <li><strong>Provision the target with headroom.</strong> Size the new instance (PlanetScale sizing) to match or exceed the source before you cut over.</li>
</ul>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/planetscale-postgres/">Migrate &amp; sync PlanetScale Postgres</a> — the connection recipe (roles, <code>sslmode</code>) and migrate/sync depth this guide builds on.</li>
  <li><a href="/docs/planetscale-region-move/">Move PlanetScale regions</a> — the same provision-sync-cutover flow across a different axis (regions).</li>
  <li><a href="/docs/zero-downtime-cutover/">Zero-downtime migration</a> — the snapshot→CDC cutover flow in depth, engine-agnostic.</li>
  <li><a href="/docs/commands/#sync-start">Command reference</a> — every flag named here, with defaults.</li>
</ul>
`,
    prev: { href: "/docs/planetscale-postgres/", label: "PlanetScale Postgres" },
    next: { href: "/docs/operate-fleet/", label: "Operate a sync fleet" },
  })
);

// nav-label: Operate a sync fleet
write(
  "operate-fleet",
  page({
    slug: "operate-fleet",
    title: "Operate a sync fleet",
    subtitle: "Supervise many continuous syncs from one process — failure-isolated, observable, and reconfigurable without a restart.",
    body: `
<p>Once you keep several cross-database syncs alive at once, running each <a href="/docs/commands/#sync-start">sync start</a> as its own pod or systemd unit gets unwieldy. <a href="/docs/commands/#sync-start">sync run</a> collapses that to one supervised process driven by a single fleet config: it runs N independent syncs, each with its own stream-id, and — the load-bearing property — <strong>fully failure-isolated</strong>, so one sync crashing, erroring, or even panicking can never take down its healthy peers (ADR-0122). This guide covers running a fleet, observing it, and reconfiguring it live.</p>

<h2 id="config">The fleet config</h2>
<p>A fleet is a YAML file listing each sync as a curated subset of the <code>sync start</code> flags you already know, in kebab-case. A top-level <code>restart</code> block tunes the supervisor's bounded-backoff policy:</p>
${pre(`# syncs.yaml
syncs:
  - stream-id: orders
    source-driver: postgres
    source: postgres://user:pass@src-a:5432/app
    target-driver: mysql
    target: mysql://user:pass@dst:3306/app
    slot-name: orders           # distinct per Postgres source (see below)
    apply-concurrency: 4
    metrics-listen: :9101
  - stream-id: inventory
    source-driver: mysql
    source: mysql://user:pass@src-b:3306/inv
    target-driver: postgres
    target: postgres://user:pass@dst:5432/inv
    apply-delay: 60s
    metrics-listen: :9102
restart:
  backoff-base: 1s
  backoff-cap: 30s
  max-consecutive-failures: 0   # 0 = restart forever with capped backoff`)}
<div class="note"><strong>Two data-corruption classes are refused at load, loudly.</strong> Two Postgres-source syncs that resolve to the same replication <code>slot-name</code> would fight over one single-consumer slot — silent corruption — so the loader refuses the config, naming both stream-ids and the slot. Duplicate stream-ids on the same target (which would clobber each other's position row) are refused the same way. When several syncs point at one target server, the loader <strong>WARNs</strong> that they share a connection budget so you can size <code>apply-concurrency</code> accordingly.</div>
<p>Each sync's own retry (ADR-0093 re-snapshot, apply-retry backoff) is the inner loop; the supervisor's restart is the outer loop. A sync that drains cleanly (a <code>sync stop</code> or Ctrl-C) is left stopped; a sync that dies with the process still live is logged loudly, backed off, and restarted. The consecutive-failure counter resets once a sync has run longer than the healthy threshold, so a sync that ran for hours before dying carries no restart debt.</p>

<h2 id="run">Run the fleet</h2>
<p>Validate the config first with <code>--dry-run</code> (it checks required fields, stream-id and slot-name uniqueness, and retry bounds, then prints the resolved plan without starting anything), then run it:</p>
${pre(`# validate + print the plan, start nothing
sluice sync run --config syncs.yaml --dry-run

# run the fleet, with a read-only dashboard on :9300
sluice sync run --config syncs.yaml --dashboard-listen :9300`)}
<p>The process blocks until every sync exits. Ctrl-C / SIGTERM stops all of them cleanly. A single-sync fleet that can never start exits non-zero, but a fleet with any healthy peer keeps running regardless of what its neighbors do.</p>

<h2 id="reload">Reload without a restart (SIGHUP)</h2>
<p>Edit <code>syncs.yaml</code> and send the running process a <code>SIGHUP</code>: sluice re-reads and re-validates the file, then reconciles the live fleet — <strong>starting</strong> newly-added syncs, <strong>draining and stopping</strong> removed ones, and <strong>restarting</strong> any whose spec changed (detected by a per-stream fingerprint, so unchanged syncs are left untouched):</p>
${pre(`kill -HUP "$(pgrep -f 'sluice sync run')"`)}
<div class="note"><strong>A bad reload never takes the fleet down.</strong> The reload runs the exact same validators as the initial load <em>before</em> building anything; if the new file fails to parse or validate (a slot collision, a duplicate stream-id, a missing field), the reload is refused loudly and the running fleet keeps going on the old config, unchanged. Each reload logs its outcome — the started / stopped / restarted stream-ids, or "no changes." <code>SIGHUP</code> is POSIX-only; on Windows, restart the process to change the fleet.</div>

<h2 id="status">See the whole fleet at once</h2>
<p><a href="/docs/commands/#sync-manage">sync status --all</a> rolls up every stream across every target named in the fleet config into one table — reading the target control tables directly, so no running supervisor is required. A target that can't be reached is reported inline and skipped rather than blanking the whole view:</p>
${pre(`sluice sync status --all --config syncs.yaml --summary

# live-refresh every 2s, machine-readable
sluice sync status --all --config syncs.yaml --format json --watch 2s`)}

<h2 id="metrics">Observe it: Prometheus metrics and readiness</h2>
<p>Give each sync a <code>metrics-listen</code> address in the config (as above) and it binds a Prometheus-format <code>/metrics</code> endpoint plus <code>/healthz</code> (liveness) and <code>/readyz</code> (flips to 200 once the sync has finished its snapshot/warm-resume preamble and entered the apply loop). The exported <code>sluice_*</code> gauge families include:</p>
<table><thead><tr><th>Gauge</th><th>What it tells you</th></tr></thead><tbody>
<tr><td><code>sluice_sync_lag_seconds</code></td><td class="desc">Seconds the target trails the source's latest applied commit (engine-neutral apply lag; 0 when caught up).</td></tr>
<tr><td><code>sluice_seconds_since_last_apply</code></td><td class="desc">Wall-clock seconds since this stream's most recent applier commit — the staleness signal.</td></tr>
<tr><td><code>sluice_stream_known</code></td><td class="desc">Constant 1 per tracked stream; <code>count(sluice_stream_known)</code> gives a stream-count alert.</td></tr>
<tr><td><code>sluice_apply_batch_size_current</code> / <code>_p95_seconds</code></td><td class="desc">The AIMD apply-batch controller's current target size and rolling p95 latency.</td></tr>
<tr><td><code>sluice_target_*</code></td><td class="desc">Target CPU / memory / storage utilisation and replica lag — present only when <a href="/docs/planetscale-vitess/">PlanetScale telemetry</a> is configured.</td></tr>
</tbody></table>
<p>Because <code>/readyz</code> is a real readiness signal, it wires straight into a Kubernetes probe on the sync's metrics port:</p>
${pre(`readinessProbe:
  httpGet:
    path: /readyz
    port: 9101
  periodSeconds: 10`)}

<h3>Pre-emptive Postgres slot-health warnings</h3>
<p>For a Postgres source, a replication slot that outruns its retention budget gets evicted and the stream breaks. sluice watches for that ahead of time and emits severity-graded <code>slog</code> warnings: a <strong>WARN</strong> when retention pressure crosses 70% of <code>max_slot_wal_keep_size</code>, a <strong>CRITICAL</strong> at 85% (eviction imminent), and a WARN when the slot has been observed inactive for 30 minutes or more (ADR-0059). These are rate-limited and emit a "cleared" INFO when the condition resolves, so the alarm turns off visibly.</p>

<h2 id="dashboards">Live dashboards: web and terminal</h2>
<p><code>sync run --dashboard-listen ADDR</code> serves a self-contained, auto-refreshing HTML page of the live fleet — per-sync state, restart count, consecutive failures, last error, uptime — backed by a stable <code>GET /api/fleet</code> JSON API (ADR-0124). It is strictly read-only: no stop/restart controls, no data path, and it exposes only what <code>sync status --all</code> already does (stream-ids, states, error strings — no DSNs, no row data). It has <strong>no authentication</strong>, so bind it to localhost or a trusted network.</p>
<p>For a terminal equivalent, <a href="/docs/commands/#sync-manage">sync tui --connect</a> is a full-screen client that polls that same <code>/api/fleet</code> endpoint — so it works locally or over an SSH tunnel to the dashboard port, without disturbing the fleet process:</p>
${pre(`# terminal 1: run the fleet with the dashboard API exposed
sluice sync run --config syncs.yaml --dashboard-listen :9300

# terminal 2 (local or over an SSH tunnel): live terminal view
sluice sync tui --connect :9300 --refresh 2s`)}
<div class="note">The dashboard binds when the fleet starts; if the address can't be bound the command fails loudly rather than running a fleet without the dashboard you asked for. The TUI keeps the last-known fleet on screen with an "unreachable" banner if a poll fails, instead of blanking.</div>

<h2 id="alerts">Threshold alerts (advisory)</h2>
<p>The fleet can push threshold alerts to a webhook or Slack. Set the sink URL via its env var (<code>SLUICE_NOTIFY_WEBHOOK</code> / <code>SLUICE_NOTIFY_SLACK</code>), then arm one or more thresholds. Alerts are edge-triggered, cooldown'd (<code>--notify-cooldown</code>, default 15m), and <strong>advisory + failure-isolated</strong> — a dead sink is logged and swallowed, never affecting the sync:</p>
<table><thead><tr><th>Threshold</th><th>Fires when…</th></tr></thead><tbody>
<tr><td><code>--notify-sync-lag-seconds</code></td><td class="desc">sluice's own apply lag (<code>sluice_sync_lag_seconds</code>) is at or above N. <strong>Ungated</strong> — works on MySQL and Postgres alike, needing only a sink.</td></tr>
<tr><td><code>--notify-lag-seconds</code></td><td class="desc">The target's control-plane replica lag is at or above N. Requires PlanetScale telemetry.</td></tr>
<tr><td><code>--notify-storage-util</code> / <code>--notify-cpu-util</code> / <code>--notify-mem-util</code></td><td class="desc">Target utilisation (0–1 fraction) is at or above the given level. Requires PlanetScale telemetry.</td></tr>
<tr><td><code>--notify-storage-growth-per-min</code></td><td class="desc">Storage is climbing at or above N fraction-of-capacity per minute — a pre-grow early warning. Requires telemetry.</td></tr>
</tbody></table>
<p>All the util / control-plane-lag / growth rules need a <a href="/docs/planetscale-vitess/">PlanetScale telemetry</a> provider (<code>--planetscale-org</code> plus the metrics-token flags); only <code>--notify-sync-lag-seconds</code> works without it. The same alerter set is also available on the standalone <a href="/docs/commands/#metrics-watch">metrics-watch</a> probe.</p>

<h2 id="next-steps">Next steps</h2>
<ul>
<li><a href="/docs/commands/#sync-start">sync start reference</a> — the full per-sync flag surface each fleet entry is built from.</li>
<li><a href="/docs/planetscale-vitess/">Sync to PlanetScale / Vitess</a> — the telemetry credentials the util-threshold alerts and <code>sluice_target_*</code> gauges require.</li>
<li><a href="/docs/zero-downtime-cutover/">Zero-downtime migration</a> — the single-stream cutover flow each fleet sync runs internally.</li>
</ul>
`,
    prev: { href: "/docs/planetscale-postgres-upgrade/", label: "Upgrade PlanetScale Postgres" },
    next: { href: "/docs/encrypted-backups/", label: "Take encrypted backups" },
  })
);

// nav-label: Take encrypted backups
write(
  "encrypted-backups",
  page({
    slug: "encrypted-backups",
    title: "Take encrypted backups",
    subtitle: "sluice's logical backup model in depth — chains, compression, encryption at rest, object stores, retention, and restore.",
    body: `
<p>sluice's <code>backup</code> verb takes <strong>logical, row-level, cross-engine</strong> backups: a full snapshot that roots a chain, plus CDC-based incrementals appended onto it, written to storage <em>you</em> own. Unlike a physical tool (pgBackRest, WAL-G, XtraBackup), a sluice chain restores into Postgres <em>or</em> MySQL from either, with redaction and encryption already applied in the pipeline. This guide is the reference for the model — the <a href="/docs/getting-started/#backups">getting-started section</a> is the quick tour; here we go deeper into encryption, the format-version contract, retention, and restore.</p>
<div class="note"><strong>Logical, not physical.</strong> sluice is deliberately not in <code>pg_basebackup</code> / WAL-archive territory — those tools are excellent at same-engine PITR at scale, and that lane is theirs. sluice's value is the cross-engine, operator-owned-storage, encrypt-and-redact-at-capture angle. Many setups run both: physical for primary DR, a sluice chain for the off-vendor / cross-engine / compliance copy.</div>

<h2 id="chain-model">The chain model</h2>
<p>A backup is a <strong>chain</strong>. The <strong>full</strong> snapshot (<code>backup full</code>) is the root; each <strong>incremental</strong> (<code>backup incremental</code>) captures the change events since the previous link and appends a new segment. The full is engine-neutral (any registered source, including a <code>sqlite</code> file); incrementals need a CDC-capable source (Postgres / MySQL natively, or the <code>sqlite-trigger</code> / <code>d1-trigger</code> engines).</p>
<p>On Postgres, the chain is anchored by a replication slot. Pass <code>--chain-slot</code> to <code>backup full</code> and the full provisions the persistent slot (named by <code>--slot-name</code>, default <code>sluice_slot</code>) as the snapshot anchor and ensures the publication exists — so the next <code>backup incremental</code> chains with <strong>zero gap</strong> by construction, no manual slot management:</p>
${pre(`# full snapshot to a local directory, provisioning the chain anchor
sluice backup full --source-driver postgres --source 'postgres://...' \\
    --output-dir /var/backups/app --chain-slot

# append an incremental (chains off the most recent manifest)
sluice backup incremental --source-driver postgres --source 'postgres://...' \\
    --output-dir /var/backups/app`)}
<div class="note"><strong>Why <code>--chain-slot</code> matters.</strong> Creating a slot <em>after</em> a full and expecting the next incremental to fill the gap is a silent-loss trap: PostgreSQL fast-forwards <code>START_REPLICATION</code> to the slot's <code>confirmed_flush_lsn</code> without complaint, so every write in between vanishes from the chain. <code>--chain-slot</code> provisions the slot at the snapshot anchor so there is no gap; a chain-resume preflight then refuses loudly if a slot can't serve the parent position (ADR-0083). To abandon a chain, drop the slot with <code>sluice slot drop</code> — it holds source-side WAL until the next incremental consumes it.</div>
<p>Chain off a specific parent with <code>--since &lt;backup-id&gt;</code> (default: the most recent manifest). Each incremental's window closes on <code>--window</code> (wall-clock, default <code>5m</code>) or <code>--max-changes</code> (event count), whichever fires first, and is always extended to the next transaction commit so a chain never ends mid-transaction.</p>

<h2 id="compression">Compression</h2>
<p>Chunks are compressed per segment. The codec is <code>--compression none|gzip|zstd</code>, and the default is <strong><code>zstd</code></strong> (klauspost/compress at SpeedDefault): 55–85% faster restore — the recovery-time-critical axis — for ~1–5% larger artifacts than gzip. <code>none</code> leaves chunks as human-readable <code>.jsonl</code> on a local-FS target; <code>gzip</code> is the pre-v0.67.0 codec. The codec is recorded in <code>lineage.json</code> and read back from there on restore — it is never inferred from the bytes, so a mixed-codec chain restores correctly.</p>

<h2 id="encryption">Encryption at rest</h2>
<p>Add <code>--encrypt</code> to rest the whole chain under client-side <strong>envelope encryption</strong>: sluice generates a content-encryption key (CEK), encrypts every chunk with it, and wraps the CEK under a key-encryption key (KEK) you supply. <code>--encrypt</code> requires exactly one key source — a passphrase or a cloud KMS key — and the same flag is read on the restore / verify / broker side to unwrap. The two modes are mutually exclusive and cannot be mixed within a single chain.</p>

<h3>Passphrase mode</h3>
<p>Supply the passphrase from an environment variable or a file — <strong>never</strong> on the command line, where it lands in shell history:</p>
${pre(`export SLUICE_BACKUP_PASS='correct horse battery staple'
sluice backup full --source-driver postgres --source 'postgres://...' \\
    --output-dir /var/backups/app --chain-slot \\
    --encrypt --encryption-passphrase-env SLUICE_BACKUP_PASS`)}
<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
<tr><td><code>--encryption-passphrase-env</code></td><td class="desc">Read the passphrase from the named environment variable. Recommended for production.</td></tr>
<tr><td><code>--encryption-passphrase-file</code></td><td class="desc">Read the passphrase from a file path (a trailing newline is trimmed). Best for secrets-manager integrations — 1Password CLI, AWS Secrets Manager, etc.</td></tr>
<tr><td><code>--encryption-passphrase</code></td><td class="desc">Inline passphrase. <strong>Deprecated for production</strong> — it shows up in shell history. Use one of the two above.</td></tr>
</tbody></table>
<p>sluice derives the KEK from the passphrase with <strong>Argon2id</strong> and records the salt + cost parameters in the chain-root manifest. Incrementals and restores re-derive the same KEK from those recorded params — so an operator only ever has to remember the passphrase, and every link in the chain unwraps consistently.</p>

<h3>Cloud KMS mode</h3>
<p>Instead of a passphrase, wrap the CEK through a cloud KMS. The KMS <em>root</em> key never leaves the provider — sluice routes only wrap/unwrap calls:</p>
<table><thead><tr><th>Flag</th><th>Provider</th></tr></thead><tbody>
<tr><td><code>--kms-key-arn</code></td><td class="desc">AWS KMS key ARN, alias ARN, or <code>alias/name</code>. Pair with <code>--kms-region</code> to override region resolution. Auth follows the AWS SDK (env / profile / instance role).</td></tr>
<tr><td><code>--gcp-kms-key-resource</code></td><td class="desc">GCP Cloud KMS crypto-key resource (<code>projects/.../cryptoKeys/KEY</code>). Auth via Application Default Credentials.</td></tr>
<tr><td><code>--azure-key-vault-id</code></td><td class="desc">Azure Key Vault key identifier URL. Override the wrap algorithm with <code>--azure-wrap-algorithm</code> (default <code>RSA-OAEP-256</code>; HSM-backed AES keys need <code>A256KW</code>). Auth via <code>DefaultAzureCredential</code>.</td></tr>
</tbody></table>
${pre(`# full backup to R2, envelope-encrypted under an AWS KMS key
sluice backup full --source-driver postgres --source 'postgres://...' \\
    --target s3://my-bucket/app-chain \\
    --backup-endpoint https://<account>.r2.cloudflarestorage.com \\
    --backup-region auto --backup-path-style \\
    --chain-slot \\
    --encrypt --kms-key-arn arn:aws:kms:us-east-1:111122223333:key/abcd-1234`)}
<div class="note">The KMS flags are mutually exclusive with each other and with the passphrase flags. Setting a key source without <code>--encrypt</code> is a loud error, not a silent plaintext backup.</div>

<h3>Per-chain vs per-chunk</h3>
<p><code>--encrypt-mode</code> chooses the CEK granularity: <code>per-chain</code> (default) uses one CEK for the whole chain — a single KEK derive / KMS <code>Decrypt</code> per restore; <code>per-chunk</code> uses a fresh CEK per chunk for defense-in-depth at the cost of a per-chunk wrap. Most operators want the default.</p>
<div class="note"><strong>One mode per chain.</strong> A chain uses a single encryption mode for every segment. Set <code>--encrypt-mode per-chain</code> or <code>per-chunk</code> on the <code>backup full</code> that roots the chain; on each <code>backup incremental</code>, <code>backup stream</code>, or resumed <code>backup full</code>, <strong>omit <code>--encrypt-mode</code> so the segment inherits the chain's mode</strong>. Passing an explicit mode that conflicts with the chain's recorded mode is refused at build time (as of v0.99.185) rather than silently producing a mixed-mode chain.</div>

<h2 id="format-version">The FormatVersion refuse-before-touch contract</h2>
<p>Every chain-root manifest carries a <code>FormatVersion</code>. It exists to prevent one specific silent-loss class: an older sluice binary restoring a chain and <em>silently dropping</em> security-or-correctness metadata it doesn't understand.</p>
<ul>
  <li><strong><code>FormatVersion=1</code></strong> — the schema uses none of the gated features. Any sluice from v0.16.x onward restores it.</li>
  <li><strong><code>FormatVersion=2</code></strong> — the schema contains at least one of: row-level security enabled or forced, one or more RLS policies, or one or more <code>EXCLUDE</code> constraints. Only sluice v0.94.1+ restores it.</li>
  <li><strong><code>FormatVersion=4</code></strong> — the schema carries one or more standalone sequences (v0.99.175+). An older binary would silently restore the target without the sequence object — its custom <code>START</code>/<code>INCREMENT</code> options and <code>nextval()</code> topology gone — so it refuses loudly at preflight instead.</li>
</ul>
<p><code>FormatVersion=3</code> is a special case: it marks an <em>in-progress</em> full backup in the sidecar-checkpoint layout (v0.99.39+) and is <strong>never stamped on a finalized manifest</strong>, so a completed backup you restore is only ever 1, 2, or 4. It exists so an older binary refuses to <em>resume</em> an in-progress backup it can't account for, rather than mis-resuming off a base manifest that under-reports progress.</p>
<p>The rule is <strong>proportional</strong>: a manifest gets the <em>minimum</em> version safe for its actual contents, so a typical CRUD database with no RLS, no <code>EXCLUDE</code> constraints, and no standalone sequences stays at <code>FormatVersion=1</code> and cross-version restore behaves exactly as before. The value is derived from the schema — there's no flag to set. Audit it with <code>jq .format_version manifest.json</code>.</p>
<p>Point a pre-v0.94.1 binary at a <code>FormatVersion=2</code> chain and its restore preflight trips <em>before any DDL or data lands</em>: it exits with <code>manifest format version 2 is newer than this build supports (1); upgrade sluice</code> and creates zero relations on the target. The refuse-before-touch property is load-bearing — there is no code path on the older binary where the chain is partially applied with RLS or <code>EXCLUDE</code> metadata stripped. The silent-loss class is structurally impossible (Bug 116, closed in v0.94.1). Full contract: <a href="https://github.com/sluicesync/sluice/blob/main/docs/backup-format-versioning.md">backup-format-versioning.md</a>.</p>

<h2 id="object-stores">Object stores</h2>
<p>Swap <code>--output-dir</code> for <code>--target &lt;url&gt;</code> to write to an object store. Four schemes are supported:</p>
<table><thead><tr><th>Scheme</th><th>Destination</th></tr></thead><tbody>
<tr><td><code>s3://bucket/prefix</code></td><td class="desc">Amazon S3 or any S3-compatible provider.</td></tr>
<tr><td><code>gs://bucket/prefix</code></td><td class="desc">Google Cloud Storage.</td></tr>
<tr><td><code>azblob://container/prefix</code></td><td class="desc">Azure Blob Storage.</td></tr>
<tr><td><code>file:///path</code></td><td class="desc">Local filesystem (the URL form of <code>--output-dir</code>).</td></tr>
</tbody></table>
<p>For <strong>S3-compatible</strong> providers — Cloudflare R2, Backblaze B2, MinIO, Wasabi, Tigris — an <code>s3://</code> URL takes three extra knobs: <code>--backup-endpoint</code> (the provider's endpoint URL), <code>--backup-region</code>, and <code>--backup-path-style</code> (bucket-in-path addressing, which most non-AWS providers require). Credentials follow the cloud SDK's normal resolution (<code>AWS_ACCESS_KEY_ID</code> / <code>AWS_SECRET_ACCESS_KEY</code> for any S3-compatible endpoint). These knobs apply verbatim to <code>backup incremental</code>, <code>stream</code>, <code>verify</code>, <code>prune</code>, <code>compact</code>, and <code>restore</code> too.</p>
${pre(`# full backup to Cloudflare R2 (an S3-compatible store)
sluice backup full --source-driver postgres --source 'postgres://...' \\
    --target s3://my-bucket/app-chain \\
    --backup-endpoint https://<account>.r2.cloudflarestorage.com \\
    --backup-region auto \\
    --backup-path-style \\
    --chain-slot`)}

<h2 id="continuous">Continuous backup</h2>
<p>Rather than firing an incremental from cron, run <code>backup stream run</code> as a long-lived process that commits <strong>rolling incrementals</strong> at a cadence. Each rollover closes on the first of <code>--rollover-window</code> (default <code>5m</code>), <code>--rollover-max-changes</code> (default <code>100000</code>), or <code>--rollover-max-bytes</code> (default 64 MiB), and — like a manual incremental — extends to the next transaction commit:</p>
${pre(`sluice backup stream run --source-driver postgres --source 'postgres://...' \\
    --target s3://my-bucket/app-chain \\
    --rollover-window 5m --rollover-max-changes 100000`)}
<p>Stop it with SIGTERM / SIGINT (drains the in-flight rollover and exits), or cross-machine with <code>sluice backup stream stop --target &lt;url&gt;</code>, which writes a stop request the running stream observes on its next rollover tick. To bound total disk without an external wrapper, in-process rotation caps the open segment at <code>--retain-rotate-at &lt;dur&gt;</code> and/or <code>--retain-rotate-at-chain-length &lt;n&gt;</code> and opens a fresh segment over the same CDC handle (ADR-0046); pair that with <code>backup prune</code> below.</p>

<h2 id="retention">Retention: prune and compact</h2>
<p>Two explicit operator actions bound a chain's size and restore time. Neither runs automatically, and the chain root (full) is always preserved.</p>
<p><strong><code>backup prune</code></strong> drops the oldest incrementals. Choose retention by count (<code>--keep-incrementals N</code>) or age (<code>--keep-duration DUR</code>) — exactly one is required. The first surviving incremental is re-stitched to point at the full directly, which advances the chain's earliest restorable position forward: the dropped windows are gone from the chain's restore range, so this is opt-in. Use <code>--dry-run</code> to see what would go without touching storage.</p>
${pre(`# keep the 30 most recent incrementals; preview first
sluice backup prune --from-dir /var/backups/app --keep-incrementals 30 --dry-run
sluice backup prune --from-dir /var/backups/app --keep-incrementals 30`)}
<p><strong><code>backup compact</code></strong> merges consecutive segments whose <code>CreatedAt</code> gaps fall within <code>--merge-window</code> (required) into one segment — fewer files, faster restore. By default it's a byte-level concat: bytes are never decompressed, recompressed, or re-encrypted. Mixed codecs, divergent encryption keysets, or position gaps within a group refuse loudly before any mutation. Opt into event-level collapse (INSERT+UPDATE → INSERT, etc.) with <code>--smart-compaction</code> (ADR-0064). <code>--dry-run</code> reports the plan.</p>

<h2 id="restore">Restore and point-in-time</h2>
<p><code>sluice restore</code> reads a chain from <code>--from-dir</code> / <code>--from</code>, applies the schema (retargeting cross-engine if <code>--target-driver</code> differs from the backup's source engine), bulk-copies the rows back, and creates indexes, constraints, and views. When the store contains incrementals, restore walks the chain <strong>in order</strong> from the root through every incremental present, landing the target at the chain's tip:</p>
${pre(`sluice restore --from-dir /var/backups/app \\
    --target-driver postgres --target 'postgres://...target...'`)}
<p><strong>Point-in-time</strong> recovery granularity is your incremental / rollover cadence: every committed incremental is a restorable position, and restore reconstructs the target as of the newest link in the store it reads. To recover to an earlier point, restore from a store (or a copy) whose newest incremental is that point — sluice restore has no "as of timestamp T" flag; the chain's committed positions <em>are</em> the recoverable points.</p>
<p>Restore parallelism is engine-generic: <code>--table-parallelism</code> (tables applied concurrently, auto 4) composes with <code>--bulk-parallelism</code> (a single table's chunks applied concurrently, auto min(8, NumCPU)); their product is clamped to the target's connection budget. For a chain that carries incrementals, <code>--apply-concurrency</code> fans the incremental change-replay across in-order PK-hash lanes (auto 4) — the knob that matters on a high-latency / cross-region target. Same-engine chains replay schema deltas and change chunks; cross-engine chains that carry incrementals are refused (a full-only cross-engine restore is fine).</p>
<div class="note">To replay a chain into a <em>live, continuously-updated</em> target instead of a one-shot restore, use the broker — one process produces the chain, another tails it and applies incrementals as they land. See <a href="/docs/from-backup-sync/">Sync from a backup chain</a>.</div>

<h2 id="verify">Verifying a backup</h2>
<p><code>backup verify</code> walks a chain, recomputes every chunk's SHA-256, and reports any mismatch — a target-free integrity probe, ideal for a cron check against archived backups:</p>
${pre(`sluice backup verify --from-dir /var/backups/app`)}
<p>For an <strong>encrypted</strong> chain, add <code>--encrypt</code> plus the same key source you backed up with. Verify then also runs a decrypt probe on every per-chunk wrapped CEK, so a mid-chain passphrase rotation surfaces here as a clear verify failure instead of a partial-fail at restore time (Bug 117). Verify warns loudly if you point it at an encrypted chain <em>without</em> a key source — SHA-only verify can't see that class of problem.</p>
${pre(`export SLUICE_BACKUP_PASS='correct horse battery staple'
sluice backup verify --from-dir /var/backups/app \\
    --encrypt --encryption-passphrase-env SLUICE_BACKUP_PASS`)}

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/from-backup-sync/">Sync from a backup chain</a> — replay a chain into a live target as a long-running broker (decoupled transport).</li>
  <li><a href="/docs/commands/#backup">backup / restore command reference</a> — the full flag set for every subcommand.</li>
  <li><a href="/docs/configuration/">Configuration</a> — YAML config, type/expression overrides, and PII redaction (which also applies at backup time, so on-disk chunks are PII-clean).</li>
</ul>
`,
    prev: { href: "/docs/operate-fleet/", label: "Operate a sync fleet" },
    next: { href: "/docs/from-backup-sync/", label: "Sync from a backup chain" },
  })
);

// =========================================================================
//  llms.txt + llms-full.txt (AI-assistant index — llmstxt.org convention)
//
// Served at sluicesync.com/llms.txt by Cloudflare Pages like any other
// committed static file. llms.txt is the curated index (site pages from NAV
// + the canonical markdown docs in the source repo, which are the best
// format for LLM consumption); llms-full.txt is every docs page's content
// tag-stripped into one plain-text file. Both regenerate on every build from
// the same NAV/EMITTED data that renders the site, so they cannot drift.
// Background: docs/research/ai-friendly-sluice.md in the sluice repo.
// =========================================================================

const SITE = "https://sluicesync.com";
const RAW = "https://raw.githubusercontent.com/sluicesync/sluice/main";

function unesc(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rarr;/g, "→")
    .replace(/&larr;/g, "←")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Crude but serviceable HTML→text for llms-full.txt: code blocks kept as
// indented text, headings kept as markdown, list items bulleted, table cells
// separated, everything else tag-stripped.
function textify(html) {
  let t = html;
  t = t.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, code) => {
    const plain = code.replace(/<[^>]+>/g, "");
    return "\n" + plain.split("\n").map((l) => "    " + l).join("\n") + "\n";
  });
  t = t.replace(/<(h2|h3)[^>]*>([\s\S]*?)<\/\1>/g, (_, tag, inner) => "\n" + (tag === "h2" ? "## " : "### ") + inner.replace(/<[^>]+>/g, "") + "\n");
  t = t.replace(/<li[^>]*>/g, "\n- ").replace(/<\/li>/g, "");
  t = t.replace(/<\/t[dh]>/g, " · ").replace(/<tr[^>]*>/g, "\n");
  t = t.replace(/<\/(p|div|ul|ol|table)>/g, "\n");
  t = t.replace(/<[^>]+>/g, "");
  t = unesc(t);
  return t.replace(/[ \t]+\n/g, "\n").replace(/ · \n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const bySlug = new Map(EMITTED.map((p) => [p.slug, p]));
const pageURL = (slug) => (slug === "" ? SITE + "/docs/" : SITE + "/docs/" + slug + "/");

let llms = `# sluice

> Open-source database migration and continuous-sync CLI: migrate and sync MySQL ↔ Postgres in all four directions, plus SQLite / Cloudflare D1 import and continuous sync — correctness-first, loud failure by default.

sluice is a single Go binary. Every command is non-interactive (flags, environment variables, and an optional YAML config — no prompts, ever), destructive operations require explicit opt-in flags, credentials resolve env-first, and machine-readable output is available via \`--log-format json\` and per-command \`--format json\`. The documentation below is also maintained as markdown in the source repository — for LLM consumption the raw markdown links in the "Source-repo markdown" section are the best format. Each site page below is additionally served as token-slim Markdown at its own URL with \`index.md\` appended (e.g. \`${SITE}/docs/getting-started/index.md\`), linked from every page via \`<link rel="alternate" type="text/markdown">\`.
`;

for (const g of NAV) {
  llms += `\n## ${g.group}\n\n`;
  for (const it of g.items) {
    const p = bySlug.get(it.slug);
    const note = p && p.subtitle ? ": " + p.subtitle : "";
    llms += `- [${it.label}](${pageURL(it.slug)})${note}\n`;
  }
}

llms += `
## Source-repo markdown (best for LLMs)

- [README](${RAW}/README.md): project overview, quick start, engine list, CLI command table
- [Architecture](${RAW}/docs/architecture.md): the typed IR, engine pattern, orchestrator, capability model
- [Type mapping](${RAW}/docs/type-mapping.md): cross-engine type translation policies, extension types, override tokens
- [Value types](${RAW}/docs/value-types.md): the runtime row-value contract (what each IR type holds at copy time)
- [Cookbook](https://github.com/sluicesync/sluice/tree/main/docs/cookbook): task-shaped recipes (one-shot migrate, zero-downtime cutover, encrypted backup chains, PII redaction)
- [ADR index](${RAW}/docs/adr/README.md): every architecture decision record with a one-line summary
- [Security policy](${RAW}/SECURITY.md): threat model, the source-trust boundary, credential handling, reporting

## Optional

- [Full documentation as one plain-text file](${SITE}/llms-full.txt)
- [GitHub repository](https://github.com/sluicesync/sluice)
- [Release notes archive](https://github.com/sluicesync/sluice/tree/main/docs/releases)
`;

writeFileSync(join(ROOT, "llms.txt"), llms);
console.log("wrote llms.txt");

let full = `# sluice — full documentation (plain text)

Generated from the same sources as ${SITE}/docs/ — regenerate with \`node build.mjs\`. Curated index: ${SITE}/llms.txt

`;
for (const p of EMITTED) {
  full += `\n\n===============================================================\n# ${p.title}\n(${pageURL(p.slug)})\n`;
  if (p.subtitle) full += `\n${p.subtitle}\n`;
  full += `\n${textify(p.body)}\n`;
}
writeFileSync(join(ROOT, "llms-full.txt"), full);
console.log("wrote llms-full.txt");

// Per-page Markdown alternate: emit an index.md beside each page's index.html
// so an agent landing on ONE doc page (via search or a link) can fetch just
// that page as authored markdown — advertised via the <link rel="alternate"
// type="text/markdown"> in each page head — instead of scraping the bloated
// HTML or pulling the whole llms-full.txt. Reuses the same textify() the
// llms-full build uses, so the per-page markdown stays in lockstep with the
// site (a page added above is picked up automatically via EMITTED).
for (const p of EMITTED) {
  const dir = p.slug === "" ? join(ROOT, "docs") : join(ROOT, "docs", p.slug);
  mkdirSync(dir, { recursive: true });
  let md = `# ${p.title}\n`;
  if (p.subtitle) md += `\n> ${p.subtitle}\n`;
  md += `\n${textify(p.body)}\n\n---\nCanonical page: ${pageURL(p.slug)} · Full docs index: ${SITE}/llms.txt\n`;
  writeFileSync(join(dir, "index.md"), md);
}
console.log("wrote per-page index.md (" + EMITTED.length + " pages)");

console.log("done.");
