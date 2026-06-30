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
      { slug: "preview-and-validate", label: "Preview & validate before you migrate" },
      { slug: "zero-downtime-cutover", label: "Zero-downtime migration (continuous sync)" },
      { slug: "import-sqlite-d1", label: "Import SQLite or Cloudflare D1" },
      { slug: "multi-database", label: "Migrate many databases or schemas" },
      { slug: "from-backup-sync", label: "Sync from a backup chain" },
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

function page({ slug, title, subtitle, body, prev, next }) {
  const desc = subtitle || "sluice documentation";
  const guideSlugs = [
    "from-backup-sync",
    "migrate-mysql-to-postgres",
    "preview-and-validate",
    "zero-downtime-cutover",
    "import-sqlite-d1",
    "multi-database",
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
    ${body}
    ${pager}
  </main>
</div>
<footer class="foot">Apache 2.0 · <a href="https://github.com/sluicesync/sluice">github.com/sluicesync/sluice</a> · <code>go install sluicesync.dev/sluice/cmd/sluice@latest</code></footer>
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
  <tr><td><code>sqlite</code></td><td class="desc">migrate <strong>source</strong> (file or <code>.sql</code> dump) <strong>and target</strong></td><td class="desc">Pure-Go <code>modernc.org/sqlite</code>, no CGO. Imports a binary <code>.db</code> or an auto-detected <code>wrangler d1 export</code> <code>.sql</code> dump into Postgres / MySQL; as a target emits a <code>.db</code> (decimals byte-exact as <code>TEXT</code>). Migrate only (no CDC).</td></tr>
  <tr><td><code>d1</code></td><td class="desc">migrate <strong>source</strong> (live, lossless)</td><td class="desc">Reads a live Cloudflare D1 over its HTTP query API (token via <code>CLOUDFLARE_API_TOKEN</code>); per-column <code>typeof()</code> + <code>CAST(… AS TEXT)</code> / <code>hex()</code> projection makes integers above 2<sup>53</sup> and BLOBs round-trip exactly, and reads don't take D1 offline (ADR-0132).</td></tr>
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
  <tr><td><code>--infer-types</code></td><td class="desc">SQLite / D1 source only (ADR-0144): opt-in, <strong>data-validated</strong> promotion of conservatively-typed columns to native target types — <code>INTEGER</code>→<code>boolean</code>, ISO-8601 <code>TEXT</code>→<code>timestamptz</code>/<code>timestamp</code>, JSON <code>TEXT</code>→<code>jsonb</code>, UUID <code>TEXT</code>→<code>uuid</code> — but only after an exhaustive aggregate over the actual data confirms <em>every</em> value qualifies; otherwise the column keeps its safe type. Mixed-offset / sub-µs temporal columns and non-UUID <code>*_id</code> values stay <code>text</code>, never silently coerced. An explicit <code>--type-override</code> always wins. Off by default.</td></tr>
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
    next: { href: "/docs/preview-and-validate/", label: "Preview & validate" },
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
    prev: { href: "/docs/migrate-mysql-to-postgres/", label: "Migrate MySQL → Postgres" },
    next: { href: "/docs/zero-downtime-cutover/", label: "Zero-downtime migration" },
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
    prev: { href: "/docs/preview-and-validate/", label: "Preview & validate" },
    next: { href: "/docs/import-sqlite-d1/", label: "Import SQLite or Cloudflare D1" },
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
    prev: { href: "/docs/zero-downtime-cutover/", label: "Zero-downtime migration" },
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
    next: { href: "/docs/from-backup-sync/", label: "Sync from a backup chain" },
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
    prev: { href: "/docs/multi-database/", label: "Migrate many databases or schemas" },
    next: { href: "/docs/commands/", label: "Command reference" },
  })
);

console.log("done.");
