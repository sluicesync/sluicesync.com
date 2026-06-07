// Static docs generator for sluicesync.com.
// Output is plain HTML committed to the repo — GitHub Pages serves it as-is
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
          ["sync-from-backup", "sync from-backup"],
          ["cutover", "cutover"],
          ["backup", "backup"],
          ["restore", "restore"],
          ["trigger", "trigger setup"],
          ["schema", "schema preview / diff"],
          ["verify", "verify"],
          ["matview", "matview refresh"],
          ["slot", "slot list / drop"],
          ["diagnose", "diagnose"],
        ],
      },
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
  const top =
    '<a class="' + (slug === "getting-started" || slug === "configuration" || slug === "commands" || slug === "" ? "active" : "") + '" href="/docs/">Docs</a>';
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
    subtitle: "Migrate and continuously sync MySQL and Postgres — correctness-first, loud failure by default.",
    body: `
<p>sluice is an open-source tool for moving and keeping databases in sync between <strong>MySQL</strong> and
<strong>Postgres</strong>, in all four directions. It is built around three surfaces you can use independently or end to end:</p>
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
  <li>Engines available out of the box: <code>mysql</code>, <code>postgres</code>, and the <code>planetscale</code> MySQL flavor. Run <code>sluice engines</code> to confirm what your binary supports.</li>
  <li>For continuous sync from Postgres, the source normally needs logical replication (a replication slot). Managed Postgres that blocks slots (e.g. Heroku) can use the slot-less <a href="/docs/commands/#trigger">trigger engine</a> instead.</li>
</ul>

<h2 id="connecting">Connecting to your databases</h2>
<p>Source and target are passed as DSNs (connection strings). The driver is named separately with <code>--source-driver</code> / <code>--target-driver</code>.</p>
<table>
<thead><tr><th>Engine</th><th>DSN format</th></tr></thead>
<tbody>
<tr><td><code>mysql</code></td><td><code>user:pass@tcp(host:3306)/dbname</code></td></tr>
<tr><td><code>postgres</code></td><td><code>postgres://user:pass@host:5432/dbname?sslmode=require</code></td></tr>
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

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/commands/">Command reference</a> — the full flag set for every command.</li>
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

<h2 id="engines">engines</h2>
${cmd("engines", "sluice engines", "List the database engines built into this binary and their bulk-load / CDC capabilities.", pre(`sluice engines`))}

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
  <tr><td><code>--resume</code>, <code>-r</code></td><td class="desc">Resume a failed migration from per-table checkpoints on the target.</td></tr>
  <tr><td><code>--bulk-parallelism</code></td><td class="desc">Parallel reader/writer pairs per large table (0 = auto).</td></tr>
  <tr><td><code>--type-override</code></td><td class="desc"><code>TABLE.COLUMN=TYPE</code> — force a target column type (repeatable).</td></tr>
  <tr><td><code>--redact</code></td><td class="desc">Redact a PII column, e.g. <code>users.email=hash:sha256</code> (repeatable).</td></tr>
  <tr><td><code>--target-schema</code></td><td class="desc">Postgres-only: land tables under a named schema namespace.</td></tr>
  <tr><td><code>--reset-target-data</code></td><td class="desc">Destructive recovery: drop source-schema tables on the target, then cold-start. Prompts unless <code>--yes</code>.</td></tr>
  </tbody></table>
  <p><strong>Filtered dry run, then apply:</strong></p>
  ${pre(`sluice migrate --source-driver mysql --source ... --target-driver postgres --target ... \\
    --include-table 'app_*' --exclude-table 'app_audit' --dry-run`)}
  <p><strong>Redact PII as it copies:</strong></p>
  ${pre(`sluice migrate --source-driver mysql --source ... --target-driver postgres --target ... \\
    --redact users.email=hash:sha256 \\
    --redact users.ssn=mask:ssn`)}
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
  <tr><td><code>--apply-batch-size</code></td><td class="desc">CDC changes per target tx, or <code>auto</code>. Default <code>1</code> (conservative); higher engages the AIMD latency controller.</td></tr>
  <tr><td><code>--metrics-listen</code></td><td class="desc">Bind a Prometheus <code>/metrics</code> + <code>/readyz</code> endpoint, e.g. <code>:9090</code>.</td></tr>
  <tr><td><code>--source-heartbeat-interval</code></td><td class="desc">Write a heartbeat row on the source every interval so the slot/binlog can't be evicted past the consumer against an idle source.</td></tr>
  <tr><td><code>--dry-run</code>, <code>-n</code></td><td class="desc">Show cold-start vs warm-resume and the planned actions without starting.</td></tr>
  <tr><td><code>--schema-already-applied</code></td><td class="desc">Skip all cold-start DDL (you promise the target catalog matches). For Atlas/Liquibase-managed or PlanetScale Safe-Migrations targets.</td></tr>
  <tr><td><code>--include-table</code> / <code>--exclude-table</code></td><td class="desc">Glob-aware table filters (mutually exclusive). Scope the cold-start snapshot <em>and</em> its resume — including the PlanetScale (VStream) snapshot, so an excluded table in a large keyspace is never streamed (v0.99.12–v0.99.13), not just the write path.</td></tr>
  <tr><td><code>--restart-from-scratch</code></td><td class="desc">Force a fresh cold-start re-copy from the beginning, ignoring any persisted resume position (incl. a mid-COPY cursor) — <em>without</em> dropping the target (the idempotent copy absorbs the overlap). For a bad checkpoint. Differs from <code>--force-cold-start</code> (keeps the position) and <code>--reset-target-data</code> (drops tables). (v0.99.10)</td></tr>
  </tbody></table>
  <p><strong>Run as a service with metrics + idle-source heartbeat:</strong></p>
  ${pre(`sluice sync start --source-driver postgres --source ... --target-driver mysql --target ... \\
    --stream-id reporting \\
    --metrics-listen :9090 \\
    --source-heartbeat-interval 30s`)}`
)}

<h2 id="sync-manage">sync status / stop / health</h2>
${cmd(
  "sync-manage-c",
  "sluice sync status · stop · health",
  "Inspect, gracefully stop, and health-check a running stream. All take --stream-id plus the target connection.",
  `<ul>
   <li><code>sync status</code> — show the stream's persisted position and phase.</li>
   <li><code>sync stop</code> — request the stream to drain in-flight changes and exit cleanly.</li>
   <li><code>sync health</code> — probe freshness against thresholds and return a cron-friendly exit code (non-zero when stale).</li>
   </ul>
   ${pre(`sluice sync health --stream-id app-prod --target-driver postgres --target ... \\
    --max-lag 5m   # exit non-zero if the stream is more than 5 minutes behind`)}`
)}

<h2 id="sync-from-backup">sync from-backup</h2>
${cmd(
  "sync-from-backup-c",
  "sluice sync from-backup run · stop",
  "Replay a backup chain into a target as a long-running broker — polls a chain root (S3/GCS/Azure/local) for new incrementals and applies them. No direct source↔target connectivity required.",
  `${pre(`sluice sync from-backup run \\
    --backup-target s3://my-bucket/app-chain \\
    --target-driver postgres --target ... \\
    --stream-id app-broker --poll-interval 30s

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
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--full</code></td><td class="desc">Take a full snapshot (chain root).</td></tr>
  <tr><td><code>--incremental</code></td><td class="desc">Append an incremental onto the existing chain.</td></tr>
  <tr><td><code>--stream</code></td><td class="desc">Run as a long-lived process appending incrementals continuously.</td></tr>
  <tr><td><code>--verify</code></td><td class="desc">Verify a backup / chain integrity.</td></tr>
  <tr><td><code>--prune</code> / <code>--compact</code></td><td class="desc">Retention: drop or compact old chain segments.</td></tr>
  <tr><td><code>--include-table</code> / <code>--exclude-table</code></td><td class="desc">Glob-aware table filters; scope the backup snapshot itself — including the PlanetScale (VStream) snapshot — so an excluded table in a large keyspace is never streamed (v0.99.13), not just what's written.</td></tr>
  </tbody></table>
  ${pre(`sluice backup --full --source-driver postgres --source ... --backup-target s3://my-bucket/app-chain
sluice backup --incremental --source-driver postgres --source ... --backup-target s3://my-bucket/app-chain`)}`
)}

<h2 id="restore">restore</h2>
${cmd(
  "restore-c",
  "sluice restore",
  "Restore a logical backup chain (full + every incremental up to the tail) into a target database.",
  `${pre(`sluice restore --from s3://my-bucket/app-chain \\
    --target-driver postgres --target ...`)}
   <p>Pair with <a href="/docs/commands/#sync-start">sync start</a> <code>--resume-from-backup</code> to resume CDC from the chain's tail without re-bulking.</p>`
)}

<h2 id="trigger">trigger setup</h2>
${cmd(
  "trigger-c",
  "sluice trigger setup",
  "Install (or remove) the postgres-trigger engine's source-side state — slot-less CDC for managed Postgres that blocks logical replication.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--dsn</code></td><td class="desc">Source Postgres DSN to install the trigger state into.</td></tr>
  <tr><td><code>--tables</code></td><td class="desc">Tables to capture (default: all).</td></tr>
  <tr><td><code>--allow-polled-fingerprint</code></td><td class="desc">Permit the non-superuser polled path when event triggers aren't grantable (e.g. Heroku).</td></tr>
  <tr><td><code>--capture-payload</code></td><td class="desc"><code>full</code> (default) / <code>changed</code> / <code>minimal</code> — how much of each row the trigger records.</td></tr>
  </tbody></table>
  ${pre(`sluice trigger setup --dsn 'postgres://user:pass@host:5432/app' --allow-polled-fingerprint
# then stream with the trigger engine:
sluice sync start --source-driver postgres-trigger --source ... --target-driver mysql --target ... --stream-id app`)}`
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
  <tr><td><code>--depth</code></td><td class="desc">How thorough: counts vs sampled-row vs full hash comparison.</td></tr>
  <tr><td><code>--sample-rows-per-table</code> / <code>--sample-seed</code></td><td class="desc">Sampling size and a deterministic seed.</td></tr>
  <tr><td><code>--strict-hash</code></td><td class="desc">Require byte-identical per-row hashes.</td></tr>
  <tr><td><code>--format</code> / <code>--output</code></td><td class="desc">Report format and output destination (for CI gating).</td></tr>
  </tbody></table>
  ${pre(`sluice verify --source-driver mysql --source ... --target-driver postgres --target ... --depth counts`)}`
)}

<h2 id="matview">matview refresh</h2>
${cmd(
  "matview-c",
  "sluice matview refresh",
  "Refresh PostgreSQL materialized views on the target (PG-only). Handy as a scheduled job after a sync catches up.",
  pre(`sluice matview refresh --target-driver postgres --target ... --view reporting.daily_totals`)
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
  pre(`sluice diagnose --source-driver mysql --source ... --target-driver postgres --target ... --out ./sluice-diagnose.zip`)
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
<tr><td>Postgres (slot-less)</td><td><code>postgres-trigger</code></td><td>Same as <code>postgres</code>; pairs with <a href="/docs/commands/#trigger">trigger setup</a>.</td></tr>
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
<tr><td><code>--pprof-listen</code></td><td>off</td><td class="desc">Bind net/http/pprof at an address to diagnose stalls (e.g. <code>:6060</code>).</td></tr>
<tr><td><code>--mysql-sql-mode</code></td><td>strict</td><td class="desc">Override sluice's forced strict <code>sql_mode</code>. Pass <code>''</code> (empty) to migrate legacy MySQL data with zero-dates.</td></tr>
<tr><td><code>--max-memory</code></td><td>off</td><td class="desc">Soft ceiling on the Go heap (e.g. <code>2GiB</code>, <code>512MiB</code>), applied via <code>SetMemoryLimit</code> at startup to bound RSS. Unlike <code>--max-buffer-bytes</code> (raw buffered bytes only), this bounds the whole heap. Honors the <code>GOMEMLIMIT</code> env var when unset. (v0.99.10)</td></tr>
<tr><td><code>--version</code>, <code>-V</code></td><td>—</td><td class="desc">Print version and exit.</td></tr>
</tbody>
</table>

<div class="note warn"><strong>Migrating legacy MySQL data?</strong> sluice forces a strict <code>sql_mode</code> on every MySQL connection to close the silent-clamp / silent-zero-date class. Data that was only accepted under a relaxed mode (pre-5.7 zero-dates, silently-truncated values) will refuse loudly — pass <code>--mysql-sql-mode=''</code> to fall through to the server default.</div>
`,
    prev: { href: "/docs/commands/", label: "Command reference" },
  })
);

console.log("done.");
