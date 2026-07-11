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

// ---- routing ------------------------------------------------------------
// Field Notes live at their OWN top-level route (/field-notes/...), not under
// /docs/. A page is a field note when its slug is the landing ("field-notes")
// or is prefixed "field-notes/". These helpers keep every URL/path derivation
// (page links, markdown-alternate, llms.txt, on-disk output) in one place so
// docs and field notes can diverge without scattering `/docs/` assumptions.
const isFieldNote = (slug) => slug === "field-notes" || slug.startsWith("field-notes/");
// Public URL path for a page's HTML.
const pagePath = (slug) => (slug === "" ? "/docs/" : isFieldNote(slug) ? "/" + slug + "/" : "/docs/" + slug + "/");
// Public URL path for a page's Markdown alternate (index.md).
const pageMdPath = (slug) => (slug === "" ? "/docs/index.md" : isFieldNote(slug) ? "/" + slug + "/index.md" : "/docs/" + slug + "/index.md");

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
    group: "General Guides",
    items: [
      { slug: "migrate-mysql-to-postgres", label: "Migrate MySQL → Postgres" },
      { slug: "preview-and-validate", label: "Preview & validate before you migrate" },
      { slug: "verify-reconcile", label: "Verify & reconcile" },
      { slug: "zero-downtime-cutover", label: "Zero-downtime migration (continuous sync)" },
      { slug: "schema-changes", label: "Schema changes during a sync" },
      { slug: "redact-pii", label: "Redact PII" },
      { slug: "import-sqlite-d1", label: "Import SQLite or Cloudflare D1" },
      { slug: "multi-database", label: "Migrate many databases or schemas" },
      { slug: "copy-table-subset", label: "Copy a subset of tables" },
      { slug: "postgres-source-prep", label: "Prepare a Postgres source" },
      { slug: "managed-postgres-slotless", label: "Managed Postgres (slot-less)" },
      { slug: "operate-fleet", label: "Operate a sync fleet" },
      { slug: "encrypted-backups", label: "Take encrypted backups" },
      { slug: "from-backup-sync", label: "Sync from a backup chain" },
      { slug: "agent-skills", label: "Drive sluice from an AI agent" },
    ],
  },
  {
    group: "PlanetScale Guides",
    items: [
      { slug: "planetscale-vitess", label: "PlanetScale & Vitess" },
      { slug: "mysql-to-planetscale", label: "Self-hosted MySQL → PlanetScale" },
      { slug: "foreign-keys-vitess", label: "Foreign keys on Vitess" },
      { slug: "planetscale-postgres", label: "PlanetScale Postgres" },
      { slug: "planetscale-postgres-upgrade", label: "Upgrade PlanetScale Postgres" },
      { slug: "planetscale-postgres-analytics-replica", label: "PlanetScale Postgres analytics replica" },
      { slug: "planetscale-region-move", label: "Move PlanetScale regions" },
    ],
  },
  {
    group: "Reference",
    items: [
      { slug: "supported-directions", label: "Supported directions" },
      { slug: "how-sluice-copies", label: "How sluice copies your data" },
      {
        slug: "commands",
        label: "Command reference",
        subs: [
          ["engines", "engines"],
          ["migrate", "migrate"],
          ["sync-start", "sync start"],
          ["sync-manage", "sync status / stop / health"],
          ["sync-fleet", "sync run / sync tui"],
          ["schema-add-table", "schema add-table"],
          ["sync-from-backup", "sync from-backup"],
          ["cutover", "cutover"],
          ["backup", "backup"],
          ["restore", "restore"],
          ["trigger", "trigger setup / teardown"],
          ["trigger-prune", "trigger prune"],
          ["schema", "schema preview / diff"],
          ["verify", "verify"],
          ["matview", "matview refresh"],
          ["slot", "slot list / drop"],
          ["diagnose", "diagnose"],
        ],
      },
      { slug: "error-codes", label: "Error & exit codes" },
      { slug: "type-mapping", label: "Type mapping" },
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

// ---- Field Notes: data model --------------------------------------------
// Single source of truth for the field-notes SECTION — drives the chronological
// sidebar, the landing list, the prev/next pager, and the llms.txt entries.
// Ordered CHRONOLOGICALLY (oldest → newest) by roughly when the work landed in
// sluice; the sidebar/landing/pager present it NEWEST-FIRST. `date` is the
// authoritative landed-date (from the fix's git tag); `dek` is the one-line
// landing summary. Slugs are bare (no "field-notes/" prefix) — the section
// route prepends it. Add a note here and it appears everywhere automatically.
const FIELD_NOTES = [
  { slug: "mysql-json-where-cast", date: "2026-05-04", engine: "MySQL & Vitess", label: "MySQL won't match a JSON column by bind parameter", dek: "<code>WHERE json_col = ?</code> matches zero rows whether you bind the value as a string or as bytes &mdash; MySQL won't cast the parameter to JSON. On a CDC UPDATE, replay-idempotency tolerance turns the zero-row match into silent divergence." },
  { slug: "mysql-load-data-charset", date: "2026-05-05", engine: "MySQL & Vitess", label: "One LOAD DATA can't load a BLOB and a JSON column", dek: "A <code>BLOB</code> needs <code>CHARACTER SET binary</code> or the server rejects its first non-ASCII byte; a <code>JSON</code> column rejects its input <em>under</em> <code>CHARACTER SET binary</code>. One statement-level clause, two columns that demand opposite answers." },
  { slug: "binlog-temporal-strings", date: "2026-05-05", engine: "MySQL & Vitess", label: "parseTime governs the query protocol, not the binlog", dek: "<code>parseTime=true</code> on the DSN makes the <em>query</em> driver return <code>time.Time</code> — but the replication stream hands temporal columns back as raw strings regardless. The first <code>TIMESTAMP</code> row killed the CDC pump, and the silent-channel-close looked exactly like a network stall for two release cycles." },
  { slug: "postgres-idle-slot-failover", date: "2026-05-07", engine: "Postgres", label: "Every HA knob on, and the slot still vanished at failover", dek: "Patroni slot-sync on, <code>sync_replication_slots</code> on, <code>hot_standby_feedback</code> on &mdash; and a logical slot that hadn't advanced during the sync window was still lost on promotion. The idle slot is the fragile one." },
  { slug: "binlog-event-volume", date: "2026-05-08", engine: "MySQL & Vitess", label: "One INSERT is three binlog events (or four)", dek: "A single-row <code>INSERT</code> lands in the binlog as three events (BEGIN / WRITE_ROWS / XID), plus a spurious empty BEGIN/COMMIT per new connection. If you size a rollover bound by INSERT count, budget 4&times; &mdash; and Postgres counts differently again." },
  { slug: "empty-object-vs-array", date: "2026-05-10", engine: "Cross-cutting", label: "{}: two characters, two types", dek: "<code>{}</code> is an empty array in Postgres and an empty object in JSON; <code>[]byte(\"{}\")</code> is genuinely ambiguous, and for nine releases the MySQL writer resolved it the wrong way." },
  { slug: "batch-by-bytes-not-rows", date: "2026-05-15", engine: "Cross-cutting", label: "Count your bytes, not your rows", dek: "A batch size tuned for narrow OLTP rows &mdash; 5,000 rows, under 10&nbsp;MB &mdash; quietly pins hundreds of MB the moment the workload is MB-scale TEXT, BYTEA, JSON, or geometry. The streaming paths were fine; only the two accumulators blew up." },
  { slug: "numeric-array-flatten", date: "2026-05-17", engine: "Postgres", label: "The pgx codec that flattened numeric[][]", dek: "A driver that selects its binary codec per target OID turned a 2&times;2 matrix into a flat four-element array, on byte-identical code that round-tripped <code>int[][]</code> perfectly." },
  { slug: "mysql-bit-wire-bytes", date: "2026-05-20", engine: "Cross-cutting", label: "BIT crosses the wire as bytes, and the engines disagree on layout", dek: "MySQL hands <code>BIT(N)</code> back as <code>ceil(N/8)</code> right-justified big-endian bytes; Postgres surfaces <code>bit</code> as a <code>'0'</code>/<code>'1'</code> text string. Carry the raw bytes between them and the value is silently corrupted &mdash; the ASCII of the digits, not the bits." },
  { slug: "postgres-lsn-timeline-scoped", date: "2026-05-22", engine: "Postgres", label: "A Postgres LSN means nothing without its timeline", dek: "Resume a logical-replication slot after a PITR or a promotion and the same LSN points into a different WAL reference frame &mdash; the source streams from it happily and events are silently skipped. MySQL gets this right for free with GTIDs; Postgres's raw LSN carries no provenance." },
  { slug: "pgoutput-streaming-abort", date: "2026-05-23", engine: "Postgres", label: "proto_version lets you parse streaming; only streaming='on' emits it", dek: "Two pgoutput knobs are easy to conflate, and the gap between them hides a silent-loss shape: if streaming ever activates and each chunk commits as its own transaction, a dropped StreamAbort leaves the pre-abort rows durably on the target &mdash; extra rows no checksum diff will catch." },
  { slug: "create-if-not-exists-race", date: "2026-05-24", engine: "Postgres", label: "CREATE IF NOT EXISTS is not a lock", dek: "<code>CREATE TABLE/TYPE … IF NOT EXISTS</code> does a catalog pre-check and then an insert, and the two steps aren't atomic. Race the same name from two connections and one gets a <code>unique_violation</code> on <code>pg_class</code> &mdash; from the statement that reads like it can't fail." },
  { slug: "cdc-carries-no-default", date: "2026-05-25", engine: "Cross-cutting", label: "The replication stream never tells you the column default", dek: "Neither pgoutput nor the MySQL binlog carries a column's DEFAULT. Forward an <code>ADD COLUMN … DEFAULT now()</code> over CDC and the target re-evaluates the default independently &mdash; so every pre-existing row gets a <em>different</em> value than the source's backfill." },
  { slug: "replica-identity-full-updates", date: "2026-05-28", engine: "Postgres", label: "REPLICA IDENTITY FULL ate our UPDATEs", dek: "Building an UPDATE's <code>WHERE</code> over every old column works forever on int/varchar, then a <code>jsonb</code> value fails the equality round-trip, the UPDATE matches zero rows, and idempotency tolerance swallows the miss." },
  { slug: "redact-two-engines", date: "2026-05-30", engine: "Cross-cutting", label: "One redaction flag, two engines, two behaviors", dek: "<code>--redact randomize:int:100000,200000</code> into a SMALLINT column loud-refused on a Postgres target and silently clamped <em>every</em> row to <code>32767</code> on a MySQL one &mdash; turning an anonymization rule into a constant, and a compliance guarantee into a compliance failure." },
  { slug: "mysql-enum-emoji", date: "2026-05-30", engine: "MySQL & Vitess", label: "MySQL turned our emoji into '?'", dek: "MySQL substitutes <code>?</code> for 4-byte UTF-8 in ENUM/SET <em>labels</em> at CREATE TABLE time regardless of column charset; the label is gone from the catalog before any client sees it." },
  { slug: "mysql-time-is-a-duration", date: "2026-05-31", engine: "MySQL & Vitess", label: "MySQL TIME is a duration, not a time of day", dek: "A MySQL <code>TIME</code> ranges <code>-838:59:59</code> to <code>838:59:59</code> and models elapsed duration, not clock time. Map it to Postgres <code>time</code> by name and any negative or over-24-hour value has nowhere to go &mdash; the target is <code>interval</code>." },
  { slug: "postgres-text-no-nul-byte", date: "2026-06-02", engine: "Postgres", label: "Postgres text can't hold a NUL byte", dek: "<code>text</code>/<code>varchar</code>/<code>char</code> reject an embedded <code>0x00</code> with SQLSTATE 22021; MySQL char/text store it fine. Over COPY the rejection surfaces far from the offending row and reads cryptically &mdash; and stripping the byte would be silent corruption." },
  { slug: "snapshot-position-gap", date: "2026-06-03", engine: "MySQL & Vitess", label: "The transaction that lands in neither the snapshot nor the binlog", dek: "Capture the consistent snapshot and the binlog position as two separate statements, and a transaction committing between them falls into the gap &mdash; after the frozen read view, below the recorded offset. It's in neither the copy nor the CDC tail. FLUSH TABLES WITH READ LOCK closes the seam." },
  { slug: "olap-workload-truncation", date: "2026-06-07", engine: "MySQL & Vitess", label: "Setting workload=olap silently truncated our chunked reads", dek: "A one-line fix to lift vtgate's 100k-row cap set <code>workload=olap</code> session-wide; the parallel chunked reader inherited it and each chunk streamed only a prefix, so a 1.5M-row migrate copied 7,536 rows and exited 0 with <code>migration complete</code>." },
  { slug: "bigint-unsigned-uint64", date: "2026-06-08", engine: "MySQL & Vitess", label: "BIGINT UNSIGNED overflows both bigint and int64", dek: "A MySQL <code>BIGINT UNSIGNED</code> reaches 2&sup6;&#8308;&minus;1, past Postgres <code>bigint</code>'s 2&sup6;&sup3;&minus;1 &mdash; and past Go's <code>int64</code>, so the driver hands it back as a <code>uint64</code> that a <code>[]byte</code>/<code>string</code>-only decoder can't route into a <code>numeric</code> or <code>text</code> target. Even the documented recovery was broken." },
  { slug: "vstream-snapshot-oom", date: "2026-06-09", engine: "MySQL & Vitess", label: "The cold-start that buffered a whole table into swap", dek: "A 13&nbsp;GB PlanetScale table drove the process to ~41&nbsp;GB of RAM and got OOM-killed with zero rows written &mdash; because the VStream snapshot reader held the entire copy phase in memory. The buffer wasn't laziness; three engine behaviors forced it." },
  { slug: "migrate-state-quadratic-blob", date: "2026-06-10", engine: "Cross-cutting", label: "One JSON blob in one row is a quadratic write", dek: "Storing all per-table progress as a single growing JSON blob, re-upserted on every checkpoint, is O(n&sup2;) &mdash; and on Postgres the amplification lands somewhere specific: a new tuple version plus a re-TOAST of the whole value, every time, on one hot row." },
  { slug: "backup-manifest-quadratic", date: "2026-06-11", engine: "Cross-cutting", label: "Rewriting the whole manifest, once per chunk", dek: "Every backup checkpoint re-wrote the entire manifest.json &mdash; and since the manifest grows with table count, the total work was quadratic: a measured ~78 hours at 100k tables. The fix's two obvious cousins are the same quadratic in disguise." },
  { slug: "postgres-slot-leaks", date: "2026-06-11", engine: "Postgres", label: "Replication slots don't die with your process", dek: "A slot is a promise the server keeps until you drop it; a crashed backup, a refused cold-start, and a week-one leak each pinned WAL on the source until the disk filled." },
  { slug: "binlog-comment-truncate", date: "2026-06-13", engine: "MySQL & Vitess", label: "A comment hid a TRUNCATE from CDC", dek: "A leading <code>-- comment</code> on a <code>TRUNCATE</code> made a CDC reader miss it entirely; the source emptied, the target kept every row, forever." },
  { slug: "vstream-throttle-blind", date: "2026-06-13", engine: "MySQL & Vitess", label: "vtgate erases the throttle signal", dek: "The one in-band flag that says &ldquo;this stream is throttled, wait&rdquo; is deleted before any gRPC client can see it, so a throttled stream is indistinguishable from a hung one." },
  { slug: "zero-value-config-trap", date: "2026-06-15", engine: "Cross-cutting", label: "The zero value is a loaded gun", dek: "A config field that &ldquo;defaults on&rdquo; silently defaults <em>off</em> for every caller that didn't go through the CLI, because in Go every unset field gets the zero value. Twice, with real database consequences." },
  { slug: "binlog-transaction-compression", date: "2026-06-17", engine: "MySQL & Vitess", label: "A whole transaction in one zstd binlog event", dek: "MySQL 8.0.20+ can pack an entire transaction into a single compressed <code>TRANSACTION_PAYLOAD_EVENT</code>. A reader without a handler applies nothing and freezes its position with no error &mdash; and the server zeroes the inner events' <code>end_log_pos</code>, so a naive resume restarts mid-payload and dies." },
  { slug: "vitess-per-shard-primary-key", date: "2026-06-18", engine: "MySQL & Vitess", label: "Your primary key is only unique per shard", dek: "vtgate merges every Vitess/PlanetScale shard into one logical stream, but per-shard id ranges mean the same primary-key value legitimately exists on several shards. Copy them into one target table and the collisions silently overwrite &mdash; exit 0, rows short." },
  { slug: "mysql-enum-set-binlog-encoding", date: "2026-06-20", engine: "MySQL & Vitess", label: "ENUM is an ordinal and SET is a bitmask on the wire", dek: "In a raw binlog row event a MySQL <code>ENUM</code> is its 1-based ordinal and a <code>SET</code> is a numeric bitmask; the member-name list lives only in the table definition. Decode without the schema and <code>SET('a','c')</code> becomes <code>&quot;5&quot;</code>. Snapshot and VStream hand you text, so it hides until raw CDC." },
  { slug: "poll-cost-grows-with-history", date: "2026-06-22", engine: "Cross-cutting", label: "A poller that re-reads all of history every tick", dek: "A backup broker rebuilt its entire lineage chain on every 30-second tick &mdash; ~2,000 object-store GETs per tick on a week-old stream, even when nothing had changed, with a tick that could outlast its own interval. Cost that grows with accumulated history, forever." },
  { slug: "sqlite-decimal-affinity", date: "2026-06-27", engine: "SQLite & D1", label: "SQLite's DECIMAL is a suggestion", dek: "Declare a column <code>DECIMAL(10,2)</code> and you get NUMERIC affinity, which stores <code>19.99</code> as <code>19.989999999999998</code>. Not a rounding bug — an engine storage property, and the real predicate is dyadic representability." },
  { slug: "sqlite-wal-checkpoint-starvation", date: "2026-06-28", engine: "SQLite & D1", label: "One long-lived reader, 75 GB of WAL", dek: "A continuous-CDC run watched the <code>-wal</code> file grow to 75 GB in 52 minutes while the table it tracked stayed bounded; one idle reader's snapshot pinned every superseded page. Kill the process and it collapsed to ~0.6 GB." },
  { slug: "vitess-tx-killer-wan", date: "2026-06-28", engine: "MySQL & Vitess", label: "The 20-second guillotine over a WAN", dek: "With no statement pipelining, an N-row apply costs N round-trips; every batch big enough to be efficient overran Vitess's 20&nbsp;s timeout and every batch small enough to commit crawled. A self-tuning system converged to a stall." },
  { slug: "int64-json-boundary", date: "2026-06-29", engine: "Cross-cutting", label: "2^53 is a database boundary now", dek: "JSON has one number type and it's a double, so every JSON hop in a pipeline is a potential rounding event for Snowflake IDs and any integer past 9,007,199,254,740,992." },
  { slug: "planetscale-grow-reparent", date: "2026-06-29", engine: "MySQL & Vitess", label: "When PlanetScale un-acked our rows", dek: "Committed, client-acknowledged rows that simply weren't on the new primary after a volume-grow reparent. Exit 0, ~4,000 rows short." },
  { slug: "d1-not-local-sqlite", date: "2026-06-30", engine: "SQLite & D1", label: "Cloudflare D1 is not your local SQLite", dek: "A UUID-conformance <code>GLOB</code> passed every local test, then died on live D1 with <code>code 7500: LIKE or GLOB pattern too complex</code>. The dialect is the same; the hidden limits are a config surface you can't test against locally." },
  { slug: "xid-wraparound-cdc", date: "2026-07-08", engine: "Postgres", label: "Comparing 32-bit transaction ids breaks after four billion of them", dek: "A trigger-CDC hold-back compared a change row's 32-bit <code>xmin</code> against a 64-bit <code>xid8</code> snapshot bound. At XID epoch 0 they agree; past 2<sup>32</sup> lifetime transactions the predicate goes always-true and silently skips an in-flight transaction's rows." },
  { slug: "vstream-float-precision", date: "2026-07-09", engine: "MySQL & Vitess", label: "Vitess copy phase rounds your FLOATs", dek: "A 17-year-old MySQL display-rounding bug with a fresh consequence: the same <code>FLOAT</code> arrives exact or rounded depending on which VStream phase delivered it." },
  { slug: "three-clouds-three-signatures", date: "2026-07-09", engine: "Cross-cutting", label: "Three clouds, three ways to return an ECDSA signature", dek: "AWS and GCP hand back an ECDSA signature as ASN.1 DER; Azure returns raw <code>r&#8214;s</code>. Only GCP signs Ed25519, and only GCP wants a CRC32C integrity handshake in both directions. &ldquo;KMS signing&rdquo; is not one API." },
  { slug: "signed-manifest-chunk-binding", date: "2026-07-09", engine: "Cross-cutting", label: "A signature that verified green while restoring the wrong table's rows", dek: "A signed backup flattened every table's row chunks into one file-sorted list with no parent-table token, so swapping two same-column-set tables' chunk lists produced byte-identical signed bytes &mdash; every guard green, and table B's rows restored into table A." },
  { slug: "float-in-primary-key", date: "2026-07-09", engine: "MySQL & Vitess", label: "When the row's own identity gets rounded", dek: "The VStream FLOAT repair re-reads exactly and matches by primary key &mdash; but when the FLOAT is <em>in</em> the key, the target's identity is itself rounded, so the match never lands, the repair silently no-ops, and <code>--strict-float</code> exits 0 with a rounded archive." },
  { slug: "cdc-position-leads-or-trails", date: "2026-07-10", engine: "Cross-cutting", label: "A CDC position can lead or trail the rows it covers", dek: "Postgres and MySQL put a schema/DDL position <em>before</em> the rows it introduces; Vitess stamps its VGTID <em>after</em> the rows the commit covers, so a snapshot and its transaction's rows can share one token. A &ldquo;did we reach the boundary?&rdquo; check that's sound on one engine silently false-negatives on the other." },
];

// Newest-first, indexed by full "field-notes/<slug>".
const FIELD_NOTES_NEWEST = [...FIELD_NOTES].reverse();
const fnBySlug = new Map(FIELD_NOTES.map((n) => ["field-notes/" + n.slug, n]));
// Pager sequence: landing first, then notes newest → oldest. `prev` walks toward
// newer (and the landing); `next` walks toward older.
const FN_SEQUENCE = ["field-notes", ...FIELD_NOTES_NEWEST.map((n) => "field-notes/" + n.slug)];
const fnLabel = (fullSlug) => (fullSlug === "field-notes" ? "About these notes" : fnBySlug.get(fullSlug).label);

function fnPager(fullSlug) {
  const i = FN_SEQUENCE.indexOf(fullSlug);
  const link = (s) => ({ href: pagePath(s), label: fnLabel(s) });
  return {
    prev: i > 0 ? link(FN_SEQUENCE[i - 1]) : undefined,
    next: i >= 0 && i < FN_SEQUENCE.length - 1 ? link(FN_SEQUENCE[i + 1]) : undefined,
  };
}

// The field-notes section's OWN sidebar: a flat, chronological (newest-first)
// list of every note with its landed-date — NOT the docs NAV.
function fieldNoteSidebar(activeSlug) {
  let out = '<div class="grp">Field Notes</div>';
  const landingActive = activeSlug === "field-notes" ? " active" : "";
  out += '<a class="lnk' + landingActive + '" href="/field-notes/">About these notes</a>';
  for (const n of FIELD_NOTES_NEWEST) {
    const full = "field-notes/" + n.slug;
    const active = full === activeSlug ? " active" : "";
    out += '<a class="lnk' + active + '" href="/field-notes/' + n.slug + '/"><span class="fn-date">' + n.date + "</span>" + n.label + "</a>";
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
    "verify-reconcile",
    "schema-changes",
    "redact-pii",
    "postgres-source-prep",
    "managed-postgres-slotless",
    "planetscale-vitess",
    "planetscale-region-move",
    "mysql-to-planetscale",
    "planetscale-postgres",
    "planetscale-postgres-upgrade",
    "planetscale-postgres-analytics-replica",
    "operate-fleet",
    "encrypted-backups",
    "agent-skills",
  ];
  const fieldNote = isFieldNote(slug);
  const docsActive = !fieldNote && (slug === "getting-started" || slug === "configuration" || slug === "commands" || slug === "supported-directions" || slug === "how-sluice-copies" || slug === "error-codes" || slug === "type-mapping" || slug === "database-objects" || slug === "" || guideSlugs.includes(slug));
  // Field-note pages derive their prev/next from the chronological FIELD_NOTES
  // sequence (single source of truth), overriding any passed pager.
  if (fieldNote) ({ prev, next } = fnPager(slug));
  const top =
    '<a class="' + (docsActive ? "active" : "") + '" href="/docs/">Docs</a>' +
    '<a class="' + (fieldNote ? "active" : "") + '" href="/field-notes/">Field Notes</a>';
  // A dated "landed" line under the dek on each note page (not the landing).
  const landedLine = fieldNote && fnBySlug.has(slug) ? '<p class="fn-landed">Landed in sluice · ' + fnBySlug.get(slug).date + " · " + esc(fnBySlug.get(slug).engine) + "</p>" : "";
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
<link rel="alternate" type="text/markdown" href="${pageMdPath(slug)}" title="This page as Markdown (for AI agents)">
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
  <aside class="sidebar">${fieldNote ? fieldNoteSidebar(slug) : sidebar(slug)}</aside>
  <main class="content">
    <h1>${esc(title)}</h1>
    ${subtitle ? '<p class="subtitle">' + esc(subtitle) + "</p>" : ""}
    ${landedLine}
    ${tocHtml}
    ${bodyHtml}
    ${pager}
  </main>
</div>
<footer class="foot">Apache 2.0 · <a href="https://github.com/sluicesync/sluice">github.com/sluicesync/sluice</a> · <code>go install sluicesync.dev/sluice/cmd/sluice@latest</code> · <a href="${pageMdPath(slug)}">View this page as Markdown</a></footer>
</body>
</html>`;
}

// Writes a page's index.html. Docs live under docs/<slug>/; field notes live at
// the top-level <slug>/ (slug already carries the "field-notes/..." prefix).
function write(slug, html) {
  const rel = slug === "" ? "docs" : isFieldNote(slug) ? slug : "docs/" + slug;
  const dir = join(ROOT, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  console.log("wrote", rel + "/index.html");
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
  <tr><td><code>--schema-changes</code></td><td class="desc"><code>forward</code> (default, ADR-0091) auto-applies unambiguous source DDL — ADD/DROP/ALTER COLUMN, CREATE/DROP INDEX, ADD/DROP/MODIFY CHECK — on the target so the sync stays online through schema evolution (shape support; whether a given shape actually arrives depends on the source engine&#39;s CDC surface — see the per-source matrix in the schema-changes guide). <code>refuse</code> restores the conservative pre-v0.92 behavior: any source DDL surfaces loudly with the drained-model recovery hint. RENAME COLUMN and a computed/volatile DEFAULT on ADD COLUMN always refuse loudly. See the warn box below.</td></tr>
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
  <tr><td><code>--notify-webhook</code> / <code>--notify-slack</code></td><td class="desc">Threshold-alert sinks (also accepted by <a href="/docs/commands/#metrics-watch">metrics-watch</a>): a generic webhook (JSON POST) and/or a Slack incoming-webhook. Set the URLs via the env vars <code>SLUICE_NOTIFY_WEBHOOK</code> / <code>SLUICE_NOTIFY_SLACK</code>. Advisory + failure-isolated (a dead sink is logged-and-swallowed). The sinks themselves are ungated — pair one with a threshold below; only the util / control-plane-lag / growth thresholds additionally need <code>--planetscale-org</code> telemetry.</td></tr>
  <tr><td><code>--notify-sync-lag-seconds</code></td><td class="desc">Alert when sluice's own apply lag (<code>sluice_sync_lag_seconds</code>) is at or above N seconds. <strong>Ungated</strong> — works on MySQL and Postgres alike, needing only a sink; no PlanetScale telemetry. <code>0</code> disables.</td></tr>
  <tr><td><code>--notify-storage-util</code> / <code>--notify-cpu-util</code> / <code>--notify-mem-util</code></td><td class="desc">Alert when the target's storage / CPU / memory utilisation (a fraction <code>0–1</code>, <em>used/capacity</em>) is at or above the threshold. Edge-triggered + cooldown'd. <code>0</code> disables a rule. Requires <code>--planetscale-org</code> telemetry.</td></tr>
  <tr><td><code>--notify-lag-seconds</code> / <code>--notify-storage-growth-per-min</code></td><td class="desc">Alert when the target's control-plane replica lag (seconds) is at or above the value, or when storage utilisation is <em>climbing</em> at or above this fraction-of-capacity per minute (a pre-grow early warning, e.g. <code>0.02</code> = +2%/min). <code>0</code> disables. Requires <code>--planetscale-org</code> telemetry.</td></tr>
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

<h2 id="sync-fleet">sync run / sync tui</h2>
${cmd(
  "sync-run-c",
  "sluice sync run --config syncs.yaml",
  "Supervise many syncs from one process (ADR-0122): each sync is failure-isolated with bounded-backoff restart, and a bad neighbor never takes the fleet down.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--config</code>, <code>-c</code></td><td class="desc"><strong>Required</strong> (the global flag). Path to a <code>syncs.yaml</code> fleet config — a <code>syncs:</code> list of per-sync specs (each a curated subset of the <a href="/docs/commands/#sync-start">sync start</a> knobs) plus an optional fleet-wide <code>restart:</code> policy. Load-time validation refuses a duplicate <code>stream-id</code>, a colliding Postgres slot name, or an unknown/misspelled key (a typo'd knob is a loud failure, never a silent drop).</td></tr>
  <tr><td><code>--dashboard-listen</code></td><td class="desc">Serve a read-only fleet dashboard — a self-contained HTML page plus a stable <code>GET /api/fleet</code> JSON API — on <code>ADDR</code> (e.g. <code>:9300</code>). Empty = off. It exposes only what <code>sync status --all</code> does (stream-ids, states, errors — no DSNs, no row data) and has <strong>no authentication</strong>: bind to localhost or a trusted network. A bind failure is loud-fatal (the fleet won't start without the dashboard you asked for).</td></tr>
  <tr><td><code>--dry-run</code>, <code>-n</code></td><td class="desc">Validate the fleet config (required fields, stream-id + slot-name uniqueness, retry bounds) and print the resolved plan — start nothing.</td></tr>
  </tbody></table>
  <p>The process blocks until every sync exits; Ctrl-C / SIGTERM stops them all cleanly. <strong>Live reload without a restart:</strong> edit <code>syncs.yaml</code> and send the process <code>SIGHUP</code> — sluice re-reads and re-validates the file, then reconciles the live fleet (starts added syncs, drains removed ones, restarts changed ones, leaves unchanged ones untouched). A reload that fails to parse or validate is refused loudly and the running fleet keeps going on the old config. <code>SIGHUP</code> is POSIX-only; on Windows, restart the process to change the fleet. The full walkthrough is in <a href="/docs/operate-fleet/">Operate a sync fleet</a>.</p>
  ${pre(`# validate + print the plan, start nothing
sluice sync run --config syncs.yaml --dry-run

# run the fleet with a read-only dashboard API on :9300
sluice sync run --config syncs.yaml --dashboard-listen :9300

# reload the running fleet after editing syncs.yaml (POSIX)
kill -HUP "$(pgrep -f 'sluice sync run')"`)}`
)}
${cmd(
  "sync-tui-c",
  "sluice sync tui --connect ADDR",
  "A full-screen terminal dashboard for a running fleet (ADR-0125) — it polls a 'sync run --dashboard-listen' server's /api/fleet endpoint, so it works locally or over an SSH tunnel without disturbing the fleet process.",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--connect</code></td><td class="desc"><strong>Required.</strong> <code>host:port</code> or URL of a running <code>sync run --dashboard-listen</code> server — <code>:9300</code>, <code>localhost:9300</code>, <code>http://host:9300</code>, or a full <code>…/api/fleet</code> URL. The TUI polls its <code>/api/fleet</code> endpoint.</td></tr>
  <tr><td><code>--refresh</code></td><td class="desc">How often to poll <code>/api/fleet</code> for a fresh fleet view (default <code>2s</code>).</td></tr>
  </tbody></table>
  <p>The TUI keeps the last-known fleet on screen with an "unreachable" banner if a poll fails, instead of blanking.</p>
  ${pre(`# terminal 1: run the fleet with the dashboard API exposed
sluice sync run --config syncs.yaml --dashboard-listen :9300

# terminal 2 (local or over an SSH tunnel): live terminal view
sluice sync tui --connect :9300 --refresh 2s`)}`
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
${cmd(
  "trigger-prune-c",
  "sluice trigger prune",
  "Reap durably-applied rows from a trigger-CDC source's sluice_change_log while a sync is live — the capture path never removes consumed rows, so the change-log grows unbounded for the life of a continuous sync (ADR-0137).",
  `<table><thead><tr><th>Flag</th><th>Purpose</th></tr></thead><tbody>
  <tr><td><code>--source-driver</code> / <code>--source</code></td><td class="desc">The trigger-CDC source whose change-log to prune: <code>postgres-trigger</code> (default), <code>sqlite-trigger</code>, or <code>d1-trigger</code>, and the DSN where <code>sluice_change_log</code> lives (a PG DSN, a SQLite file path, or the <code>d1://</code> form; token via <code>CLOUDFLARE_API_TOKEN</code>).</td></tr>
  <tr><td><code>--target-driver</code> / <code>--target</code></td><td class="desc">The target engine + DSN the sync applies to — <strong>where the durably-applied CDC position lives</strong>. prune reads the target's persisted frontier as the only safe lower bound and <strong>refuses loudly</strong> if it can't read one (it never prunes blind).</td></tr>
  <tr><td><code>--stream-id</code></td><td class="desc">Required — the same <code>--stream-id</code> the sync uses. Its durable position bounds the prune; prune cross-checks the recorded source fingerprint to refuse a <code>--source</code>/<code>--stream-id</code> mis-pairing.</td></tr>
  <tr><td><code>--keep</code></td><td class="desc">Safety margin: keep the most-recent <code>N</code> change-log ids below the durable frontier unpruned (default <code>1000</code>). Belt-and-suspenders — the frontier itself is already durably applied, so even <code>0</code> is safe.</td></tr>
  <tr><td><code>--vacuum</code></td><td class="desc">After pruning, <code>VACUUM</code> to reclaim file space — <strong><code>sqlite-trigger</code> / <code>d1-trigger</code> only</strong> (Postgres relies on autovacuum). Off by default; <code>VACUUM</code> rewrites the whole database.</td></tr>
  <tr><td><code>--schema</code></td><td class="desc">PG source schema holding <code>sluice_change_log</code> (postgres-trigger only); defaults to the DSN's <code>schema</code> parameter.</td></tr>
  <tr><td><code>--dry-run</code>, <code>-n</code></td><td class="desc">Compute and print the prune bound without deleting anything.</td></tr>
  </tbody></table>
  <p>The correctness crux: a change-log row is pruned only if its id is at or below the watermark the applier has <strong>persisted to the target</strong>. The exactly-once contract advances that watermark only on durable apply, so the target's persisted position is the durably-applied frontier — pruning on the source's <code>MAX(id)</code>, the read cursor, or a TTL would delete not-yet-applied rows and cause silent permanent loss on the next warm-resume. Run it periodically against a live trigger-CDC sync (especially <code>d1-trigger</code>, where change-log growth and per-write billing both matter):</p>
  ${pre(`# preview the bound, delete nothing
sluice trigger prune --source-driver sqlite-trigger --source ./app.db \\
    --target-driver postgres --target 'postgres://user:pass@host:5432/app' \\
    --stream-id app --dry-run

# reap durably-applied rows, keeping a 1000-id margin, then reclaim space
sluice trigger prune --source-driver sqlite-trigger --source ./app.db \\
    --target-driver postgres --target 'postgres://user:pass@host:5432/app' \\
    --stream-id app --keep 1000 --vacuum`)}`
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

// ---- Error codes & exit codes -------------------------------------------
write(
  "error-codes",
  page({
    slug: "error-codes",
    title: "Error codes & exit codes",
    subtitle: "The stable SLUICE-E-* error codes and the process exit-code contract — a greppable branching surface for scripts, log pipelines, and agents driving the CLI.",
    body: `
<p>sluice's error messages have always named the remedy in prose — "pass <code>--zero-date=null</code>", "use <code>--resume</code>". Prose is a poor branching surface for scripts, log pipelines, and AI agents driving the CLI, so every error class that carries an operator hint also carries a <strong>stable error code</strong>: a frozen <code>SLUICE-E-&lt;DOMAIN&gt;-&lt;SLUG&gt;</code> identifier machines can match exactly. The human-facing message is unchanged; the code and a concise remedy ride along as metadata.</p>
<p>A <code>SLUICE-E-*</code> code in sluice's output is <strong>stable and greppable</strong> — once shipped, the string is frozen (renaming or removing one is a breaking change), and it maps deterministically to an exit code (<strong>2</strong> for a config error, <strong>3</strong> for a named refusal). The registry in <code>internal/sluicecode</code> is the single source of truth, and a unit test enforces that it matches this table in both directions. Codes are minted only for errors that already carry an operator hint — it is deliberately not a catalogue of every possible error.</p>
<p>Where the metadata surfaces: under the global <code>--log-format json</code> flag a terminal coded error emits one ERROR record with <code>code</code>, <code>hint</code>, and <code>err</code> attributes (text-format logging shows the same record in slog's text shape); the exit code lets a caller distinguish "sluice refused and named the remedy — retrying won't help" from a generic runtime failure without parsing anything.</p>

<h2 id="exit-codes">Exit codes</h2>
<p>sluice historically exited <code>0</code> on success and <code>1</code> on everything else. The taxonomy below keeps those two meanings stable and carves two classes out of the generic-failure bucket, so nothing that checks <code>!= 0</code> changes behaviour.</p>
<table><thead><tr><th>Exit code</th><th>Meaning</th></tr></thead><tbody>
<tr><td><code>0</code></td><td class="desc"><strong>Success.</strong> For <code>verify</code>, <code>diff</code>, and <code>sync-health</code>: success <em>and</em> clean.</td></tr>
<tr><td><code>1</code></td><td class="desc"><strong>Generic runtime failure.</strong> For <code>verify</code>/<code>diff</code>/<code>sync-health</code> this is those commands' long-standing per-command meaning: the check ran and found a mismatch / drift / stale stream.</td></tr>
<tr><td><code>2</code></td><td class="desc"><strong>Config error:</strong> the <code>--config</code> file could not be loaded or parsed. (The read-side commands <code>verify</code>/<code>diff</code>/<code>sync-health</code>/<code>metrics-watch</code> have always used 2 more broadly for "the check could not run at all".)</td></tr>
<tr><td><code>3</code></td><td class="desc"><strong>Named refusal:</strong> sluice declined to proceed (or to silently alter a value) and named the remedy — the refusal-class codes below. Retrying without acting on the hint fails identically.</td></tr>
<tr><td><code>80</code></td><td class="desc"><strong>Usage error:</strong> kong (the CLI parser) exits 80 on unknown flags/commands and missing required arguments, before any sluice code runs. sluice adopts this rather than remapping it.</td></tr>
</tbody></table>
<div class="note"><strong>Backward compatibility.</strong> Scripts and unit files that check <code>exit != 0</code> (including a systemd <code>Restart=on-failure</code>) are unaffected — every failure class is still non-zero. Scripts that check <code>exit == 1</code> <em>specifically</em> should be updated: config errors and named refusals that previously exited 1 now exit 2 and 3.</div>

<h2 id="codes">Error codes</h2>
<p>The <strong>class</strong> drives the exit code: a terminal <code>refusal</code> exits <code>3</code>, a terminal <code>runtime</code> code exits <code>1</code> like any other failure — the code is in the log record either way.</p>
<table><thead><tr><th>Code</th><th>Class</th><th>Meaning</th><th>Remedy</th></tr></thead><tbody>
<tr><td><code>SLUICE-E-CONNECT-REFUSED</code></td><td class="desc">runtime</td><td class="desc">The database host/port is unreachable from this machine.</td><td class="desc">Verify the DSN host/port and network reachability.</td></tr>
<tr><td><code>SLUICE-E-CONNECT-AUTH-FAILED</code></td><td class="desc">runtime</td><td class="desc">The database rejected the DSN credentials.</td><td class="desc">Verify the DSN username and password.</td></tr>
<tr><td><code>SLUICE-E-CONNECT-DATABASE-MISSING</code></td><td class="desc">runtime</td><td class="desc">The DSN names a database that does not exist on the server.</td><td class="desc">Verify the DSN database name.</td></tr>
<tr><td><code>SLUICE-E-BULKCOPY-TARGET-TABLE-MISSING</code></td><td class="desc">runtime</td><td class="desc">Bulk-copy hit a missing target table — schema-apply failed or wrote into a different schema.</td><td class="desc">Check the schema-apply phase's output and the target schema/database the DSN points at.</td></tr>
<tr><td><code>SLUICE-E-BULKCOPY-TABLE-FAILED</code></td><td class="desc">runtime</td><td class="desc">A table failed mid-bulk-copy; earlier tables have data but not their declared secondary indexes yet (the indexes phase runs after all tables finish copying).</td><td class="desc">Fix the offending table and continue with <code>--resume</code>, or skip it with <code>--exclude-table=&lt;name&gt;</code>.</td></tr>
<tr><td><code>SLUICE-E-SCHEMA-PERMISSION-DENIED</code></td><td class="desc">runtime</td><td class="desc">The target role lacks CREATE on the schema.</td><td class="desc">GRANT the privilege or use a different role.</td></tr>
<tr><td><code>SLUICE-E-INDEX-STATEMENT-TIME-LIMIT</code></td><td class="desc">runtime</td><td class="desc">A post-copy index build hit PlanetScale's statement-time limit (MySQL errno 3024); the data is already copied.</td><td class="desc"><code>--resume</code> finishes just the indexes with no re-copy (grow the cluster first for a faster build), or start fresh with <code>--upfront-indexes</code>.</td></tr>
<tr><td><code>SLUICE-E-INDEX-DIRECT-DDL-DISABLED</code></td><td class="desc">runtime</td><td class="desc">PlanetScale safe-migrations is enabled on the target branch and blocks direct DDL (errno 1105).</td><td class="desc">Disable safe-migrations on the branch for the migration; sluice does not yet drive PlanetScale deploy requests.</td></tr>
<tr><td><code>SLUICE-E-CDC-REPLICATION-PERMISSION</code></td><td class="desc">runtime</td><td class="desc">The connecting role lacks the REPLICATION attribute.</td><td class="desc"><code>ALTER ROLE x REPLICATION</code>; see <a href="/docs/postgres-source-prep/">Prepare a Postgres source</a>.</td></tr>
<tr><td><code>SLUICE-E-COLDSTART-TARGET-NOT-EMPTY</code></td><td class="desc"><strong>refusal</strong></td><td class="desc">Cold-start refused: a target table already contains data (usually a previous run died mid-copy).</td><td class="desc">Sync: re-run with <code>--reset-target-data --yes</code>. Migrate: use <code>--resume</code>. Either mode: <code>--force-cold-start</code> to copy into the populated table anyway (collides on PRIMARY KEY in most cases).</td></tr>
<tr><td><code>SLUICE-E-SCHEMA-EXTENSION-NOT-ENABLED</code></td><td class="desc"><strong>refusal</strong></td><td class="desc">A column's type is owned by a PostgreSQL extension the operator has not opted into.</td><td class="desc">Pass <code>--enable-pg-extension &lt;ext&gt;</code>; see <a href="/docs/type-mapping/">Type mapping</a>.</td></tr>
<tr><td><code>SLUICE-E-VALUE-ZERO-DATE</code></td><td class="desc"><strong>refusal</strong></td><td class="desc">A MySQL zero/partial date (<code>0000-00-00 …</code>) has no valid calendar value the target can hold.</td><td class="desc">Pass <code>--zero-date=null</code> or <code>--zero-date=epoch</code> to carry it.</td></tr>
<tr><td><code>SLUICE-E-VALUE-NUL-BYTE</code></td><td class="desc"><strong>refusal</strong></td><td class="desc">A string value carries a NUL byte (0x00), which PostgreSQL text types cannot store.</td><td class="desc">Clean the source data, or map the column to bytea with <code>--type-override COL=bytea</code>.</td></tr>
<tr><td><code>SLUICE-E-EXPR-BACKSLASH-LITERAL</code></td><td class="desc"><strong>refusal</strong></td><td class="desc">A SQLite expression's string literal contains a backslash (or a double-quoted token), which MySQL would silently reinterpret under its default sql_mode.</td><td class="desc">Rewrite the expression on the SQLite source, or re-create it on the MySQL target post-migration.</td></tr>
<tr><td><code>SLUICE-E-CONFIRMATION-REQUIRED</code></td><td class="desc"><strong>refusal</strong></td><td class="desc">A destructive command was run without <code>--yes</code>. sluice is non-interactive and never prompts, so it refuses loudly instead of blocking (<code>slot drop</code> is the current caller).</td><td class="desc">Re-run with <code>--yes</code> (or <code>-y</code>) to confirm the destructive operation.</td></tr>
<tr><td><code>SLUICE-E-DRIVER-HOST-MISMATCH</code></td><td class="desc"><strong>refusal</strong></td><td class="desc">The chosen driver cannot drive the DSN's host — today: the vanilla <code>mysql</code> driver pointed at a PlanetScale endpoint (<code>*.connect.psdb.cloud</code>), whose binlog CDC and <code>LOAD DATA</code> cold-copy Vitess blocks. Caught up front, before any connection.</td><td class="desc">Pass <code>--source-driver planetscale</code> / <code>--target-driver planetscale</code> for the PlanetScale endpoint.</td></tr>
</tbody></table>
`,
    prev: { href: "/docs/commands/", label: "Command reference" },
    next: { href: "/docs/type-mapping/", label: "Type mapping" },
  })
);

// ---- Type mapping --------------------------------------------------------
write(
  "type-mapping",
  page({
    slug: "type-mapping",
    title: "Type mapping",
    subtitle: "What your MySQL TINYINT(1) / ENUM / DECIMAL / JSON / temporal types become on Postgres (and vice versa), and on SQLite / D1 — the cross-engine translation policies.",
    body: `
<p>sluice never translates one dialect straight to another. Every column type maps <strong>source-dialect → typed IR → target-dialect</strong>: source-specific knowledge lives in readers, target-specific knowledge in writers, and the IR is the only shared contract. That's why the four-direction matrix needs four readers and four writers, not twelve pairwise tables. This page is the operator-facing summary of those policies; the canonical, always-current source is <a href="https://raw.githubusercontent.com/sluicesync/sluice/main/docs/type-mapping.md">docs/type-mapping.md</a> and the runtime value contract in <a href="https://raw.githubusercontent.com/sluicesync/sluice/main/docs/value-types.md">docs/value-types.md</a>.</p>

<h2 id="core-vs-extension">Core vs extension types</h2>
<p>The IR type system is a two-tier hierarchy, and the tier decides what happens on an engine that lacks a type:</p>
<ul>
<li><strong>Core types</strong> — integers, decimal, float, boolean, char/varchar/text, binary/blob, date/time/datetime/timestamp, JSON — are the types every relational engine has in some form. Every engine reads and writes them; they are the lingua franca.</li>
<li><strong>Extension types</strong> — <code>ENUM</code>, <code>SET</code>, <code>UUID</code>, arrays, PostGIS geometry, and the Postgres network types (<code>inet</code>/<code>cidr</code>/<code>macaddr</code>) — are types only some engines support natively. Each engine declares which it handles; an engine that lacks one either applies a <strong>documented degradation</strong> (e.g. Postgres array → MySQL <code>JSON</code>) or <strong>refuses loudly</strong>. Postgres extension types (<code>hstore</code>, <code>citext</code>, <code>pgvector</code>, PostGIS) are opt-in via <code>--enable-pg-extension EXT</code> and refuse loudly at schema-read if the flag is absent (<a href="/docs/error-codes/"><code>SLUICE-E-SCHEMA-EXTENSION-NOT-ENABLED</code></a>) — never silently dropped.</li>
</ul>
<p>Adding a new engine never amends the core; it declares which extension types it supports and provides the reader/writer code. The orchestrator never asks "are you MySQL?" — it asks "do you support arrays?"</p>

<h2 id="mysql-pg">MySQL ↔ Postgres</h2>
<p>The most-travelled direction. Notable rows below; the full table is in the canonical doc.</p>
<table><thead><tr><th>MySQL</th><th>Postgres</th><th>Notes</th></tr></thead><tbody>
<tr><td><code>TINYINT(1)</code></td><td class="desc"><code>boolean</code></td><td class="desc">The MySQL boolean convention. A value outside <code>{0,1}</code> collapses to <code>true</code>; sluice WARNs loudly once per column and names the row. Override with <code>--type-override col=smallint</code> to keep the integer (<code>smallint</code> is the safe floor — a <code>tinyint</code> override could round-trip back to a boolean).</td></tr>
<tr><td><code>TINYINT</code> / <code>SMALLINT</code> / <code>MEDIUMINT</code> / <code>INT</code> / <code>BIGINT</code></td><td class="desc"><code>smallint</code> / <code>smallint</code> / <code>integer</code> / <code>integer</code> / <code>bigint</code></td><td class="desc"><code>MEDIUMINT</code> widens to <code>integer</code> on PG (no 3-byte int). Signed ranks map straight across.</td></tr>
<tr><td><code>… UNSIGNED</code></td><td class="desc">widens one rank</td><td class="desc"><code>tinyint</code>→<code>smallint</code>, <code>smallint</code>→<code>integer</code>, <code>mediumint</code>/<code>int</code>→<code>bigint</code>. <strong><code>bigint unsigned</code> → <code>bigint</code> (uniform)</strong>: PG has no unsigned 64-bit, so values in <code>(2^63-1, 2^64-1]</code> aren't representable — but this is the only mapping that keeps an <code>AUTO_INCREMENT PK</code> and its FK children type-consistent (the default Rails/Laravel/Django schema). Surfaced by a loud range-narrowing notice at <code>schema preview</code> / <code>migrate</code> preflight; override to <code>numeric</code> to keep the full range (then the column can't be an identity key).</td></tr>
<tr><td><code>DECIMAL(p,s)</code> / <code>NUMERIC</code></td><td class="desc"><code>numeric(p,s)</code></td><td class="desc">Carried as a string end-to-end; precision is lossless. A bare Postgres <code>numeric</code> (no p/s) is arbitrary-precision — PG→PG round-trips it bare; PG→MySQL widens to <code>DECIMAL(65,30)</code> (MySQL's max) with a loud widening notice.</td></tr>
<tr><td><code>FLOAT</code> / <code>DOUBLE</code></td><td class="desc"><code>real</code> / <code>double precision</code></td><td class="desc">IEEE special floats (<code>NaN</code>, <code>±Inf</code>) ride through exactly.</td></tr>
<tr><td><code>CHAR(n)</code> / <code>VARCHAR(n)</code> / <code>TINY..LONGTEXT</code></td><td class="desc"><code>char(n)</code> / <code>varchar(n)</code> / <code>text</code></td><td class="desc">A PG <code>varchar(N)</code> above MySQL's representable cap down-maps to the smallest MySQL <code>TEXT</code>-family type, with a loud advisory. Charset/collation are carried same-engine, dropped-with-WARN cross-engine (collation names aren't portable).</td></tr>
<tr><td><code>DATE</code> / <code>TIME(p)</code> / <code>DATETIME(p)</code> / <code>TIMESTAMP(p)</code></td><td class="desc"><code>date</code> / <code>time(p)</code> / <code>timestamp(p)</code> / <code>timestamptz(p)</code></td><td class="desc">MySQL <code>TIMESTAMP</code> always stores UTC → PG <code>timestamptz</code>. A bare PG <code>time</code>/<code>timestamp</code> (no precision) round-trips bare PG→PG but materializes <code>(6)</code> on a MySQL target. A PG <code>timetz</code> → MySQL drops the zone (MySQL has no tz-aware time). Zero/partial MySQL dates (<code>0000-00-00</code>) are refused unless <code>--zero-date=null|epoch</code> (<a href="/docs/error-codes/"><code>SLUICE-E-VALUE-ZERO-DATE</code></a>).</td></tr>
<tr><td><code>ENUM('a','b')</code></td><td class="desc"><code>enum</code> type (default) or <code>text</code> + <code>CHECK</code></td><td class="desc">Default emits a PG <code>CREATE TYPE … AS ENUM</code>; per-column override for <code>text</code> + a <code>CHECK</code> constraint. A PG enum → MySQL becomes a column-level <code>ENUM(...)</code> (no shared type; each column gets its own).</td></tr>
<tr><td><code>SET('a','b')</code></td><td class="desc"><code>text[]</code> + <code>CHECK</code></td><td class="desc">Membership preserved via a CHECK; override to a comma-delimited <code>text</code>.</td></tr>
<tr><td><code>JSON</code></td><td class="desc"><code>jsonb</code> (default) / <code>json</code></td><td class="desc">MySQL <code>JSON</code> and PG <code>jsonb</code> both validate + normalise; PG <code>json</code> (no b) preserves whitespace/key order. Carried as raw bytes.</td></tr>
<tr><td class="desc">(no MySQL type)</td><td class="desc"><code>uuid</code></td><td class="desc">PG <code>uuid</code> → MySQL <code>CHAR(36)</code> / <code>BINARY(16)</code>.</td></tr>
<tr><td class="desc"><code>JSON</code> (degraded)</td><td class="desc"><code>T[]</code> (array)</td><td class="desc">MySQL has no array type: a PG array → MySQL <code>JSON</code> (empty <code>{}</code>→<code>[]</code>, NULL element→JSON <code>null</code>, nested preserved). Override <code>array_strategy: concat</code> for simple scalar arrays. Multi-dimensional arrays are pinned per element family — see the field note on <a href="/field-notes/numeric-array-flatten/">the pgx codec that silently flattened <code>numeric[][]</code></a>.</td></tr>
<tr><td class="desc"><code>VARCHAR(45/30)</code></td><td class="desc"><code>inet</code> / <code>cidr</code> / <code>macaddr</code></td><td class="desc">PG network types have no MySQL native form: <code>inet</code>/<code>cidr</code>→<code>VARCHAR(45)</code>, <code>macaddr</code>→<code>VARCHAR(30)</code> (auto-shaped since v0.7.0; overridable).</td></tr>
<tr><td class="desc">spatial types</td><td class="desc"><code>geometry</code> (PostGIS)</td><td class="desc">Requires PostGIS on the target via <code>--enable-pg-extension</code>; carried as WKB. Every subtype/SRID preserved.</td></tr>
</tbody></table>

<h2 id="sqlite-d1">SQLite &amp; Cloudflare D1</h2>
<p>SQLite (and D1, which is SQLite over HTTP) is the one engine whose <em>value</em> storage isn't pinned by its <em>column</em> declaration — a column has a type <strong>affinity</strong>, and each stored value carries its own storage class. sluice resolves an IR type from the <strong>declared type</strong> in a load-bearing order: declared temporal / bool spellings win first, affinity second.</p>
<table><thead><tr><th>SQLite declared / affinity</th><th>IR &rarr; typical target</th><th>Notes</th></tr></thead><tbody>
<tr><td class="desc"><code>DATE</code> / <code>DATETIME</code>·<code>TIMESTAMP</code> / <code>TIME</code></td><td class="desc"><code>date</code> / <code>timestamp</code> (no tz) / <code>time</code></td><td class="desc">Declared spelling overrides affinity (they'd otherwise read as NUMERIC decimals). The <em>value</em> encoding is an operator choice — <code>--sqlite-date-encoding</code> (<code>iso</code> default / <code>unixepoch</code> / <code>unixmillis</code> / <code>julian</code>); a storage-class mismatch is refused loudly, naming the row.</td></tr>
<tr><td class="desc"><code>BOOL</code> / <code>BOOLEAN</code></td><td class="desc"><code>boolean</code></td><td class="desc">Decodes <code>0</code>/<code>1</code> and truthy text; anything else is refused.</td></tr>
<tr><td class="desc">INTEGER affinity</td><td class="desc"><code>bigint</code></td><td class="desc">SQLite integers are 64-bit signed. Integers above 2<sup>53</sup> round-trip exactly via the <code>(typeof, text/hex)</code> projection (the lossless live-D1 reader path).</td></tr>
<tr><td class="desc">TEXT affinity</td><td class="desc"><code>text</code></td><td class="desc">Unbounded — declared <code>VARCHAR(n)</code> lengths aren't enforced by SQLite, so no misleading bound is carried.</td></tr>
<tr><td class="desc">REAL affinity</td><td class="desc"><code>double precision</code></td><td class="desc">8-byte IEEE-754.</td></tr>
<tr><td class="desc">NUMERIC affinity</td><td class="desc">unconstrained <code>numeric</code></td><td class="desc">Arbitrary precision.</td></tr>
</tbody></table>
<p>As a migrate <strong>target</strong>, SQLite emits the declared type its reader reads back to the same IR type. The one load-bearing wrinkle: an <code>ir.Decimal</code> is stored with <strong>TEXT</strong> affinity (the exact decimal string), not NUMERIC — NUMERIC affinity would coerce <code>19.99</code> to the binary float <code>19.989999999999998</code> and silently corrupt money (Bug 162); it reads back as <code>text</code> (a documented downgrade). Anything SQLite has no faithful storage for — geometry, <code>inet</code>/<code>cidr</code>/<code>macaddr</code>, <code>bit</code>, <code>interval</code>, array, domain — is <strong>refused loudly at emit time</strong>, never coerced to a silently-wrong column. D1 is not a write target: emit a SQLite <code>.db</code> (<code>--target-driver sqlite</code>) and <code>wrangler d1 import</code> it.</p>

<h2 id="overrides">Per-column overrides</h2>
<p>The default policies cover the common case; override per column in YAML (<code>mappings:</code>) or on the CLI. Overrides are typed against the IR, not dialect syntax:</p>
<ul>
<li><code>--type-override TABLE.COLUMN=TYPE</code> — force a target column type (repeatable). The override rewrites the IR type the <em>reader</em> decodes with, so e.g. <code>=smallint</code> on a <code>TINYINT(1)</code> reads the cell as an integer end-to-end.</li>
<li><code>--enable-pg-extension EXT</code> — opt into a Postgres extension type (<code>hstore</code>, <code>citext</code>, <code>vector</code>, PostGIS) so its columns pass through instead of refusing.</li>
<li>YAML <code>mappings:</code> entries also carry <code>enum_strategy</code>, <code>array_strategy</code>, <code>on_zero_date</code>, and per-column <code>target_type</code> options.</li>
</ul>
<p>Run <code>sluice schema preview</code> first to see the exact target DDL sluice would emit, including every widening/narrowing advisory and any untranslatable-expression refusal — before touching the target.</p>
`,
    prev: { href: "/docs/error-codes/", label: "Error & exit codes" },
    next: { href: "/docs/database-objects/", label: "Objects sluice creates" },
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
    next: { href: "/docs/preview-and-validate/", label: "Preview & validate before you migrate" },
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

<h2 id="rollback">6. Rolling back a cutover</h2>
<p>The safety net for a cutover is a <strong>reverse sync</strong>. Until you're confident in the new database, <strong>keep the old primary intact</strong> — do not drop or repurpose it. If something goes wrong after you flip traffic and you must fail back, you point the application at the old database again — but any writes the new database took while it was live need to travel <em>back</em> the other direction.</p>
<p>You can't naively cold-start a reverse sync (new → old) to carry them: the old database still holds all its original rows, so it isn't empty, and a fresh cold-start refuses loudly rather than bulk-copy into a populated target — <a href="/docs/error-codes/"><code>SLUICE-E-COLDSTART-TARGET-NOT-EMPTY</code></a>. That refusal is the guard working as designed; you don't want a full re-copy, you want just the <em>delta</em>. Two ways to be ready for it:</p>
<ul>
<li><strong>Run the reverse stream from the start (recommended for true reversibility).</strong> Right after the forward cutover, start a second stream in the opposite direction with its own <code>--stream-id</code>, so the old database keeps tracking the new one continuously. Failing back is then just a traffic flip plus a <code>cutover</code> on the old side to re-prime its sequences — no re-copy, no refusal.</li>
<li><strong>Reconcile the delta manually.</strong> If you didn't keep a reverse stream running, resync the window of new-database writes back to the old database the other direction and <code>verify</code> before re-flipping traffic — rather than forcing a cold-start into the non-empty old database.</li>
</ul>
<div class="note"><strong>Why the old primary must survive the window.</strong> The reverse path only exists while the old database is still there and consistent. Dropping it immediately after cutover throws away your rollback option; keep it until the new database has proven itself, then decommission.</div>

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
<p><code>--source-driver d1</code> reads a live D1 over its HTTP query API and is the <strong>lossless</strong> import. It projects every column through <code>typeof()</code> + <code>CAST(… AS TEXT)</code> / <code>hex()</code>, so integers above 2<sup>53</sup> round-trip exactly, INTEGER is distinguished from REAL, and BLOBs decode from hex. Reads don't take D1 offline. (Why the text projection instead of the obvious JSON number? See the field note on <a href="/field-notes/int64-json-boundary/">2<sup>53</sup> as a database boundary</a> — <code>wrangler d1 export</code> rounds big integers through float64 before any database sees them.) The API token is read from the environment only — never a flag, never logged:</p>
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
<div class="note"><strong>On a live D1, inference stages locally first (automatic).</strong> Cloudflare D1's query API rejects the rich-type validation patterns (its <code>GLOB</code> complexity limit), so against <code>--source-driver d1</code> sluice first replicates the database into a byte-faithful local SQLite file and validates there — engaged automatically when you pass <code>--infer-types</code> (v0.99.167). The staged copy is lossless (exact storage classes, integers above 2<sup>53</sup> included — unlike <code>wrangler d1 export</code>), so inference sees the original types and decides identically. Pass <code>--stage-local</code> to stage even without inference (a faster local bulk read), or <code>--no-stage-local</code> to force the direct path. A plain D1 migrate without <code>--infer-types</code> streams directly as before. (Not needed for a local SQLite file — it has no such limit.) The war story behind this — a UUID <code>GLOB</code> that passed every local test and died on live D1 with <code>code 7500</code> — is the field note <a href="/field-notes/d1-not-local-sqlite/">Cloudflare D1 is not your local SQLite</a>.</div>

<h2 id="orm-tables">ORM bookkeeping tables</h2>
<p>An app's ORM keeps its migration state in a bookkeeping table — Rails <code>schema_migrations</code>, Prisma <code>_prisma_migrations</code>, Drizzle <code>__drizzle_migrations</code>, Laravel <code>migrations</code>, Flyway, Goose, and more. That state describes the <em>source</em> engine's schema history and is meaningless — sometimes actively misleading — on a different target engine. On a <strong>cross-engine</strong> migrate (e.g. D1→Postgres) sluice skips these by default, <strong>announcing each skip by name</strong> so nothing vanishes silently. Copy them anyway with <code>--include-orm-tables</code>; on a same-engine run they're kept by default (the history is still valid) unless you pass <code>--skip-orm-tables</code>. Recognition is by distinctive name plus a column-shape guard for the generic names (<code>migrations</code>, <code>schema_migrations</code>), so an app table that merely shares a name isn't skipped by accident.</p>

<h2 id="target">SQLite as a target</h2>
<p>SQLite is also a migrate <strong>target</strong> (<code>--target-driver sqlite</code>) — emit a <code>.db</code> from any source (decimals are stored byte-exact as <code>TEXT</code> affinity, not lossy <code>REAL</code> — see the field note <a href="/field-notes/sqlite-decimal-affinity/">SQLite's DECIMAL is a suggestion</a> for why), e.g. to then run <code>wrangler d1 import</code>. D1 itself is not a write target; produce a SQLite <code>.db</code> and import it with wrangler.</p>
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
    next: { href: "/docs/postgres-source-prep/", label: "Prepare a Postgres source" },
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
    prev: { href: "/docs/mysql-to-planetscale/", label: "Self-hosted MySQL → PlanetScale" },
    next: { href: "/docs/planetscale-postgres/", label: "PlanetScale Postgres" },
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
    next: { href: "/docs/planetscale-vitess/", label: "PlanetScale & Vitess" },
  })
);


// nav-label: Supported directions
write(
  "supported-directions",
  page({
    slug: "supported-directions",
    title: "Supported directions",
    subtitle: "Every source → target pair sluice can move, for one-shot migrate and for continuous sync — and which pairs each surface does not cover.",
    body: `
<p>sluice moves data between database engines through two surfaces: <strong>migrate</strong> (a one-shot schema + data copy) and <strong>sync</strong> (continuous change-data-capture). A "direction" is just a <em>source engine → target engine</em> pair. Which pairs are supported differs between the two surfaces, because migrate and sync have different engine roles — a few engines can be read continuously but not written to, and a couple can only ever be a source. The authoritative, always-current list for the binary in your hand is <code>sluice engines</code>; this page is the operator-facing summary of what those roles add up to.</p>
${pre(`sluice engines   # lists every engine built into this binary and its role (migrate / CDC, source / target)`)}

<h2 id="migrate">Migrate — one-shot copy</h2>
<p>Migrate reads a source once and writes a fresh copy into a target. <strong>Every migrate source copies to every migrate target</strong> — the cell is never "unsupported", only "faster" on the same-engine diagonal. Cross-engine pairs flow through the typed <a href="/docs/how-sluice-copies/#ir-path">IR</a>; same-engine pairs take an optimized path but the same fidelity.</p>
<table><thead><tr><th>Source ↓ &nbsp;/&nbsp; Target →</th><th>MySQL</th><th>PlanetScale / Vitess</th><th>Postgres</th><th>SQLite</th></tr></thead><tbody>
  <tr><td><strong>MySQL</strong></td><td class="desc">✓ <sup>a</sup></td><td class="desc">✓ <sup>b</sup></td><td class="desc">✓</td><td class="desc">✓</td></tr>
  <tr><td><strong>PlanetScale / Vitess</strong></td><td class="desc">✓</td><td class="desc">✓ <sup>b</sup></td><td class="desc">✓</td><td class="desc">✓</td></tr>
  <tr><td><strong>Postgres</strong></td><td class="desc">✓</td><td class="desc">✓ <sup>b</sup></td><td class="desc">✓ <sup>c</sup></td><td class="desc">✓</td></tr>
  <tr><td><strong>SQLite</strong> (file / <code>.sql</code> dump)</td><td class="desc">✓</td><td class="desc">✓ <sup>b</sup></td><td class="desc">✓</td><td class="desc">✓</td></tr>
  <tr><td><strong>Cloudflare D1</strong> (live)</td><td class="desc">✓</td><td class="desc">✓ <sup>b</sup></td><td class="desc">✓</td><td class="desc">✓</td></tr>
</tbody></table>
<p><sup>a</sup> same-engine MySQL uses the native <code>LOAD DATA LOCAL INFILE</code> loader. &nbsp; <sup>b</sup> a PlanetScale / Vitess <em>target</em> blocks <code>LOAD DATA LOCAL</code>, so cold-copy falls back to batched multi-row <code>INSERT</code> (use the <code>planetscale</code> / <code>vitess</code> engine name, not <code>mysql</code>, against a Vitess-backed host). &nbsp; <sup>c</sup> same-engine Postgres byte-pipes the native <code>COPY</code> stream — the <a href="/docs/how-sluice-copies/#pg-fast-lane">raw-copy fast lane</a> — when there's no transform to apply. See <a href="/docs/how-sluice-copies/">How sluice copies your data</a> for which internal path each cell takes.</p>
<div class="note"><strong>Targets are MySQL, PlanetScale / Vitess, Postgres, or SQLite.</strong> Cloudflare D1 is a migrate <em>source</em> only (read live over its HTTP API), never a migrate target. The trigger-CDC engines (<code>postgres-trigger</code>, <code>sqlite-trigger</code>, <code>d1-trigger</code>) are sync-only and don't appear here.</div>

<h2 id="sync">Sync — continuous change-data-capture</h2>
<p>Sync does an initial snapshot, then streams every subsequent change from the source until you cut over. It has <em>more</em> sources than migrate — including three trigger-based engines for platforms that can't hand out a native replication feed — but <em>fewer</em> targets: changes are only ever applied to a MySQL-family or Postgres target.</p>
<table><thead><tr><th>Source ↓ &nbsp;/&nbsp; Target →</th><th>MySQL</th><th>PlanetScale / Vitess</th><th>Postgres</th></tr></thead><tbody>
  <tr><td><strong>MySQL</strong> — binlog</td><td class="desc">✓</td><td class="desc">✓</td><td class="desc">✓</td></tr>
  <tr><td><strong>PlanetScale / Vitess</strong> — VStream</td><td class="desc">✓</td><td class="desc">✓</td><td class="desc">✓</td></tr>
  <tr><td><strong>Postgres</strong> — replication slot</td><td class="desc">✓</td><td class="desc">✓</td><td class="desc">✓</td></tr>
  <tr><td><strong>Postgres</strong> — slot-less (<code>postgres-trigger</code>)</td><td class="desc">✓</td><td class="desc">✓</td><td class="desc">✓</td></tr>
  <tr><td><strong>SQLite</strong> — <code>sqlite-trigger</code></td><td class="desc">✓</td><td class="desc">✓</td><td class="desc">✓</td></tr>
  <tr><td><strong>Cloudflare D1</strong> — <code>d1-trigger</code></td><td class="desc">✓</td><td class="desc">✓</td><td class="desc">✓</td></tr>
</tbody></table>
<div class="note"><strong>SQLite and D1 are sync sources, not sync targets.</strong> A continuous stream <em>from</em> SQLite or D1 runs through the <code>sqlite-trigger</code> / <code>d1-trigger</code> engines (the plain <code>sqlite</code> / <code>d1</code> engines have no CDC); a stream never lands <em>into</em> SQLite or D1. For managed Postgres that can't grant a replication slot (Heroku, some RDS/Supabase tiers), <code>postgres-trigger</code> is the slot-less source path.</div>

<h2 id="four-directions">The four MySQL ↔ Postgres directions</h2>
<p>The combination sluice was built for — the fully bidirectional MySQL ↔ Postgres matrix — is every cell where both sides are one of those two engines, and all four work in both migrate and sync:</p>
<ul>
  <li><strong>MySQL → Postgres</strong> and <strong>Postgres → MySQL</strong> — cross-engine, through the IR (type translation, value-fidelity checks, PII redaction, overrides).</li>
  <li><strong>MySQL → MySQL</strong> and <strong>Postgres → Postgres</strong> — same-engine, nothing to translate; the native loader / raw-<code>COPY</code> fast lane applies on migrate.</li>
</ul>
<p>PlanetScale and self-hosted Vitess are MySQL-dialect flavors, so anywhere this page says "MySQL" as a <em>direction</em>, the Vitess-backed flavors slot into the same cell — you just pick the matching engine name so sluice uses VStream and batched-insert instead of binlog and <code>LOAD DATA</code>.</p>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/how-sluice-copies/">How sluice copies your data</a> — the internal path (IR vs raw fast lane) each direction takes, and why the fast lane never trades correctness for speed.</li>
  <li><a href="/docs/commands/#engines">Command reference: engines</a> — the per-engine role table (bulk-load / CDC capabilities, DSN shapes) this page summarizes.</li>
  <li><a href="/docs/getting-started/">Getting started</a> — connect a source and target and run your first migrate.</li>
  <li><a href="/docs/import-sqlite-d1/">Import SQLite or Cloudflare D1</a> — the SQLite / D1 source specifics end to end.</li>
</ul>
`,
    prev: { href: "/docs/", label: "Overview" },
    next: { href: "/docs/how-sluice-copies/", label: "How sluice copies your data" },
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

<h2 id="sqlite-d1">SQLite and Cloudflare D1 — always the IR path, with a lossless read projection</h2>
<p>A SQLite file, a <code>wrangler d1 export</code> <code>.sql</code> dump, or a live Cloudflare D1 database imports into Postgres or MySQL (and SQLite is itself a migrate target). These always take the <a href="#ir-path">IR path</a> — there is no raw byte-pipe for SQLite or D1, and there doesn't need to be: the copy is cross-engine, so every value is being translated anyway. The engineering that matters here is on the <em>read</em> side, because SQLite's dynamic typing and D1's HTTP-only access each make "read the value exactly" the hard part.</p>
<ul>
  <li><strong>Dynamic types, read losslessly.</strong> SQLite stores a storage <em>class</em> per value, not a declared column type. sluice reads each column through a <code>(typeof(col), CAST(col AS TEXT) / hex(col))</code> projection, so an integer above 2<sup>53</sup> keeps every bit and a <code>BLOB</code> round-trips byte-for-byte instead of going through a lossy float or UTF-8 coercion. A decimal written into a SQLite target lands byte-exact as <code>TEXT</code>.</li>
  <li><strong>Declared temporal types are an explicit decode, never a guess.</strong> SQLite has no native date/time storage, so a column <em>declared</em> <code>DATE</code> / <code>DATETIME</code> is decoded per <code>--sqlite-date-encoding</code> (<code>iso</code> default, or <code>unixepoch</code> / <code>unixmillis</code> / <code>julian</code>). A stored value whose storage class doesn't match the chosen encoding is <strong>refused loudly</strong> — never silently turned into a wrong date.</li>
  <li><strong>Live D1 stays online.</strong> The <code>d1</code> engine reads over D1's HTTP query API (token via <code>CLOUDFLARE_API_TOKEN</code>) using the same lossless projection; the read doesn't take the database offline (ADR-0132).</li>
</ul>
<p>This is the one-shot <code>migrate</code> copy path. Continuous sync <em>from</em> SQLite or D1 is a separate, trigger-based mechanism — the <code>sqlite-trigger</code> / <code>d1-trigger</code> CDC engines — not this cold-copy lane. See <a href="/docs/import-sqlite-d1/">Import SQLite or Cloudflare D1</a> for the full walkthrough, and <a href="/docs/supported-directions/">Supported directions</a> for which SQLite/D1 pairs are one-shot vs continuous.</p>

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
    prev: { href: "/docs/supported-directions/", label: "Supported directions" },
    next: { href: "/docs/commands/", label: "Command reference" },
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
<tr><td>CREATE / DROP INDEX</td><td class="desc">refuses<sup>3</sup></td><td class="desc">never signaled on the wire — cannot forward; mirror manually<sup>1</sup></td></tr>
<tr><td>ADD / DROP / MODIFY CHECK</td><td class="desc">refuses<sup>3</sup></td><td class="desc">never signaled on the wire — cannot forward; mirror manually<sup>1</sup></td></tr>
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
    prev: { href: "/docs/copy-table-subset/", label: "Copy a subset of tables" },
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
    next: { href: "/docs/operate-fleet/", label: "Operate a sync fleet" },
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
    prev: { href: "/docs/agent-skills/", label: "Drive sluice from an AI agent" },
    next: { href: "/docs/mysql-to-planetscale/", label: "Self-hosted MySQL → PlanetScale" },
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
<div class="note"><strong>Keep <code>--apply-batch-size</code> in the 25–50 range on a PS target.</strong> Above 50, a batch's apply transaction can trip Vitess's 20-second transaction killer. 50 is a safe default here. The field note <a href="/field-notes/vitess-tx-killer-wan/">The 20-second guillotine over a WAN</a> explains why — and why insert-heavy syncs now pipeline past the limit.</div>

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
    prev: { href: "/docs/planetscale-postgres-analytics-replica/", label: "PlanetScale Postgres analytics replica" },
    next: { href: "/docs/commands/", label: "Command reference" },
  })
);

// nav-label: Self-hosted MySQL → PlanetScale
write(
  "mysql-to-planetscale",
  page({
    slug: "mysql-to-planetscale",
    title: "Migrate a self-hosted MySQL to PlanetScale",
    subtitle: "Move an on-prem / self-hosted MySQL onto PlanetScale MySQL — a one-shot bulk migrate plus continuous binlog-CDC sync, so you cold-copy, keep the old primary writable, and cut over in a controlled window.",
    body: `
<p>Moving a <strong>self-hosted / on-prem MySQL</strong> onto PlanetScale MySQL: sluice does a one-shot bulk <a href="/docs/commands/#migrate">migrate</a> and a continuous <strong>binlog-CDC</strong> <a href="/docs/commands/#sync-start">sync</a>, so you cold-copy the data, keep the old primary <strong>writable</strong> while PlanetScale catches up, and cut over in a brief, controlled window. This guide is the <strong>self-hosted</strong> path — AWS RDS / Aurora and other managed MySQL are the same flow with a few connection and permission deltas (a follow-up covers those). Both ends are MySQL, so <strong>cross-engine value translation doesn't apply</strong>; the one thing that changes is that the target is <strong>Vitess-flavored</strong> MySQL, which affects two things — <a href="#target">foreign keys</a> and (before v0.99.199) <a href="#migrate">index handling</a> — both covered below. Live-verified on v0.99.199: local MySQL with binlog + GTID into a real PlanetScale database.</p>

<h2 id="source">Prepare the MySQL source</h2>
<p>For a continuous sync the source has to emit a GTID-tagged row binlog. Set these on the source server (they need a restart if they aren't already on):</p>
<table><thead><tr><th>Setting</th><th>Value</th><th>Why</th></tr></thead><tbody>
<tr><td class="desc"><code>log_bin</code></td><td class="desc">on</td><td class="desc">Binary logging must be enabled for any CDC.</td></tr>
<tr><td class="desc"><code>binlog_format</code></td><td class="desc"><code>ROW</code></td><td class="desc">Row-based events carry the actual before/after values sluice replays.</td></tr>
<tr><td class="desc"><code>gtid_mode</code></td><td class="desc"><code>ON</code></td><td class="desc">GTID-based positioning for resumable, exactly-tracked replication.</td></tr>
<tr><td class="desc"><code>enforce_gtid_consistency</code></td><td class="desc"><code>ON</code></td><td class="desc">Required alongside <code>gtid_mode=ON</code>.</td></tr>
<tr><td class="desc"><code>server_id</code></td><td class="desc">a unique value</td><td class="desc">Each server in a replication topology needs a distinct id.</td></tr>
</tbody></table>
<p>The connecting user needs <strong><code>SELECT</code></strong> for the bulk copy plus <strong><code>REPLICATION SLAVE</code></strong> and <strong><code>REPLICATION CLIENT</code></strong> to stream the binlog:</p>
${pre(`CREATE USER 'sluice'@'%' IDENTIFIED BY '<pw>';
GRANT SELECT, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'sluice'@'%';`)}
<div class="note"><strong>A one-shot <code>migrate</code> needs only <code>SELECT</code>.</strong> The binlog settings and the two <code>REPLICATION</code> grants are only required for a continuing <a href="#sync">sync</a>. If you're taking a point-in-time copy with no live CDC, plain <code>SELECT</code> on the source is enough.</div>
<div class="note"><strong>No server-id collision.</strong> sluice's binlog reader registers itself with its own random <code>server_id</code>, distinct from the source's, so joining the replication stream won't clash with the source or any existing replica.</div>

<h2 id="target">Create the PlanetScale target</h2>
<p>Create the destination database in your chosen region:</p>
${pre(`pscale database create <db> --region <region>`)}
<p>On PlanetScale a database is a <strong>Vitess keyspace</strong>. The database named in the DSN is that keyspace (its name defaults to the database name), and it must be <strong>pre-provisioned</strong> — sluice will not auto-create a Vitess keyspace. Mint an admin credential (<code>pscale password create &lt;db&gt; &lt;branch&gt; --role admin</code>, or the <code>pscale connect</code> flow) and assemble a standard go-sql-driver DSN against the global connect host:</p>
${pre(`USER:PASS@tcp(aws.connect.psdb.cloud:3306)/<keyspace>?tls=true`)}
<p><code>?tls=true</code> is required. Prefer environment variables (<code>SLUICE_SOURCE</code> / <code>SLUICE_TARGET</code>) over putting the DSN in argv, so credentials don't land in your shell history or process list.</p>
<div class="note warn"><strong>Foreign keys are off by default on PlanetScale.</strong> Vitess rejects <code>FOREIGN KEY</code> DDL with <code>VT10001</code> unless you turn support on per database. So either pass <strong><code>--skip-foreign-keys</code></strong> (skips the constraints but keeps each referencing column indexed) or enable "Allow foreign key constraints" on an unsharded database first. See <a href="/docs/foreign-keys-vitess/">Foreign keys on a Vitess / PlanetScale target</a> for the full skip-vs-enable decision.</div>

<h2 id="migrate">Migrate</h2>
<p>Preview the plan with <code>--dry-run</code>, run the copy, then verify:</p>
${pre(`sluice migrate \\
    --source-driver mysql       --source 'user:pw@tcp(HOST:3306)/db' \\
    --target-driver planetscale --target "$SLUICE_TARGET" \\
    --skip-foreign-keys --dry-run

sluice migrate \\
    --source-driver mysql       --source 'user:pw@tcp(HOST:3306)/db' \\
    --target-driver planetscale --target "$SLUICE_TARGET" \\
    --skip-foreign-keys

sluice verify \\
    --source-driver mysql       --source 'user:pw@tcp(HOST:3306)/db' \\
    --target-driver planetscale --target "$SLUICE_TARGET"`)}
<p>Value fidelity is exact on the MySQL→MySQL path: in testing <code>DECIMAL</code>, <code>ENUM</code>, and <code>DATETIME</code> all round-tripped unchanged onto Vitess MySQL, row counts matched, and <code>verify</code> came back clean. <code>--skip-foreign-keys</code> reports each skipped FK and keeps the referencing columns indexed, so joins through them stay fast.</p>
<div class="note warn"><strong>Use v0.99.199 or newer — earlier versions silently created only PRIMARY keys on a Vitess target.</strong> Secondary indexes — plain, unique, composite, and FK-backing — land correctly on <strong>v0.99.199+</strong>. On <strong>v0.99.30–v0.99.198</strong> a migrate or sync into a PlanetScale / Vitess target silently created <em>only</em> the PRIMARY keys (a regression, now fixed). If you ran an earlier version, check your target's secondary indexes and rebuild any that are missing. As of v0.99.199 sluice also <strong>loud-fails with <code>SLUICE-E-INDEX-MISSING</code></strong> if any expected index is absent after apply, so a silent recurrence can't happen.</div>

<h2 id="sync">Keep it in sync &amp; cut over</h2>
<p>A continuous sync cold-copies the source, then tails the binlog — so the source stays <strong>writable the whole time</strong> and you flip traffic in a brief window. Launch the long-lived stream:</p>
${pre(`sluice sync start --stream-id <id> \\
    --source-driver mysql       --source "$SLUICE_SOURCE" \\
    --target-driver planetscale --target "$SLUICE_TARGET" \\
    --skip-foreign-keys`)}
<p>Live-verified: after the cold copy, inserts, updates, and deletes on the source replicate to PlanetScale within seconds. Watch it catch up from another shell, and gate cutover on freshness:</p>
${pre(`sluice sync status --stream-id <id> \\
    --target-driver planetscale --target "$SLUICE_TARGET"

sluice sync health --stream-id <id> \\
    --target-driver planetscale --target "$SLUICE_TARGET" --max-stale-seconds 30`)}
<p>When the stream is fresh, quiesce writes to the source, let it drain the last changes, stop the stream, and repoint the application at PlanetScale:</p>
${pre(`sluice sync stop --stream-id <id> \\
    --target-driver planetscale --target "$SLUICE_TARGET" --wait`)}
<div class="note"><strong><code>sync stop</code> needs the target too.</strong> Pass <code>--target-driver</code> and <code>--target</code> on <code>sync stop</code> (not just <code>--stream-id</code>) — the stop path connects to the target's control tables to drain and record the final position.</div>
<div class="note"><strong>Scope to a subset of tables.</strong> Both <code>migrate</code> and <code>sync start</code> take <code>--include-table</code> / <code>--exclude-table</code> to move only some tables and keep just those in sync — see <a href="/docs/copy-table-subset/">Copy a subset of tables</a>.</div>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/foreign-keys-vitess/">Foreign keys on a Vitess / PlanetScale target</a> — the full skip-vs-enable decision for FK-bearing sources.</li>
  <li><a href="/docs/copy-table-subset/">Copy a subset of tables</a> — scope a migrate or sync to just the tables you choose.</li>
  <li><a href="/docs/planetscale-region-move/">Move PlanetScale regions</a> — the PlanetScale→PlanetScale sibling flow (VStream, sharded keyspaces).</li>
  <li><a href="/docs/planetscale-vitess/">PlanetScale &amp; Vitess</a> — the flavor, cold-start throughput knobs, and VStream lag reality in depth.</li>
  <li><a href="/docs/commands/">Command reference</a> and <a href="/docs/error-codes/">error codes</a> — every flag named here, with defaults.</li>
</ul>
`,
    prev: { href: "/docs/planetscale-vitess/", label: "PlanetScale & Vitess" },
    next: { href: "/docs/foreign-keys-vitess/", label: "Foreign keys on a Vitess target" },
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
    prev: { href: "/docs/foreign-keys-vitess/", label: "Foreign keys on a Vitess target" },
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
    next: { href: "/docs/planetscale-postgres-analytics-replica/", label: "PlanetScale Postgres analytics replica" },
  })
);

// nav-label: PlanetScale Postgres analytics replica
write(
  "planetscale-postgres-analytics-replica",
  page({
    slug: "planetscale-postgres-analytics-replica",
    title: "A live analytics replica on PlanetScale Postgres",
    subtitle: "Analytics queries on a streaming replica get canceled after ~30 seconds of recovery conflict. Stand up a second PlanetScale Postgres database and let sluice keep it continuously synced — its primary never cancels a query for recovery, so analytics can run for minutes or hours.",
    body: `
<p>If you run long analytical queries against a PlanetScale Postgres <strong>replica</strong> while the primary is busy, you will eventually meet this:</p>
${pre(`ERROR:  canceling statement due to conflict with recovery
DETAIL:  User query might have needed to see row versions that must be removed.`)}
<p>That is not a bug and not load — it is how a streaming replica works, bounded by a setting PlanetScale <strong>currently pins at 30 seconds</strong> and operators cannot raise. This guide covers the pattern that sidesteps it entirely: a <strong>second PlanetScale Postgres database that sluice maintains as a continuously-synced live copy</strong>, where analytics run against a <em>primary</em> — and a primary never cancels a query for recovery conflicts, because there is no recovery. It's a standing <a href="/docs/commands/#sync-start">sync</a> with no cutover, built on the same connection recipe as the <a href="/docs/planetscale-postgres/">PlanetScale Postgres guide</a>.</p>

<h2 id="problem">Why the replica cancels your query</h2>
<p>A streaming replica has one non-negotiable job: keep applying the primary's WAL. A long-running query on the replica holds a snapshot; when incoming WAL needs to invalidate something that snapshot still depends on — most commonly vacuum cleanup of row versions your query can still see, sometimes a conflicting lock — the replica has two choices: pause replay (and fall behind) or kill your query. <code>max_standby_streaming_delay</code> is the bounded grace period between those choices: replay waits at most that long behind a conflicting query, then cancels it.</p>
<p>On self-managed Postgres you'd raise that setting (accepting replica lag) or turn on <code>hot_standby_feedback</code> (accepting primary-side bloat). On PlanetScale Postgres these are managed — <code>max_standby_streaming_delay</code> is pinned at 30 seconds:</p>
${pre(`-- on a connection to one of the SOURCE database's replicas
SHOW max_standby_streaming_delay;
 max_standby_streaming_delay
-----------------------------
 30s
(1 row)

SHOW hot_standby_feedback;
 hot_standby_feedback
----------------------
 off
(1 row)

SET max_standby_streaming_delay = '10min';
ERROR:  parameter "max_standby_streaming_delay" cannot be changed now`)}
<p>Pinned at exactly <code>30s</code>, not session-settable (it's a server-level parameter PlanetScale doesn't expose), and with <code>hot_standby_feedback</code> off, vacuum-cleanup conflicts are live. The practical consequence: the cancellation is not a flat 30-second query timeout — it fires once a conflict has been <em>pending</em> for 30 seconds — but under steady write churn on the primary, conflicts arise continuously, so <strong>any analytics query that needs longer than roughly the grace window is effectively un-runnable on the replica</strong>. The reproduction in <a href="#act1">Act 1 below</a> shows exactly this.</p>

<h2 id="pattern">The pattern: a second database, synced by sluice</h2>
<p>Provision a second PlanetScale Postgres database and run a standing <code>sluice sync</code> from the production database into it. Point every dashboard, BI tool, and ad-hoc analyst at the second database's <strong>primary</strong>:</p>
<ul>
  <li><strong>No recovery, no cancellation.</strong> sluice applies changes as <em>ordinary transactions</em> — the analytics database is a normal primary doing normal MVCC. A query can run for minutes or hours; concurrent applies just create row versions the query's snapshot ignores, exactly as on any busy primary. The only interplay is ordinary lock/IO contention (see the <a href="#caveats">caveats</a> for the one real case, forwarded DDL).</li>
  <li><strong>Hard resource isolation.</strong> Heavy analytics burn the second database's CPU, memory, and IO — the production primary and its replicas never feel them.</li>
  <li><strong>Your own index set.</strong> The target is real writable Postgres, so analytics-only indexes (or materialized views) can live there without existing on — or ever being pushed to — production. This dovetails with an honest limitation of schema forwarding noted in the <a href="#caveats">caveats</a>: source <code>CREATE INDEX</code> doesn't propagate from a Postgres source anyway, so the target's index set is yours to design either way.</li>
</ul>
<p>The honest tradeoffs — seconds-level logical lag instead of a physical replica's sub-second, and a second database on the bill — are covered in <a href="#caveats">caveats</a>, with the lag measured, not hand-waved.</p>

<h2 id="provision">Provision &amp; connect</h2>
<p>Create the analytics database with the Postgres engine, same as the <a href="/docs/planetscale-postgres/#connect">main guide</a>. It serves reads only, so <code>--replicas 0</code> (a single node) is a reasonable start — you're building this pattern precisely because <em>this</em> database's queries don't need a replica:</p>
${pre(`pscale database create app-analytics --engine postgresql --region <region> --replicas 0 --wait`)}
<p>Connections use Postgres <em>roles</em> — take each side's DSN from the Default <code>postgres</code> role's <code>database_url</code> and keep its <code>sslmode=verify-full</code> (PlanetScale Postgres presents a public Let's Encrypt certificate that sluice's driver validates against your system trust store; full detail in the <a href="/docs/planetscale-postgres/#connect">connection recipe</a>):</p>
${pre(`pscale role reset-default app main --force --format json            # -> database_url  (source)
pscale role reset-default app-analytics main --force --format json  # -> database_url  (target)

export SLUICE_SOURCE='postgresql://<user>:<pass>@<region>.pg.psdb.cloud:5432/postgres?sslmode=verify-full'
export SLUICE_TARGET='postgresql://<user>:<pass>@<region>.pg.psdb.cloud:5432/postgres?sslmode=verify-full'`)}
<p><code>--force</code> is required with <code>--format json</code> — <code>reset-default</code> rotates the role's password, and without the flag it refuses (<code>cannot delete password with the output format "json"</code>).</p>
<div class="note"><strong>psql needs one DSN addition; sluice needs none.</strong> sluice's driver (pgx) validates the <code>verify-full</code> certificate against your system trust store out of the box — use the <code>database_url</code> exactly as PlanetScale emits it. libpq-based tools like <code>psql</code> don't read the system store by default and fail with <code>root certificate file "/root/.postgresql/root.crt" does not exist</code>; for psql, append <code>&amp;sslrootcert=system</code> to the DSN (and make sure CA certificates are installed — the stock <code>postgres</code> Docker image lacks them).</div>
<div class="note warn"><strong>Both ends connect as the Default <code>postgres</code> role.</strong> The <em>source</em> needs the <code>REPLICATION</code> attribute to create the logical-replication slot — the custom <code>pscale_api_*</code> roles lack it, and sluice refuses loudly up front if you try — and publication management needs the connecting role to <em>own</em> the source tables. The <em>target</em> wants a durable table owner. Same requirements, same <code>SLUICE-E</code> refusal shapes, as the <a href="/docs/planetscale-postgres/#sync">PlanetScale Postgres sync guide</a>.</div>

<h2 id="sync">Start the standing sync</h2>
<p>One <code>sync start</code>, both ends the plain <code>postgres</code> driver. This is a <strong>standing</strong> sync — there is no cutover section in this guide, because nothing ever cuts over; the stream simply runs:</p>
${pre(`export SLUICE_NOTIFY_WEBHOOK='https://<your-alert-sink>'   # or SLUICE_NOTIFY_SLACK

sluice sync start --stream-id analytics \\
    --source-driver postgres --source "$SLUICE_SOURCE" \\
    --target-driver postgres --target "$SLUICE_TARGET" \\
    --schema-changes forward \\
    --notify-sync-lag-seconds 60 \\
    --metrics-listen :9101`)}
<ul>
  <li><strong><code>--schema-changes forward</code></strong> (the default since v0.99.45, shown explicitly here because it's load-bearing): unambiguous source DDL — column adds, drops, type changes — is applied on the analytics copy automatically, so the replica tracks schema evolution without operator intervention. The conservative alternative is <code>--schema-changes refuse</code>: any source DDL then surfaces loudly and you apply it to the target through your own change process. See <a href="/docs/schema-changes/">Schema changes during a sync</a> — including its honest per-shape matrix, which matters here (<a href="#caveats">caveats</a>).</li>
  <li><strong><code>--notify-sync-lag-seconds 60</code></strong> alerts your webhook/Slack sink when sluice's own apply lag (<code>sluice_sync_lag_seconds</code>) reaches a minute. This threshold is <em>ungated</em> — it needs only a sink, no PlanetScale telemetry credentials.</li>
  <li><strong><code>--metrics-listen :9101</code></strong> exposes Prometheus gauges (<code>sluice_sync_lag_seconds</code>, <code>sluice_seconds_since_last_apply</code>) plus <code>/readyz</code>, so the replica's freshness lives on your existing dashboards.</li>
</ul>
<p>Health, from any shell — <code>sync status</code> for the position and phase, <code>sync health</code> as a cron-friendly freshness gate:</p>
${pre(`sluice sync status --stream-id analytics \\
    --target-driver postgres --target "$SLUICE_TARGET"

sluice sync health --stream-id analytics \\
    --target-driver postgres --target "$SLUICE_TARGET" --max-stale-seconds 60`)}

<h3 id="readonly">Give analysts a read-only role</h3>
<p>The analytics database is writable — it's a primary — so make read-only-ness a matter of <em>roles</em>, not hope. On the target, as the Default <code>postgres</code> role:</p>
${pre(`CREATE ROLE analyst LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE postgres TO analyst;
GRANT USAGE ON SCHEMA public TO analyst;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO analyst;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO analyst;`)}
<p>The <code>ALTER DEFAULT PRIVILEGES</code> line covers tables sluice creates <em>later</em> (a forwarded <code>CREATE</code>-path or <a href="/docs/commands/#schema-add-table">schema add-table</a>): sluice connects as <code>postgres</code>, which is the role the default-privilege rule is attached to, so new tables arrive analyst-readable. Point BI tools at a DSN built from <code>analyst</code>, never at the <code>postgres</code>-role DSN sluice uses.</p>
<p>The pscale-native alternative also works — a custom PlanetScale role can inherit <code>pg_read_all_data</code> directly:</p>
${pre(`pscale role create app-analytics main analyst --inherited-roles pg_read_all_data --format json
# -> returns id, name, username (a pscale_api_* name), password, database_url`)}
<p>Verified live with the returned credential — reads work, writes are refused:</p>
${pre(`== SELECT as the read-only role ==
  count
---------
 3000000
(1 row)

== INSERT as the read-only role (expect refusal) ==
ERROR:  permission denied for table events`)}
<p>Two differences from the SQL recipe: <code>pg_read_all_data</code> grants read on <em>all</em> schemas and covers future tables automatically (broader than the per-schema grants, and no <code>ALTER DEFAULT PRIVILEGES</code> line needed), and the pscale-created role's username is a <code>pscale_api_*</code> name whose password lives in PlanetScale's console. Keep the SQL recipe when you want a role whose credentials PlanetScale never stores.</p>

<h2 id="validation">Validation: three acts from a live run</h2>
<p>Everything below is from a real run (sluice 0.99.203) against two PlanetScale Postgres databases: the conflict reproduced on the source's replica, sluice syncing through the same churn, and the same query finishing on the analytics primary. The demo table is <code>events(id bigserial PRIMARY KEY, user_id bigint, kind text, amount numeric, at timestamptz)</code>, seeded with 3,000,000 rows across ~30,000 <code>user_id</code>s; the analytics query is a self-join aggregate (~300M join pairs) that takes ~52 seconds on an idle primary — comfortably past the 30-second grace window.</p>

<h3 id="act1">Act 1 — the conflict, reproduced on the source replica</h3>
<p>The source database needs replicas for this act — on PlanetScale Postgres that means an HA cluster: <code>--replicas 2</code> (the allowed shapes are <code>0</code> for a single node or <code>2</code>–<code>8</code> for HA; asking for 1 is refused with <code>Error: PostgreSQL databases must have 0 replicas for non-HA or between 2 to 8 replicas for HA.</code>). That's the deployment this guide's problem statement assumes — if you had no replica, your analytics were hitting the production primary itself. Terminal one: steady write churn on the source <strong>primary</strong> — an ordinary UPDATE loop is enough, because it's the resulting vacuum cleanup that conflicts with a standby snapshot:</p>
${pre(`-- terminal 1, connected to the source PRIMARY: ~30,000 rows updated every ~2s,
-- with a VACUUM events; every 10th iteration (n cycling 0-99)
UPDATE events SET amount = amount + 0.01 WHERE id % 100 = <n>;`)}
<p>Terminal two connects to a source <strong>replica</strong>. Reaching the replica is a credential detail, not a separate endpoint: <strong>append <code>|replica</code> to the credential username</strong> — same host, same port 5432; in URI-form DSNs the pipe must be URL-encoded as <code>%7C</code> (<code>postgresql://&lt;user&gt;%7Creplica:&lt;pass&gt;@...</code>). The dashboard also offers a "Connect → Replica" credential type; the username suffix on the existing default-role credential is the scriptable path. Proof the suffix lands on a standby:</p>
${pre(`== PRIMARY (plain username) ==
 pg_is_in_recovery
-------------------
 f
(1 row)

== REPLICA (|replica suffix) ==
 pg_is_in_recovery
-------------------
 t
(1 row)`)}
<p>Now the >30-second analytics query on that replica, with <code>\\timing</code> on:</p>
${pre(`-- terminal 2, connected to a source REPLICA (|replica credential)
\\timing on
SELECT a.kind, count(*) AS pairs, sum(a.amount) AS amount_sum
FROM events a JOIN events b ON a.user_id = b.user_id
GROUP BY 1 ORDER BY 1;`)}
<p>First attempt, no retries, no tuning:</p>
${pre(`Timing is on.
ERROR:  canceling statement due to conflict with recovery
DETAIL:  User query might have needed to see row versions that must be removed.
Time: 30269.430 ms (00:30.269)`)}
<p>Killed at 30.269 seconds — the 30-second <code>max_standby_streaming_delay</code> almost to the millisecond, because under this churn a conflicting vacuum-cleanup record arrives essentially immediately, so the grace clock starts at query start. The DETAIL line names the mechanism: vacuum cleanup of row versions the query's snapshot still needed.</p>

<h3 id="act2">Act 2 — sluice syncing continuously through the churn</h3>
<p>The same churn is running; the standing sync just applies it. The sync was started <em>while</em> the UPDATE loop hammered the source — the 3,000,000-row snapshot copied in ~19 seconds, then handed off to CDC (the log had zero WARN/ERROR lines end to end):</p>
${pre(`time=2026-07-09T00:23:01.855-07:00 level=INFO msg="cold start; snapshot captured"
time=2026-07-09T00:23:07.786-07:00 level=INFO msg="sync cold-start: fast parallel copy engaged (ADR-0079)" table_parallelism=1 within_table_parallelism=8 index_build_budget=0 raw_copy_eligible=true raw_copy_reason=""
time=2026-07-09T00:23:07.929-07:00 level=INFO msg="migration: phase complete" phase=tables
time=2026-07-09T00:23:26.269-07:00 level=INFO msg="migration: phase complete" phase=bulk_copy
time=2026-07-09T00:23:26.269-07:00 level=INFO msg="migration: phase complete" phase=indexes
time=2026-07-09T00:23:26.622-07:00 level=INFO msg="migration: phase complete" phase=constraints
time=2026-07-09T00:23:26.692-07:00 level=INFO msg="bulk-copy complete; entering CDC mode"
time=2026-07-09T00:23:28.991-07:00 level=INFO msg="laneapply: concurrent key-hash CDC apply engaged — routing row changes to W in-order lanes by primary-key hash, committing each lane concurrently on a dedicated pool; the resume position advances only to a source-tx boundary durable across all lanes (ADR-0104)" lanes_W=4 dedicated_backends=4`)}
<p><code>sync status</code>, two samples ~20 seconds apart while the churn ran — the LSN advancing, updated seconds ago:</p>
${pre(`STREAM     UPDATED               AGE     POSITION
analytics  2026-07-09T07:23:52Z  4s ago  {"slot":"sluice_slot","lsn":"0/45A35E68","systemid":"766042…

STREAM     UPDATED               AGE     POSITION
analytics  2026-07-09T07:24:10Z  1s ago  {"slot":"sluice_slot","lsn":"0/46EDEE38","systemid":"766042…`)}
<p>And the lag evidence from the same window — a <code>:9101/metrics</code> sample ~45 seconds after CDC entry, plus <code>sync health</code> exiting 0:</p>
${pre(`sluice_seconds_since_last_apply{stream_id="analytics"} 2
sluice_sync_lag_seconds{stream_id="analytics"} 48.6099`)}
${pre(`$ sluice sync health --stream-id analytics --target-driver postgres --target "$SLUICE_TARGET" --max-stale-seconds 60
stream: analytics
found: true
state: healthy
position: {"slot":"sluice_slot","lsn":"0/46EDEE38","systemid":"766042…
updated_at: 2026-07-09T07:24:10Z
seconds_since_last_apply: 3
health-exit:0`)}
<p>The 48.6-second <code>sluice_sync_lag_seconds</code> right after CDC entry is the initial catch-up: the churn generated WAL throughout the snapshot copy, and CDC starts from the pre-copy slot position, so the first apply batches carry old commit timestamps. <code>seconds_since_last_apply</code> at 2–3 seconds shows apply actively flowing. Under this run's deliberately <em>saturating</em> churn (~15k row-changes/s, above the target's apply throughput), lag kept growing while the storm ran and drained to zero once it stopped — the honest numbers are in the <a href="#caveats">caveats</a>.</p>

<h3 id="act3">Act 3 — the same query, on the analytics primary</h3>
<p>Same query text, same concurrent churn (still flowing into the target via sluice), but run on the analytics database's primary. It runs to completion — there is no recovery to conflict with:</p>
${pre(`Timing is on.
   kind   |   pairs   |  amount_sum
----------+-----------+---------------
 click    | 101003844 | 5046964144.54
 purchase | 101044120 | 5053641381.01
 refund   |  50467932 | 2524808050.13
 view     |  50435816 | 2523459562.89
(4 rows)

Time: 54789.578 ms (00:54.790)`)}
<p>54.8 seconds — comfortably past the 30-second guillotine that killed the identical query on the replica. The pair counts match the source exactly; the <code>amount_sum</code> values are <em>higher</em> than a pre-churn baseline because the churn's <code>amount = amount + 0.01</code> increments had already been applied to the target — the copy is genuinely live, not a stale snapshot.</p>
<p>And the freshness claim, proven rather than asserted — a marker row inserted on the source <em>while that query was running</em> (07:26:06Z, churn still active) arrived on the target intact, with its source-assigned id and timestamp, without disturbing the running query:</p>
${pre(`-- on the SOURCE primary, mid-query (07:26:06Z)
   id    |          kind           |              at
---------+-------------------------+-------------------------------
 3000001 | marker-20260709T072606Z | 2026-07-09 07:26:07.623209+00
(1 row)
INSERT 0 1

-- poll loop on the TARGET
arrived 07:33:09Z: 3000001|marker-20260709T072606Z|2026-07-09 07:26:07.623209+00`)}
<p>An honest number: the marker took ~7 minutes to land — not seconds — because it was queued, in commit order, behind the write-storm backlog (the churn's ~15k row-changes/s kept saturating the apply path until it was stopped; see the <a href="#caveats">caveats</a>). Nothing was lost and nothing reordered; once the storm stopped, the backlog drained, <code>sluice_sync_lag_seconds</code> collapsed to <code>0.0000</code>, and row counts matched exactly (source <code>3000001</code>, target <code>3000001</code>). Final health from that window:</p>
${pre(`$ sluice sync health --stream-id analytics --target-driver postgres --target "$SLUICE_TARGET" --max-stale-seconds 120
stream: analytics
found: true
state: healthy
position: {"slot":"sluice_slot","lsn":"0/8C039040","systemid":"766042…
updated_at: 2026-07-09T07:39:58Z
seconds_since_last_apply: 49
health-exit:0`)}
<p>(<code>--max-stale-seconds 120</code> on the final check because the source was by then idle apart from sluice's 1-minute stream heartbeats.)</p>

<h2 id="caveats">Caveats, honestly</h2>
<ul>
  <li><strong>Lag is logical and seconds-level, not sub-second — and a sustained write storm can outrun it.</strong> A physical streaming replica applies WAL microseconds-to-milliseconds behind the primary; sluice is logical replication — decode, translate, apply as transactions — and its steady-state lag under ordinary write rates is measured in seconds. The honest boundary, measured in the live run: a write rate <em>sustained</em> above the target's apply throughput grows lag for as long as it's sustained — the run's synthetic churn generated ~15k row-changes/s against ~4–5k/s of apply into a default-size PlanetScale target, and lag climbed 48.6&nbsp;→&nbsp;208 seconds over ~3 minutes — in order, nothing lost, zero errors, and the backlog drained to zero once the burst ended. Size the target for the write workload (or accept lag during sustained-heavy periods); the seconds-level claim holds for ordinary rates. Don't guess: watch <code>sluice_sync_lag_seconds</code> on <code>--metrics-listen</code>, gate on <code>sync health --max-stale-seconds</code>, and alert with <code>--notify-sync-lag-seconds</code>. For dashboards and ad-hoc analytics, data-as-of-a-few-seconds-ago is almost always fine; this pattern is <em>not</em> a read-your-writes replica.</li>
  <li><strong>It's a second database, and it costs second-database money.</strong> You're trading a bill line for query survivability and resource isolation. Size it primarily for the analytics workload — the apply stream is usually far lighter than the queries will be — but a source that <em>sustains</em> heavy write rates needs apply-throughput headroom on the target too (the lag caveat above).</li>
  <li><strong>The target is writable — enforce read-only by role, not convention.</strong> Use the <a href="#readonly">analyst role</a> above and never hand out the <code>postgres</code>-role DSN. A stray write to a synced table can collide with sluice's apply (a loud apply error, not silent corruption — but an operational headache). Analytics-only <em>additions</em> — extra indexes, materialized views, scratch schemas — are fine, but they live outside sluice's contract: a destructive recovery (<code>--reset-target-data</code>) drops the synced tables, and re-creating anything you hung off them is on you.</li>
  <li><strong>Very long analytics transactions can delay sluice's apply — gently.</strong> Plain row apply (INSERT/UPDATE/DELETE) is ordinary MVCC: readers don't block writers in Postgres, so your six-hour query and the apply stream coexist. The one real interaction is a <em>forwarded DDL</em>: an <code>ALTER TABLE</code> needs an exclusive lock, queues behind your long query, and briefly queues new queries behind itself — apply lag rises, your lag alert fires, and everything resumes when the query finishes. Apply waits; queries don't die. That's the whole point of the pattern — compare it with the replica's 30-second guillotine. (A days-long idle-in-transaction session also holds back vacuum on the analytics database itself; don't park transactions open there any more than you would on any primary.)</li>
  <li><strong>Sequences and identity counters are not continuously synced.</strong> CDC replicates row changes, not catalog-level sequence positions — irrelevant for a read-only analytics copy, since queries read rows, not <code>nextval()</code>. It only matters if you ever promote this copy to take writes; that's what <a href="/docs/commands/#cutover"><code>sluice cutover</code></a>'s sequence priming (<code>--sequence-margin</code>) is for.</li>
  <li><strong>Schema forwarding from a Postgres source has an honest per-shape matrix.</strong> Column adds, drops, and type changes forward; <code>CREATE INDEX</code>, <code>CHECK</code>, and nullability changes never signal on pgoutput's wire from a Postgres source, so they <em>cannot</em> forward — see the <a href="/docs/schema-changes/#the-flag">ground-truth table</a>. For this pattern that's mostly a feature (the target's index set is yours to design for analytics), but if you want a source index mirrored, create it on the target yourself.</li>
  <li><strong>The standing sync holds a replication slot on your production source — forever.</strong> That's the deal with logical replication: if the sync stops for a long time, the slot pins WAL on the <em>source</em> and its storage grows. sluice emits severity-graded slot-retention warnings ahead of trouble, but decommissioning this pattern means <code>sync stop --wait</code> <em>plus</em> <a href="/docs/commands/#slot"><code>sluice slot drop</code></a> — a slot is never auto-dropped. See <a href="/docs/postgres-source-prep/">Prepare a Postgres source</a> for the slot-lifecycle story.</li>
</ul>

<h2 id="next">Next steps</h2>
<ul>
  <li><a href="/docs/planetscale-postgres/">Migrate &amp; sync PlanetScale Postgres</a> — the connection recipe (roles, <code>sslmode</code>, ownership) this guide builds on.</li>
  <li><a href="/docs/schema-changes/">Schema changes during a sync</a> — the full <code>forward</code> / <code>refuse</code> semantics and the per-shape forwarding matrix.</li>
  <li><a href="/docs/operate-fleet/">Operate a sync fleet</a> — run this stream (and its siblings) under one supervised process, with the dashboard and the full alert-threshold set.</li>
  <li><a href="/docs/postgres-source-prep/">Prepare a Postgres source</a> — replication-slot lifecycle, retention warnings, and failover for the native CDC engine.</li>
  <li><a href="/docs/commands/#sync-start">sync start reference</a> — every flag named here, with defaults.</li>
</ul>
`,
    prev: { href: "/docs/planetscale-postgres-upgrade/", label: "Upgrade PlanetScale Postgres" },
    next: { href: "/docs/planetscale-region-move/", label: "Move PlanetScale regions" },
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
<p>For a terminal equivalent, <a href="/docs/commands/#sync-fleet">sync tui --connect</a> is a full-screen client that polls that same <code>/api/fleet</code> endpoint — so it works locally or over an SSH tunnel to the dashboard port, without disturbing the fleet process:</p>
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
    prev: { href: "/docs/managed-postgres-slotless/", label: "Managed Postgres (slot-less)" },
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
//  FIELD NOTES
// =========================================================================

// ---- Field Notes: index --------------------------------------------------
write(
  "field-notes",
  page({
    slug: "field-notes",
    title: "Field Notes",
    subtitle: "War stories from building a correctness-first migration tool — the engine behaviors, wire-protocol edges, and silent-corruption classes we hit, and what we changed because of them.",
    body: `
<p>sluice's first tenet is that a migration must never <em>silently</em> corrupt or lose data — a loud failure you can act on beats an exit 0 that quietly dropped four thousand rows. Living up to that means chasing down a lot of surprising database behavior: drivers that pick a different binary codec per column type, managed services with hidden query limits, replication phases that disagree with each other, precision edges that only bite above a specific integer. This section is where we write those up.</p>
<p>Field notes are <strong>evergreen engine-behavior documentation</strong>, not release announcements. Each one is a real thing we hit — most of them silent-corruption classes caught by fuzzing, battle-testing, or differential runs — with the mechanism explained, a repro you can run yourself, what sluice does about it, and the transferable lesson for anyone building on the same engines. Where the root cause is upstream (an open MySQL bug, a Vitess design choice), we say so and cite the public source; where it was our bug, we name it and link the fix.</p>
<p>None of these require sluice to reproduce — they are properties of Postgres, MySQL, Vitess, SQLite, and the wire protocols and drivers around them. If you move data between databases for a living, several of them will eventually be your problem too.</p>
<p>They're listed <strong>newest first</strong>, each dated to roughly when the work landed in sluice. The engine tag is just a signpost — the primary ordering is chronological, not by engine.</p>

<ul class="fn-list">
${FIELD_NOTES_NEWEST.map(
  (n) =>
    `  <li><span class="fn-when"><span class="fn-date">${n.date}</span><span class="fn-tag">${esc(n.engine)}</span></span> <a href="/field-notes/${n.slug}/">${esc(n.label)}</a> — ${n.dek}</li>`,
).join("\n")}
</ul>

<div class="note">These notes are also swept into <a href="/llms.txt"><code>llms.txt</code></a> / <a href="/llms-full.txt"><code>llms-full.txt</code></a>, so an AI assistant pointed at sluice's docs inherits this engine lore too.</div>
`,
  })
);

// ---- Field Notes: numeric[][] flatten ------------------------------------
write(
  "field-notes/numeric-array-flatten",
  page({
    slug: "field-notes/numeric-array-flatten",
    title: "The same bytes, a different codec: how numeric[][] silently flattened",
    subtitle: "We pinned multi-dimensional array support green on int[][] and text[][] and shipped. numeric[][] — running through byte-identical code — flattened a 2×2 matrix into a 1-D four-element array. Exit 0, no warning.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — Postgres target via the <code>pgx</code> driver. Regression introduced in sluice v0.69.3, fixed in v0.69.4 (internally, Bug 74).</p>

<h2 id="what-happened">What happened</h2>
<p>We fixed multi-dimensional array support in our Postgres <code>COPY</code> writer. We pinned it green on <code>int[][]</code> and <code>text[][]</code>, it passed independent review, and it shipped. Three days later a battle-test found that <code>numeric[][]</code> — running through <em>byte-identical sluice code</em> — was silently flattening a 2&times;2 matrix into a 1-D four-element array on the target. Exit 0, no warning, <code>array_dims</code> quietly wrong. A migration that reported complete had reshaped the data.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The bug wasn't in our code path at all. sluice built the same nested <code>[][]</code> value for every element type and handed it to pgx to encode. But <strong>pgx selects its binary codec per target OID</strong>: the codec for a <code>numeric</code> array element is a different object from the codec for an <code>int4</code> or <code>text</code> element. The int and text codecs recursed into the nested slice and preserved the dimensions; the numeric-element codec consumed the nested slice as a <em>flat</em> element list. Same input value, same sluice code, different driver branch underneath — chosen by the very dimension our tests didn't vary.</p>
<p>This is the general hazard of any encoder that dispatches on a type <em>family</em>: a green test on one representative type proves nothing about its siblings, because the layer beneath you may branch on the type you held constant.</p>

<h2 id="repro">The repro</h2>
<p>One row, no scale needed. Copy a source 2&times;2 <code>numeric</code> matrix into a Postgres <code>numeric[][]</code> column and ask the server for its dimensions:</p>
<pre><code>${esc(`CREATE TABLE m (id int PRIMARY KEY, grid numeric[][]);
-- the value sluice encodes for a source 2x2 matrix:
INSERT INTO m VALUES (1, '{{1.1,2.2},{3.3,4.4}}');

SELECT array_dims(grid) FROM m WHERE id = 1;
-- correct:                 [1:2][1:2]
-- before the fix (numeric codec): [1:4]   <- silently flattened to 1-D

-- int[][] and text[][], identical sluice code, were always correct:
--   [1:2][1:2]`)}</code></pre>
<p>Ground-truth the shape on the real server (<code>array_dims</code> plus each element's <code>::text</code>), not in a unit test that asserts against sluice's own in-memory value — the flattening happens in the driver's wire encoding, which an in-memory assertion never exercises.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The fix corrected the numeric-element encoding path, but the durable change was to the test doctrine. sluice now pins array support across the full matrix: <strong>every element family</strong> — native (int/float/bool), string-leaf (text/varchar/char/uuid/inet/cidr/macaddr/decimal), temporal (time/timestamp/timestamptz/date) — <strong>&times; {scalar/1-D, multi-dim ≥2-D, NULL-element}</strong>, with <code>src == dst</code> ground-truthed on the real target via <code>array_dims</code> and element <code>::text</code>. A representative type is no longer allowed to stand in for its family.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>When a change touches an encoder, decoder, or codec that <strong>dispatches on a type family</strong>, the test pin must exercise <em>every family and every shape variant</em>, not one representative. The driver or wire path beneath you can differ by the target type even when your own code is byte-identical, so &ldquo;the integration test is green&rdquo; is insufficient if the test exercises one family of a family-dispatched path. Pin the class, not the representative — and if you are reviewing such a change, re-derive the family matrix yourself rather than trusting the one green case.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>sluice type-mapping — <a href="/docs/type-mapping/#mysql-pg">array handling and the degradation policy</a>.</li>
  <li>The value contract sluice pins against: <a href="https://raw.githubusercontent.com/sluicesync/sluice/main/docs/value-types.md">docs/value-types.md</a>.</li>
  <li>pgx's per-OID codec registry (the underlying behavior): <a href="https://github.com/jackc/pgx">github.com/jackc/pgx</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: PlanetScale grow/reparent ------------------------------
write(
  "field-notes/planetscale-grow-reparent",
  page({
    slug: "field-notes/planetscale-grow-reparent",
    title: "PlanetScale acked our rows, then a storage-grow reparent un-acked them",
    subtitle: "A 5.5M-row migrate into PlanetScale MySQL returned exit 0 and “migration complete” — and landed 5,496,003 rows. About four thousand, gone in scattered whole-batch units, no error anywhere.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — bulk migrate into non-Metal PlanetScale (Vitess) MySQL, source row count 5,500,000. Internally Bug 175; the loss mechanism ties to ADR-0113, the coordinated fix to ADR-0110 / ADR-0141 (fixed v0.99.161).</p>

<h2 id="what-happened">What happened</h2>
<p>A migrate of 5,500,000 rows into a PlanetScale MySQL database reported success — exit 0, &ldquo;migration complete&rdquo; — and left <strong>5,496,003 rows</strong> on the target. Roughly four thousand rows were missing, in scattered whole-batch units, with no error logged on either side. The client had seen every batch commit and acknowledge. The rows the client believed were durable were simply not there.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>This is a genuine distributed-systems edge, not a sluice batching bug. On non-Metal PlanetScale, when the underlying volume fills during a bulk load:</p>
<ul>
  <li>the primary hits <code>Error 1114 (HY000): The table is full</code>;</li>
  <li>under storage pressure, semi-synchronous replication falls back to <strong>asynchronous</strong>;</li>
  <li>the storage-grow event triggers a <strong>reparent</strong> — a new primary is promoted;</li>
  <li>the new primary is promoted from <em>behind</em> the async-acked window, so rows the client saw committed and acknowledged on the old primary were never durably replicated, and are absent on the new one.</li>
</ul>
<p>A bulk load is exactly the workload that crosses grow thresholds — it's the one operation most likely to fill a volume fast enough to trigger the grow. So the loss lands precisely where you'd least want it: a large first import.</p>

<h2 id="repro">The repro</h2>
<p>This one reproduces operationally, not with a single statement. Instrument a live PlanetScale database near its volume floor (the cheapest repro tier starts at a ~12 GB floor) and bulk-load past the grow threshold. In our diagnostic, three runs froze at ~10.34 GB — about 86% of the 12 GB volume — right at the grow trigger, and a single-lane load stalled identically to a 16-lane one, ruling out write concurrency as the cause. Watch for the <code>Error 1114</code> transient and the primary changing underneath the stream; the missing rows cluster around that reparent instant, in whole batches, because the async gap is measured in transactions, not rows.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The fix needed two layers, because reactive retry alone can't recover an already-lost acked window:</p>
<ul>
  <li>A coordinated <strong>grow gate</strong>: the moment any write lane sees a grow-transient, all lanes quiesce and wait out the grow/reparent window together. Reactive per-lane retry alone bred a thundering herd — on the order of hundreds of simultaneous retries per grow window — so the gate coordinates instead of each lane fighting independently.</li>
  <li>A post-copy <strong>reconciliation</strong> phase that re-derives every reparent-touched table from the replayable source. The gate prevents new loss; reconciliation recovers the window that was already un-acked before the gate engaged. Reactive handling can never do the latter, because the lost rows were never on the new primary to retry against.</li>
</ul>
<p>A war-story footnote worth its own lesson: the first version of this fix shipped <em>inert</em> — a dead branch that never fired — and was caught only by live A/B revalidation (81 grow windows observed, 0 reconcile rounds triggered, when there should have been many). A fix for a silent-loss class has to be validated against the live behavior it targets, not just unit-tested; a green test on an unreachable branch is exactly as silent as the bug.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>&ldquo;The client received an ack&rdquo; is not the same as &ldquo;the row survived a failover.&rdquo; On any system where a storage event can trigger a reparent and replication can silently degrade from sync to async under pressure, acknowledged writes in the async window are lost across the promotion — and bulk loads are the workload most likely to cross that threshold. If you can replay the source, a post-load reconciliation of failover-touched tables is the only thing that closes the gap; retry logic alone treats a wound it can't reach.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>sluice PlanetScale guides — <a href="/docs/planetscale-vitess/">PlanetScale &amp; Vitess</a> and <a href="/docs/mysql-to-planetscale/">Self-hosted MySQL → PlanetScale</a>.</li>
  <li>MySQL <code>Error 1114</code> reference — <a href="https://dev.mysql.com/doc/mysql-errors/8.0/en/server-error-reference.html">MySQL server error reference</a>.</li>
  <li>Vitess reparenting (the promotion mechanism) — <a href="https://vitess.io/docs/reference/features/reparenting/">vitess.io reparenting docs</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: VStream FLOAT precision --------------------------------
write(
  "field-notes/vstream-float-precision",
  page({
    slug: "field-notes/vstream-float-precision",
    title: "Vitess's copy phase rounds your FLOATs; its binlog phase doesn't",
    subtitle: "MySQL renders FLOAT to 6 significant digits over the text protocol, so a stored, exact 8388608 comes back as 8388610. Vitess's VStream copy phase inherits it; its binlog phase doesn't — the same column, same row, arrives exact or rounded depending on which phase delivered it.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL 8.0.46 (also via <code>vttestserver</code> mysql80), Vitess/VStream copy phase. The root cause is <a href="https://bugs.mysql.com/bug.php?id=43262">MySQL Bug #43262</a>, open since 2009.</p>

<h2 id="what-happened">What happened</h2>
<p>Reading a Vitess/PlanetScale source over VStream, a single-precision <code>FLOAT</code> column that stored an exact value came back rounded — <code>8388608</code> arrived as <code>8388610</code>, <code>123456.789</code> as <code>123457</code> — but only for rows delivered by the <strong>copy</strong> phase. The very same column, for a row modified after copy and delivered by the <strong>binlog</strong> phase, was exact. A row that exists at copy time and is never touched again keeps the rounded value forever. Resharding or moving a table can therefore permanently alter its <code>FLOAT</code> data in the 7th significant digit.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>MySQL formats <code>FLOAT</code> over the text protocol at <code>FLT_DIG = 6</code> significant digits — the number MySQL <em>guarantees</em> round-trips for any input. But a <code>binary32</code> carries about 7.2 decimal digits, and round-tripping an arbitrary one needs up to <code>FLT_DECIMAL_DIG = 9</code>. Six digits is lossy whenever the 7th significant digit is meaningful. This is <a href="https://bugs.mysql.com/bug.php?id=43262">MySQL Bug #43262</a>, documented in the manual under <a href="https://dev.mysql.com/doc/refman/8.0/en/problems-with-float.html">B.3.4.8, &ldquo;Problems with Floating-Point Values.&rdquo;</a></p>
<p>Vitess inherits it in the one place it hurts most. The rowstreamer <strong>copy</strong> phase reads rows with a text-protocol <code>SELECT &lt;columns&gt; ... ORDER BY &lt;pk&gt;</code>, so a <code>FLOAT</code> column arrives already rounded to the 6-digit text form — the exact bits are gone before Vitess's Go layer ever sees them. The <strong>binlog</strong> phase, by contrast, re-encodes the raw <code>binary32</code> bits with Go's shortest-round-trip formatter (<code>strconv.AppendFloat(float64(f32), 'E', -1, 32)</code>, in <code>go/mysql/binlog/rbr.go</code>) and is exact. So Vitess produces the exact form on one of its two paths and the rounded form on the other, for the same value. <code>DOUBLE</code> is unaffected (MySQL renders it at full <code>dtoa</code> precision); this is single-precision <code>FLOAT</code>/<code>REAL</code> only.</p>

<h2 id="repro">The repro</h2>
<p>Server-level and tool-independent — no Vitess required to see the rounding, since it's MySQL's text rendering:</p>
<pre><code>${esc(`CREATE TABLE f (id INT PRIMARY KEY, v FLOAT, d DOUBLE);
INSERT INTO f VALUES (1, 8388608, 8388608),
                     (3, 123456.789, 123456.789),
                     (4, 16777217, 16777217);

-- Text protocol (what the copy-phase SELECT returns):
SELECT id, v AS float_text, d AS double_text FROM f;
--  1   8388610    8388608       <- FLOAT rounded, DOUBLE exact
--  3   123457     123456.789
--  4   16777200   16777217

-- The stored FLOAT is exact; only the text rendering is lossy:
SELECT v = CAST(8388608 AS FLOAT) AS stored_is_exact FROM f WHERE id = 1;  -- 1 (true)

-- And the rounding isn't idempotent — restoring the rounded text
-- yields a DIFFERENT binary32:
SELECT CAST(8388610 AS FLOAT) = CAST(8388608 AS FLOAT) AS same;            -- 0 (false)`)}</code></pre>
<p>The stored value is a perfect <code>binary32</code>; the copy-phase text rendering is what loses it, and the loss can't be undone by re-parsing — the rounded decimal maps to a different <code>binary32</code>.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>A VStream consumer can't fix this client-side: the copy <code>SELECT</code> is built inside vttablet's rowstreamer and doesn't honor a client-supplied projection expression — <code>analyzeExpr</code> in <code>go/vt/vttablet/tabletserver/vstreamer/planbuilder.go</code> rejects arithmetic like <code>col * 1E0</code> in a stream filter. So sluice works around it with a <strong>post-copy exact re-read</strong>: after the copy phase, it re-reads <code>FLOAT</code> columns with an out-of-band <code>SELECT (col * 1E0) ...</code> through vtgate, which forces MySQL to render at full precision, and patches the rounded copy values. That's only possible for a consumer that also has a direct SQL path to the source and can absorb a second read — which is exactly why the right home for the fix is upstream in rowstreamer.</p>
<p>That patch has a memory cliff of its own, and it's a clean illustration of when you <em>can't</em> stream. Reconciling the exact re-read against the rounded copy rows is a textbook <strong>merge-join</strong> — and a bounded merge-join needs monotonically-ordered keys on <em>both</em> sides. The VStream copy side has neither: vttablet's rowstreamer scans by whatever unique key is cheapest (not necessarily your primary key), and it re-emits rows already behind its own cursor during binlog catch-up — out of order, with duplicates. With no shared ordering to exploit, there is no safe streaming join, so the repair falls back to holding a whole-table primary-key&rarr;float map in memory, which at 100M rows is gigabytes. sluice therefore caps it (<code>--float-reread-max-rows</code>, default 2M) and degrades <em>loudly</em> — keep the rounded value with a WARN by default, or refuse under <code>--strict-float</code> — rather than OOM on a large table. The negative result is the portable bit: a &ldquo;scan the table twice and join the passes&rdquo; plan silently assumes both passes are co-ordered, and a resharding engine that scans by a secondary key and re-emits behind its cursor breaks that assumption, leaving unbounded memory as the only fallback.</p>
<p>We've <strong>written up an upstream issue</strong> for vitessio/vitess describing the copy-vs-replication inconsistency and proposing two server-side fixes — widen the copy <code>SELECT</code> to project the column as a double (<code>CAST(col AS DOUBLE)</code>, so MySQL renders round-trippable precision and the target narrows back to the exact <code>binary32</code>), or read the copy via the binary protocol and reuse the same shortest-round-trip formatter the binlog path already uses in <code>rbr.go</code>. The argument is deliberately narrow: <code>FLOAT</code> is an approximate type, granted, but a row's value shouldn't depend on <em>which</em> Vitess phase delivered it, and Vitess already produces the exact form on one of its two paths. (The write-up references <a href="https://bugs.mysql.com/bug.php?id=43262">MySQL Bug #43262</a>, the manual's <a href="https://dev.mysql.com/doc/refman/8.0/en/problems-with-float.html">B.3.4.8</a>, and the public Vitess source paths above; it is drafted, not yet filed.)</p>

<h2 id="lesson">The transferable lesson</h2>
<p>When a system has two independent paths to deliver the same data — a bulk copy and a change stream, a dump and a replica — check that they agree on precision, not just on content. A 17-year-old upstream display-rounding bug is harmless in a <code>mysqldump</code> you reload once, but it becomes a silent, permanent data alteration when it rides one of two phases in a resharding pipeline and the other phase is exact. The corruption hides in static rows precisely because the rows that <em>are</em> modified later get corrected by the exact path.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li><a href="https://bugs.mysql.com/bug.php?id=43262">MySQL Bug #43262</a> — the canonical <code>FLT_DIG</code> display-rounding bug (open since 2009).</li>
  <li><a href="https://dev.mysql.com/doc/refman/8.0/en/problems-with-float.html">MySQL 8.0 Reference Manual B.3.4.8</a> — &ldquo;Problems with Floating-Point Values.&rdquo;</li>
  <li><a href="https://vitess.io/docs/reference/vreplication/internal/life-of-a-stream/">Vitess VReplication &mdash; &ldquo;Life of a Stream&rdquo;</a> — documents the copy-phase <code>SELECT ... ORDER BY &lt;pk&gt;</code>.</li>
  <li>Vitess's exact binlog formatter: <code>go/mysql/binlog/rbr.go</code>; the projection-expression restriction: <code>go/vt/vttablet/tabletserver/vstreamer/planbuilder.go</code> (<a href="https://github.com/vitessio/vitess">github.com/vitessio/vitess</a>).</li>
</ul>
`,
  })
);

// ---- Field Notes: FLOAT in the primary key -------------------------------
write(
  "field-notes/float-in-primary-key",
  page({
    slug: "field-notes/float-in-primary-key",
    title: "When the row's own identity gets rounded",
    subtitle: "The VStream FLOAT repair re-reads the source exactly and matches rows by primary key. That works perfectly — until the FLOAT is part of the primary key. Then the target's copy of the key is itself rounded, the exact re-read never finds its row, the repair silently no-ops, and --strict-float exits 0 with a rounded archive.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — PlanetScale / self-hosted Vitess source over VStream. A companion to <a href="/field-notes/vstream-float-precision/">Vitess's copy phase rounds your FLOATs</a>: this is the corner where the repair that note describes cannot help.</p>

<h2 id="what-happened">What happened</h2>
<p>A VStream cold-start COPY display-rounds single-precision <code>FLOAT</code> to 6 significant digits, and sluice repairs that by re-reading the affected columns exactly and correcting the target. But a table declared <code>PRIMARY KEY (id, f)</code> with a <em>non-PK</em> <code>FLOAT</code> column <code>g</code> came out of the repair with <code>g</code> still rounded — and worse, <code>backup full --strict-float</code>, whose entire contract is &ldquo;exact, or fail; never rounded,&rdquo; exited 0 and wrote a rounded archive. The one flag built to make a rounded archive impossible produced one, silently.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The repair keys row identity on the primary key. It re-reads each repairable table's <code>FLOAT</code> columns exactly from the source (<code>(col * 1E0)</code> forces full-precision rendering) and then, for sync, issues <code>UPDATE t SET g = ? WHERE id = ? AND f = ?</code> to patch the target row; for backup, it builds a PK&rarr;exact-floats map and patches each archived COPY row. Both paths assume the primary-key value is stable between the two sides being matched. When a <code>FLOAT</code> is <em>in</em> the primary key, that assumption breaks: the bulk COPY wrote the PK's <code>f</code> column display-<em>rounded</em>, while the exact re-read scans <code>f</code> at full precision. The two values differ, so the <code>WHERE ... AND f = ?</code> matches zero rows. Zero-rows-affected is, by design, a silent no-op — the table is counted as repaired, exit 0. The <code>--strict-float</code> refusal nets didn't cover this mixed shape (a FLOAT in the PK <em>and</em> another FLOAT outside it), so it fell between them.</p>
<p>The corollary is wider than the repair machinery: a float-in-PK table on a VStream source has its row <em>identity</em> rounded on the target, so subsequent CDC <code>UPDATE</code>/<code>DELETE</code> events — which carry the exact float32 PK — also miss those rows.</p>

<h2 id="repro">The repro</h2>
<p>A PlanetScale/Vitess source, a FLOAT in the primary key, and a value that needs more than 6 significant digits:</p>
<pre><code>${esc(`CREATE TABLE t (
  id INT,
  f  FLOAT,   -- part of the PK, needs > 6 sig digits (e.g. 8388608)
  g  FLOAT,   -- a plain FLOAT column
  PRIMARY KEY (id, f)
);

-- Cold-start COPY writes the PK's f rounded (8388608 -> 8388610).
-- The exact re-read scans f = 8388608 and tries:
--   UPDATE t SET g = <exact> WHERE id = ? AND f = 8388608
-- The target row's f is 8388610, so zero rows match: g stays rounded.
-- backup full --strict-float: the PK->floats patch key never matches,
--   rows archive rounded, and the mixed shape exits 0.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>A table whose primary key contains a single-precision <code>FLOAT</code> is now classified <strong>non-repairable</strong> through one shared predicate used by <em>both</em> the sync cold-start and backup paths — so the rule can't drift between them. That routes the table to the honest &ldquo;this table cannot be repaired&rdquo; warning and, under <code>--strict-float</code>, to an upfront refusal instead of a rounded archive at exit 0. Tables with no <code>FLOAT</code> in the primary key are unaffected and still repaired exactly, as before.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>Precision loss in a <em>value</em> is a bounded problem — you can re-read it, patch it, warn about it. Precision loss in an <em>identity</em> is a different animal: it silently breaks every operation that keys on that identity, all at once and with no error, because the lookups simply don't match anymore. Before you build a repair, a merge, or a change-apply that matches rows by key, check that the key itself survives every path it travels — a key that rounds is a key that can't be joined on.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li><a href="https://bugs.mysql.com/bug.php?id=43262">MySQL Bug #43262</a> — the <code>FLT_DIG</code> display-rounding of single-precision <code>FLOAT</code> that starts this whole chain.</li>
  <li><a href="https://dev.mysql.com/doc/refman/8.0/en/problems-with-float.html">MySQL 8.0 Reference Manual B.3.4.8</a> — &ldquo;Problems with Floating-Point Values.&rdquo;</li>
  <li>The value it can repair, and how — <a href="/field-notes/vstream-float-precision/">Vitess's copy phase rounds your FLOATs</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: xid8 wraparound in CDC ---------------------------------
write(
  "field-notes/xid-wraparound-cdc",
  page({
    slug: "field-notes/xid-wraparound-cdc",
    title: "Comparing 32-bit transaction ids breaks after four billion of them",
    subtitle: "A trigger-CDC hold-back compared a change row's 32-bit xmin against a 64-bit xid8 snapshot bound. At XID epoch 0 the two domains coincide and everything works; once a cluster crosses 2^32 lifetime transactions the predicate goes always-true and silently skips an in-flight transaction's rows.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — the <code>postgres-trigger</code> CDC engine (trigger-based capture, no replication slot). Live-confirmed on a <code>pg_resetwal -e 5</code> epoch-bumped PostgreSQL 16.</p>

<h2 id="what-happened">What happened</h2>
<p>The <code>postgres-trigger</code> engine's snapshot&rarr;CDC cold-start handoff has two guards that decide which change-log rows are safe to hand off: a safety-lag <em>hold-back</em> and the cold-start <em>anchor</em>. Both compared a change-log row's system <code>xmin</code> against the boundary of the copy's snapshot. On a fresh cluster this is correct. On a long-lived, busy cluster whose lifetime transaction count has crossed 2<sup>32</sup>, the hold-back predicate becomes <em>always true</em> — the watermark advances past an in-flight transaction's already-allocated change-log ids, and that transaction's changes are silently skipped when it commits — and the anchor's <code>&gt;=</code> arm <em>never</em> matches, degenerating to <code>MAX(id)</code> and re-opening a cold-start gap. Exit 0, zero warnings, missing rows.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>Postgres's transaction id (<code>xid</code>) is a 32-bit counter that wraps. To compare ids across the wraparound boundary Postgres offers <code>xid8</code> — a 64-bit, <em>epoch-extended</em> id that never wraps in practice. The bug was a cross-domain comparison hiding in plain sight: the change-log row's system <code>xmin</code> is a 32-bit epoch-less <code>xid</code>, while <code>pg_snapshot_xmin(pg_current_snapshot())</code> returns a 64-bit epoch-carrying <code>xid8</code>. At epoch 0 the numeric values coincide, so the comparison looks correct and passes every test written on a young database. Past 2<sup>32</sup> lifetime transactions the epoch on the <code>xid8</code> side is &ge; 1 while the raw <code>xmin</code> has wrapped back toward 0 — the two numbers are now in different domains, and the ordering the predicate depends on is meaningless. An in-code comment had even treated the cast as a JSON-precision detail rather than a cross-domain comparison.</p>

<h2 id="repro">The repro</h2>
<p>You don't have to run four billion transactions — <code>pg_resetwal</code> can move the epoch directly:</p>
<pre><code>${esc(`# Bump the XID epoch on a stopped cluster so snapshot xmin > 2^32:
pg_resetwal -e 5 $PGDATA
# Start it, run the trigger-CDC cold-start handoff, and observe:
#   - the hold-back predicate emits a committed row while an older
#     transaction with a LOWER change-log id is still open
#   - the anchor query returns MAX(id) instead of the intended bound
# At epoch 0 (a fresh initdb) the identical handoff is correct.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Both queries now compare the capture trigger's own <code>txid</code> column — recorded as <code>pg_current_xact_id()::text::bigint</code>, which is <code>xid8</code> on <em>both</em> sides of the comparison — instead of the row's 32-bit system <code>xmin</code>. That is what the engine's design intended all along: <code>txid</code> has been <code>NOT NULL</code> since the engine's first release, so existing installs need no <code>ALTER</code>, and behavior at epoch 0 is byte-for-byte unchanged (verified live). The fix is pinned by SQL-shape unit tests plus an epoch-bump integration test that gates on <code>pg_resetwal -e 5</code> pushing snapshot <code>xmin</code> above 2<sup>32</sup> and asserts the hold-back and anchor land correctly.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>Postgres transaction ids are 32 bits and they wrap — that is not an edge case, it is the routine steady state of any long-lived busy cluster (it is why autovacuum exists). Any comparison of transaction ids that must stay correct across the life of the database has to be done in the <code>xid8</code> / epoch-extended domain, on both sides. A comparison that mixes a 32-bit <code>xid</code> with a 64-bit <code>xid8</code> is a time bomb whose fuse is exactly 2<sup>32</sup> transactions long, and it will test green for the entire life of your CI.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li><a href="https://www.postgresql.org/docs/current/routine-vacuuming.html#VACUUM-FOR-WRAPAROUND">PostgreSQL — Preventing Transaction ID Wraparound Failures</a> — why 32-bit xids wrap and the epoch matters.</li>
  <li><a href="https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-INFO-SNAPSHOT">PostgreSQL — Transaction ID and Snapshot Information Functions</a> — <code>xid8</code>, <code>pg_current_xact_id()</code>, <code>pg_snapshot_xmin()</code>.</li>
  <li>sluice's trigger-CDC handoff — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: three clouds, three signatures -------------------------
write(
  "field-notes/three-clouds-three-signatures",
  page({
    slug: "field-notes/three-clouds-three-signatures",
    title: "Three clouds, three ways to return an ECDSA signature",
    subtitle: "AWS and GCP hand back an ECDSA signature as ASN.1 DER; Azure returns raw r‖s. Only GCP signs Ed25519, and only GCP wants a CRC32C integrity handshake in both directions. Adding two clouds to a working KMS signer was not a copy-paste — it was normalizing three wire formats to one.",
    body: `
<p class="fn-meta"><strong>Landed</strong> — KMS-backed backup-manifest signing, where the private key stays in the cloud HSM and verification is pure local crypto. AWS KMS came first; GCP KMS and Azure Key Vault completed the three-cloud matrix. Signing is opt-in.</p>

<h2 id="what-happened">What happened</h2>
<p>sluice can sign a backup manifest with a key that never leaves a cloud KMS: an <code>AsymmetricSign</code> / <code>Sign</code> call returns a signature, and a later restore verifies it locally against the operator's trusted public key. That worked cleanly with AWS. Extending it to GCP KMS and Azure Key Vault behind the <em>same</em> scheme — so a GCP- or Azure-signed chain verifies identically to an AWS one — turned out to be almost entirely about reconciling how each provider encodes what is, mathematically, the same signature.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>An ECDSA signature is a pair of integers <code>(r, s)</code>. There are two common ways to put that on the wire, and the three clouds don't agree:</p>
<ul>
  <li><strong>AWS and GCP</strong> return ECDSA as <strong>ASN.1 DER</strong> — the <code>SEQUENCE { INTEGER r, INTEGER s }</code> encoding.</li>
  <li><strong>Azure</strong> returns raw <strong><code>r‖s</code></strong> — the two integers concatenated as fixed-width big-endian, the IEEE&nbsp;P1363 form, no DER wrapper.</li>
</ul>
<p>That fixed width is where a specific trap lives: for P-521 each half is 66 bytes (521 bits rounds up to 66 bytes), an odd width that off-by-one conversions get wrong precisely because it isn't a clean power of two. Two more divergences: only <strong>GCP</strong> offers <strong>Ed25519</strong> signing (and Ed25519 signs the whole message with no client-side pre-digest, unlike the ECDSA/RSA-PSS digest-then-sign flow), and only GCP wraps its calls in a <strong>CRC32C</strong> wire-integrity handshake — the server echoes the CRC of the digest it received and returns a CRC of the signature it produced. Finally, the providers disagree on how they hand you the <em>public</em> key for verification: AWS and GCP export SPKI (the standard <code>SubjectPublicKeyInfo</code> DER), while Azure exports a <strong>JWK</strong> (a JSON object of base64url key parameters).</p>

<h2 id="repro">The repro</h2>
<p>Ask each provider to sign the same digest with a P-256 key and look at the bytes:</p>
<pre><code>${esc(`# AWS KMS  -> DER:      30 44 02 20 <r...> 02 20 <s...>
# GCP KMS  -> DER:      30 45 02 21 00 <r...> 02 20 <s...>
# Azure KV -> raw r||s: <32 bytes r><32 bytes s>   (P-256; P-521 = 66+66)

# A verifier that only speaks DER (ecdsa.VerifyASN1) accepts the first two
# and rejects Azure's bytes outright -- they must be transcoded r||s -> DER
# BEFORE they reach the verifier. Get P-521's 66-byte half wrong and the
# transcode silently produces a signature that never verifies.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The verifier stays single-form: it validates ECDSA as DER and never has to know which cloud produced the signature. The provider-specific work is pushed into the signer adapters. Azure's adapter converts <code>r‖s</code> to ASN.1 DER before returning — and that conversion is pinned across P-256, P-384, and P-521, with P-521's 66-byte half specifically covered, because a codec that dispatches on curve width has to be tested at every width, not one representative. GCP's CRC32C is checked in <em>both</em> directions and any mismatch is refused loudly rather than emitting a possibly-corrupted signature; its Ed25519 path is wired through the same scheme. Azure's JWK public key is rebuilt into a standard-library key (with the RSA exponent range-guarded). Critically, the <em>provider</em> is not recorded in the on-disk format at all — only the algorithm is — so an AWS-, GCP-, or Azure-signed chain all verify by exactly the same code path, and verification always anchors on the operator's supplied trusted key, never a key the manifest names.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>&ldquo;We support KMS signing&rdquo; hides a lie of composition: KMS signing is not one API, it is three (or more) APIs that happen to compute the same primitive and then disagree about how to hand it back — signature encoding, public-key export, integrity framing, which algorithms exist at all. If you're going to verify signatures across providers, do the normalization at the edge: convert every provider's native wire form to one canonical form as it enters, keep the verifier single-form, and pin the conversion at every parameter (every curve, every key size) the provider can emit — the P-521 odd-width half is exactly the case a single representative test will miss.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li><a href="https://datatracker.ietf.org/doc/html/rfc8032">RFC 8032</a> — EdDSA / Ed25519 (signs the whole message, no pre-digest).</li>
  <li><a href="https://datatracker.ietf.org/doc/html/rfc3279#section-2.2.3">RFC 3279 §2.2.3</a> — the ASN.1 DER <code>Ecdsa-Sig-Value SEQUENCE { r, s }</code> AWS and GCP return; contrast the raw fixed-width <code>r‖s</code> of IEEE&nbsp;P1363 that Azure returns.</li>
  <li><a href="https://datatracker.ietf.org/doc/html/rfc7517">RFC 7517</a> — JSON Web Key (JWK), the form Azure Key Vault exports a public key in.</li>
  <li><a href="https://cloud.google.com/kms/docs/data-integrity-guidelines">Google Cloud KMS — data-integrity guidelines</a> — the CRC32C request/response checksums.</li>
  <li>The signature that verified the <em>wrong</em> data — <a href="/field-notes/signed-manifest-chunk-binding/">A signature that verified green while restoring the wrong table's rows</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: signed manifest chunk binding --------------------------
write(
  "field-notes/signed-manifest-chunk-binding",
  page({
    slug: "field-notes/signed-manifest-chunk-binding",
    title: "A signature that verified green while restoring the wrong table's rows",
    subtitle: "A signed, encrypted backup flattened every table's row chunks into one file-sorted list with no parent-table token. Swap the chunk lists of two tables that share a column set and the signed bytes are byte-identical — every guard passes, and one table's rows restore into the other.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — signed, encrypted backup chains (signing is opt-in). Found by an internal audit of the manifest-signing format; a skeptic confirmed it <em>by execution</em>. Fixed by binding the parent table into both the signature and the encryption.</p>

<h2 id="what-happened">What happened</h2>
<p>Backup manifest signing exists to make store-level tampering detectable: an adversary with write access to the backup bucket (but <em>not</em> the encryption key) should not be able to alter a signed backup without the signature failing. It caught whole-manifest rollback, change-list truncation, and table renames. But it did not catch one thing: reassigning row chunks <em>between two existing tables that share a column set</em>. Swap the row-chunk lists of <code>orders_2023</code> and <code>orders_2024</code> — or any two same-schema shards or multi-tenant clones — and the manifest and lineage signatures both verify GREEN, the encrypted chunks decrypt cleanly, the column-set and row-count checks pass, and table B's rows restore into table A. Silent cross-table corruption, surviving the exact feature built to prevent tampering.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>A signature only authenticates the associations it actually encodes into its signed bytes. The manifest canonicalization flattened <em>every</em> table's row chunks into one globally file-sorted list of <code>rowchunk | file | sha256 | rowcount</code> tokens — with no parent-table token in each entry. Change chunks bound their replay ordinal; schema deltas bound their table name; row chunks were the gap. So the signed byte stream encoded &ldquo;this set of chunk files exists, with these hashes and row counts&rdquo; but not &ldquo;<em>this</em> chunk belongs to <em>that</em> table.&rdquo; Swapping two same-column-set tables' chunk lists preserves the exact multiset of tokens — same files, same hashes, same counts — so the canonical bytes are identical and the signature still matches. The second layer didn't cover it either: the encrypted-chunk GCM AAD (the authenticated-but-not-encrypted associated data that ties a ciphertext to its context) bound only the manifest identity and the chunk's file path — not the table — so a ciphertext moved between tables still passed its GCM tag.</p>

<h2 id="repro">The repro</h2>
<p>Two tables with the same column set, in a signed encrypted chain; swap their chunk assignments so the per-table totals are preserved:</p>
<pre><code>${esc(`# Signed, encrypted backup with two same-column-set tables A and B.
# A store-write adversary swaps the row-chunk lists in the manifest:
#   A.chunks <-> B.chunks   (per-table row totals unchanged)
#
# Verify:
#   manifest signature   -> GREEN  (token multiset identical)
#   lineage signature    -> GREEN
#   column-set header    -> passes (A and B share columns)
#   per-table row counts -> passes
#   GCM chunk decrypt    -> passes (AAD binds path, not table)
# Restore: B's rows land in A and A's in B. Exit 0.`)}</code></pre>
<p>The audit's skeptic didn't argue this on paper — a throwaway test that swapped the two tables' chunk slices produced byte-identical canonical bytes, confirming the forgery.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The fix binds the parent table on <em>both</em> layers, each independently versioned and fail-closed. The signature canonicalization is bumped v3&rarr;v4 to fold each row chunk's <code>(schema, name)</code> into its signed token, reusing the existing length-prefixed framing so the encoding stays injective. Independently, a signed encrypted backup's row-chunk GCM AAD is bumped to a new backup FormatVersion that appends the schema and table to the associated data — so a ciphertext moved between tables fails its GCM tag <em>even without</em> the signature. The dual-version verifier is unchanged: signatures written by older releases still verify byte-for-byte, a v4 signature presented to an older binary refuses as an &ldquo;upgrade sluice&rdquo; version gap rather than a false tamper accusation, and a v4&rarr;v3 downgrade-relabel that tried to strip the new parent tokens fails the MAC — so the back-compat path is not a downgrade oracle. Table renames were always caught; this closes chunk <em>reassignment</em> between existing same-column-set tables.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>A signature is not a general-purpose integrity charm — it authenticates exactly the bytes you canonicalize, and nothing you leave out. If two genuinely different states can serialize to the same signed bytes, the signature cannot tell them apart, and no amount of key strength changes that. The property to reason about is <em>canonicalization injectivity</em>: distinct logical states must map to distinct signed bytes. When you sign a structure, enumerate every association a consumer will <em>act on</em> after verification — here, which chunk belongs to which table — and make sure each one is inside the signed bytes (and, for encrypted data, inside the AEAD's associated data too). The gap is always the association you assumed was implied.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li><a href="https://datatracker.ietf.org/doc/html/rfc5116">RFC 5116</a> — authenticated encryption with associated data (AEAD): what the &ldquo;associated data&rdquo; is for and why binding context into it matters.</li>
  <li><a href="https://csrc.nist.gov/pubs/sp/800/38/d/final">NIST SP 800-38D</a> — Galois/Counter Mode (GCM), the AEAD whose AAD now carries the table identity.</li>
  <li>The three-cloud signer feeding these signatures — <a href="/field-notes/three-clouds-three-signatures/">Three clouds, three ways to return an ECDSA signature</a>.</li>
  <li>sluice's encrypted-backup model — <a href="/docs/encrypted-backups/">Encrypted backups</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: workload=olap chunked truncation -----------------------
write(
  "field-notes/olap-workload-truncation",
  page({
    slug: "field-notes/olap-workload-truncation",
    title: "Setting workload=olap silently truncated our chunked reads",
    subtitle: "A one-line change set vtgate's workload=olap session-wide to lift a 100k-row cap on no-PK scans. The parallel chunked reader inherited the setting, each concurrent chunk streamed only a prefix, and a 1.5M-row migrate copied 7,536 rows — exit 0, migration complete.",
    body: `
<p class="fn-meta"><strong>Observed + bisected</strong> — a PlanetScale / Vitess source (reproduced on <code>vttestserver</code>). The version bisection is clean; the exact behavior <em>inside</em> vtgate that truncates a bounded chunk read under session-wide OLAP was observed but not root-caused down into the gateway (see below).</p>

<h2 id="what-happened">What happened</h2>
<p>A <code>migrate</code> from a Vitess/PlanetScale source, of a table large enough to be split into parallel copy chunks, at the default parallelism, silently copied a tiny fraction of the rows and reported success. The measured shape was stark: 1,500,000 source rows, 7,536 copied, exit 0 with <code>migration complete tables=1</code>. Dropping to <code>--bulk-parallelism=1</code> (a single stream) copied all 1,500,000. Vanilla (non-Vitess) MySQL sources were never affected, and neither were tables below the chunking threshold — which is exactly why the existing test suite, built on small tables, never saw it.</p>

<h2 id="why">Why (as far as we bisected it)</h2>
<p>vtgate's default OLTP workload caps a single result set at roughly 100,000 rows. A no-PK full-table scan is one big streaming <code>SELECT</code> that can't be primary-key-chunked, so it hit that cap and truncated. The fix for <em>that</em> was to set <code>workload=olap</code> (which streams, lifting the cap) on the source reader — but it was set <strong>session-wide</strong>. That session setting also covered the <code>LIMIT</code>-paged, bounded <code>WHERE pk BETWEEN lo AND hi</code> reads that the parallel chunked bulk-copy uses for large PK tables. Under OLAP streaming mode, each concurrently-read chunk's page came back truncated to a small prefix, and sluice treated end-of-(truncated)-stream as &ldquo;chunk complete&rdquo; — so the un-read tail of every chunk was silently dropped.</p>
<p>Stated honestly: the diagnosis rests on a clean deterministic version bisection (the release before the <code>workload=olap</code> change copied every row; that change is the only relevant difference) plus per-chunk row-count logs that summed to the truncated total. The precise mechanism by which session-wide OLAP truncates a <em>bounded, paged</em> read inside vtgate was not chased into the gateway's source, and whether it reproduces on real PlanetScale at scale versus being a <code>vttestserver</code>/<code>vtcombo</code> streaming interaction was left an open question. The fix removes session-wide OLAP from the paged reads entirely, so it closes the gap regardless of which it was.</p>

<h2 id="repro">The repro</h2>
<p>Deterministic on <code>vttestserver:mysql80</code> with a 1.5M-row bigint-PK table; only the version and parallelism differ:</p>
<pre><code>${esc(`sluice version   --bulk-parallelism   rows copied (of 1,500,000)   exit
--------------   ------------------   -------------------------   ----
pre-olap         default (8)          1,500,000  ✓                 0
olap session-wide default (8)         7,536      ✗                 0
olap session-wide 1 (single stream)   1,500,000  ✓                 0`)}</code></pre>
<p>A 1,000-row table copies fully even on the affected version — the loss only appears above the chunk threshold, which is precisely the region the sub-threshold test corpus never exercised.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p><code>workload=olap</code> is now scoped to <em>just</em> the unbounded no-PK full scan — the one read that actually needs the cap lifted — and applied on a dedicated connection, never session-wide. The <code>LIMIT</code>-paged batch reader the chunked copy uses is OLAP-free again, exactly as it was before the regression, so the parallel copy reads every row while the no-PK cap lift it was added for is preserved. An operator-supplied <code>workload</code> in the DSN still wins. It's pinned by a regression test that migrates an above-threshold PK table at parallelism &gt; 1 and asserts exact row-count parity — the chunk-threshold dimension the prior pins missed.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>A session variable is a blunt instrument: it changes the behavior of <em>every</em> statement on that connection, including ones you weren't thinking about when you set it. Here a knob added to make one read return <em>more</em> rows made a different, unrelated read return <em>fewer</em> — and because the loss was scale-dependent and silent, it sailed past a test suite that only ever ran small tables. Scope a session setting to exactly the code path that needs it (a dedicated, short-lived connection), and when a change alters how much data a query returns, add a test at the scale where the two behaviors actually diverge.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li><a href="https://vitess.io/docs/reference/query-serving/schema-tracking/">Vitess documentation</a> and the OLAP vs OLTP workload modes vtgate exposes (OLAP streams results and lifts the OLTP result-set cap; it also forbids transactions).</li>
  <li>sluice's parallel bulk-copy and chunking model — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: redaction, two engines ---------------------------------
write(
  "field-notes/redact-two-engines",
  page({
    slug: "field-notes/redact-two-engines",
    title: "One redaction flag: clamp on MySQL, refuse on Postgres",
    subtitle: "--redact randomize:int:100000,200000 into a SMALLINT column loud-refused on a Postgres target and silently clamped every row to 32767 on a MySQL one — turning an anonymization rule into a constant, and a compliance guarantee into a compliance failure.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — a PG&rarr;MySQL cross-engine migrate with a <code>randomize:int</code> redaction rule, compared against the same rule PG&rarr;PG. Fixed with a config-load preflight.</p>

<h2 id="what-happened">What happened</h2>
<p>A redaction rule <code>--redact 's=randomize:int:100000,200000'</code> — &ldquo;replace column <code>s</code> with a random integer in [100000, 200000]&rdquo; — was pointed at a <code>SMALLINT</code> column, whose range is [-32768, 32767]. Into a <strong>Postgres</strong> target it loud-refused: <code>143556 is greater than maximum value for int2</code>. Into a <strong>MySQL</strong> target it exited 0, printed <code>migration complete</code>, emitted no warning, and wrote <code>32767</code> into <em>every single row</em>. The operator asked for random values to anonymize a column; they got a deterministic constant — and the original values were gone.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The requested range overflows the target column's type on both engines; the two engines just <em>react</em> differently, and sluice was inheriting the reaction instead of deciding it. Postgres's binary <code>COPY</code> encoder rejects an out-of-range <code>int2</code> outright, so the overflow surfaced as a loud error. MySQL's writer session runs with <code>STRICT_TRANS_TABLES</code> disabled — sluice relaxes it to read legacy data like zero-dates — and in non-strict mode MySQL <em>silently clamps</em> an out-of-range integer to the column's maximum rather than erroring. So every generated value above 32767 became 32767. Two compounded failures: a PII-compliance failure (the whole column collapses to one constant, trivially distinguishable from real data) and silent loss of the original values. The correctness of a redaction guarantee was resting on a target engine's native enforcement — enforcement that sluice's own session had switched off on one of the two engines.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- PG source: a SMALLINT column (range [-32768, 32767])
CREATE TABLE redact_overflow (id BIGINT PRIMARY KEY, s SMALLINT);
INSERT INTO redact_overflow VALUES (1, 100), (2, 200);`)}</code></pre>
<pre><code>${esc(`sluice migrate \\
  --source-driver=postgres  --source='postgresql://.../src' \\
  --target-driver=mysql     --target='root:...@tcp(localhost:3317)/dst' \\
  --include-table=redact_overflow \\
  --redact='redact_overflow.s=randomize:int:100000,200000'

# MySQL target:  every row s = 32767   (exit 0, "migration complete", no WARN)
# PG target:     loud refusal -- "143556 is greater than maximum value for int2"`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The redaction subsystem now runs a preflight at config-load time that compares each <code>randomize:int</code> rule's <code>LO,HI</code> range against the column's representable integer range and refuses loudly — before a single row is written — when the range can't fit. Both engines now fail the same way, up front, with an actionable message (widen the target type with <code>--type-override</code>, or choose a range within the column's bounds). A guarantee that used to depend on which engine you happened to target, and on whether strict mode happened to be on, is now enforced by sluice itself, identically, on every path.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>A transform that carries a promise — anonymize this, never leak that — must have identical, verified semantics on every target it can run against. If your correctness is really being provided by a downstream engine's native validation, then the moment you touch that engine's session (relax a SQL mode, change a workload, switch drivers) you can silently void the promise on that engine and not the others. Enforce the invariant yourself, at the earliest point you can (config load), so it can't diverge by target — and so the failure is a refusal the operator sees, not a constant they discover in an audit.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li><a href="https://dev.mysql.com/doc/refman/8.0/en/sql-mode.html#sql-mode-strict">MySQL — Strict SQL Mode</a> — with <code>STRICT_TRANS_TABLES</code> off, out-of-range values are clamped and adjusted rather than rejected.</li>
  <li><a href="https://www.postgresql.org/docs/current/datatype-numeric.html">PostgreSQL — Numeric Types</a> — an out-of-range <code>smallint</code>/<code>int2</code> is an error, not a clamp.</li>
  <li>sluice's redaction strategies — <a href="/docs/redact-pii/">Redact PII</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: VStream throttle-blind ---------------------------------
write(
  "field-notes/vstream-throttle-blind",
  page({
    slug: "field-notes/vstream-throttle-blind",
    title: "vtgate erases the throttle signal: every VStream consumer is throttle-blind",
    subtitle: "Our stream went silent under a write burst, a progress watchdog called it a failover hang, the process restarted, resumed at the same stuck position, and stalled again — indefinitely. The one in-band signal that would have said “this is a throttle, wait” is deleted before any client can see it.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — PlanetScale/Vitess source over VStream, and confirmed against a self-hosted Vitess-24 cluster. Internally Bug 141.</p>

<h2 id="what-happened">What happened</h2>
<p>A continuous sync from PlanetScale wedged into a crash-loop during a write burst. The stream went silent; our 45-second progress watchdog interpreted the silence as a failover hang and restarted the process; it resumed at the same stuck position and stalled again — indefinitely. From the outside, a throttled-but-healthy stream looked identical to a broken one, so the watchdog did exactly the wrong thing.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>Finding this took a self-hosted Vitess cluster and per-event instrumentation, and the cause is in Vitess itself. The tablet sets <code>VEvent.Throttled</code> only on <strong>heartbeat</strong> events. But vtgate then <em>drops every tablet heartbeat</em> — the source comment reads literally &ldquo;Remove all heartbeat events for now.&rdquo; — and synthesizes its own, flag-less heartbeats in their place. The single in-band signal that distinguishes &ldquo;this stream is throttled, wait&rdquo; from &ldquo;this stream is hung&rdquo; is erased before any external gRPC client can observe it. So <strong>no VStream consumer can tell a throttled stream from a hung one</strong>. Worse, under heavy throttle vtgate goes fully silent — no events, no heartbeats — for up to ten minutes before dropping the stream, which is precisely the shape that trips a naive progress watchdog.</p>
<p>Two corollaries we confirmed while chasing it: upsizing the cluster does <em>not</em> clear a replica-lag throttle (the throttler gates on lag, not CPU), and the throttle is shard-scoped, so routing to the primary doesn't escape it.</p>

<h2 id="repro">The repro</h2>
<p>There's no one-line repro — surfacing it took a self-hosted Vitess-24 cluster plus per-event VStream instrumentation to see the <code>Throttled</code> flag get set on the tablet and then vanish at vtgate. The behavior is legible directly in the public source, though: the tablet-side flag on heartbeats in <code>go/vt/vttablet/tabletserver/vstreamer/vstreamer.go</code>, and vtgate's heartbeat-dropping plus flag-less synthesis in <code>go/vt/vtgate/vstream_manager.go</code> (the &ldquo;Remove all heartbeat events for now&rdquo; comment and the surrounding synthesis). Reading those two files side by side shows the signal being created and then deleted before it can leave the gateway.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Since the in-band throttle flag can't reach us, sluice can't treat silence alone as a failure. The watchdog was made throttle-aware: a silent stream is no longer sufficient evidence of a hang, and the resume/restart logic no longer fights a throttle by restarting into the same stuck position (which never helps — the throttle is shard-scoped and lag-driven, so a fresh connection lands in the same wait). The operator-facing guidance is documented so a throttled stream reads as &ldquo;waiting on the source,&rdquo; not &ldquo;broken.&rdquo;</p>

<h2 id="lesson">The transferable lesson</h2>
<p>&ldquo;No data for a while&rdquo; is ambiguous, and if the protocol's disambiguating signal is stripped in transit, a watchdog built on silence-means-dead will amplify a backpressure event into an outage. When you consume a stream you don't control, find out whether &ldquo;throttled&rdquo; and &ldquo;hung&rdquo; are actually distinguishable on the wire before you build automatic recovery on the distinction — and if they aren't, make silence a non-fatal state rather than a restart trigger.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Vitess source (public): tablet-side <code>Throttled</code> flag in <code>go/vt/vttablet/tabletserver/vstreamer/vstreamer.go</code>; vtgate heartbeat handling in <code>go/vt/vtgate/vstream_manager.go</code> (<a href="https://github.com/vitessio/vitess">github.com/vitessio/vitess</a>).</li>
  <li>Vitess tablet throttler (gates on replica lag) — <a href="https://vitess.io/docs/reference/features/tablet-throttler/">vitess.io tablet-throttler docs</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: binlog comment TRUNCATE --------------------------------
write(
  "field-notes/binlog-comment-truncate",
  page({
    slug: "field-notes/binlog-comment-truncate",
    title: "The binlog keeps your SQL comments — and our TRUNCATE parser didn't know",
    subtitle: "A leading -- comment on a TRUNCATE made our CDC reader miss the statement entirely. The source emptied; the target kept every row, forever, with no error and no lag.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL binlog CDC. Internally Bug 140 (fixed in PR #208). Postgres is immune (see below).</p>

<h2 id="what-happened">What happened</h2>
<p>A CDC stream from MySQL silently diverged: the source ran a <code>TRUNCATE</code>, the source table emptied, and the target kept every one of its rows — indefinitely, with no error and no replication lag to hint at the gap. The stream looked perfectly healthy. It just never applied the truncate.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>MySQL's binlog <code>QUERY_EVENT</code> preserves a statement's <em>leading</em> comment verbatim — it strips only the trailing delimiter. Our CDC reader recognized a truncate by checking whether the event body <em>starts with</em> <code>TRUNCATE</code>. So a statement written as:</p>
<pre><code>${esc(`-- clear staging
TRUNCATE TABLE t;`)}</code></pre>
<p>arrived in the binlog as <code>-- clear staging\nTRUNCATE TABLE t</code>, failed the &ldquo;starts with <code>TRUNCATE</code>&rdquo; test, and fell through to generic DDL handling — which quietly did nothing for this statement. The truncate was never applied to the target.</p>
<p>This is not a synthetic-harness artifact. Hand-written migrations and ORM/APM query tags (<code>/* trace=... */</code>, <code>-- deploy 2026-...</code>) prepend comments to statements routinely, and MySQL dutifully records them in the binlog. Any consumer that pattern-matches SQL out of a binlog by prefix will trip on them.</p>

<h2 id="repro">The repro</h2>
<p>Run a commented <code>TRUNCATE</code> against a MySQL source under CDC and watch the target keep its rows:</p>
<pre><code>${esc(`-- on the source, under an active CDC stream:
INSERT INTO t VALUES (1), (2), (3);
-- leading comment: preserved verbatim in the binlog QUERY_EVENT
-- clear staging
TRUNCATE TABLE t;

-- source: 0 rows.  target (before the fix): still 3 rows, no error, no lag.`)}</code></pre>
<p>It was found by a randomized convergence fuzzer whose 5th generated transaction happened to be a commented <code>TRUNCATE</code> — a shape no hand-written test corpus in the project had ever produced.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The reader now strips leading comment prefixes (both <code>--</code> line comments and <code>/* ... */</code> block comments) before pattern-matching the statement, so a commented <code>TRUNCATE</code> is recognized and applied like any other. <strong>Postgres was never affected</strong>: <code>pgoutput</code> emits a typed <code>TruncateMessage</code> with the relation OIDs, so there is no string to parse and no comment to trip over — the immunity is a direct consequence of a typed replication protocol versus a re-parsed SQL one.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>Two lessons, both cheap to internalize. First: anything that pattern-matches SQL text out of a binlog must normalize comments (and whitespace) <em>before</em> matching — the binlog is not the clean statement you typed, it's the statement plus whatever the client prepended. Second: randomized differential convergence testing finds the shapes your hand-written corpus never will. A fuzzer that runs the same random workload through two implementations and diffs the targets surfaces exactly this class of &ldquo;nobody thought to write that test&rdquo; bug.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL binlog event reference (<code>QUERY_EVENT</code> carries the statement text) — <a href="https://dev.mysql.com/doc/dev/mysql-server/latest/">MySQL internals / binary log documentation</a>.</li>
  <li>Postgres logical replication message formats (typed <code>Truncate</code> message) — <a href="https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html">PostgreSQL logical replication message formats</a>.</li>
  <li>sluice CDC behavior across engines — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: 2^53 / JSON double boundary ----------------------------
write(
  "field-notes/int64-json-boundary",
  page({
    slug: "field-notes/int64-json-boundary",
    title: "2^53 is a database boundary now",
    subtitle: "JSON has one number type, and it's a double. That single fact produced two independent silent-corruption incidents in one week — one in third-party tooling, one in our own decoder.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — a D1-to-Postgres head-to-head (2026-06-30) and sluice's incremental-backup decoder. Internally Bug 172 (fixed v0.99.159).</p>

<h2 id="what-happened">What happened</h2>
<p>JSON's only numeric type is an IEEE-754 double, which represents integers exactly only up to 2<sup>53</sup> (9,007,199,254,740,992). Any integer path that passes through a JSON number above that boundary can round silently. In one week that bit us twice, from two completely different directions.</p>
<ul>
  <li><strong>Third-party tooling.</strong> In a ~5 GB Cloudflare D1 → Postgres head-to-head, a competing importer that consumes <code>wrangler d1 export</code> silently corrupted <strong>50% (625,000 of 1,250,000) of the &gt;2<sup>53</sup> integer test values</strong> — every odd value above the boundary landed off by one — because <code>wrangler d1 export</code> serializes integers as JSON numbers and rounds them through float64 before any database sees them. sluice's D1 reader was exact on the same corpus (0 corrupted) because it projects each integer through a lossless <code>(typeof, CAST(... AS TEXT))</code> path instead of a JSON number.</li>
  <li><strong>Our own code.</strong> sluice's incremental-backup change-chunk decoder stored int64s <em>exactly</em> on disk in a typed envelope, then decoded them back through Go's <code>interface{}</code> — which <code>encoding/json</code> unmarshals every number into a float64 by default. Values near int64 max failed loudly; values merely above 2<sup>53</sup> decoded off-by-one with <em>no</em> error. Downstream that was worse than a bad value: a <code>DELETE</code> whose before-image carried a corrupted big-int matched zero rows and silently no-op'd, leaving <strong>2,043 deleted rows alive on the target</strong>.</li>
</ul>

<h2 id="why">Why (the mechanism)</h2>
<p>A double has a 52-bit mantissa, so it can represent every integer up to 2<sup>53</sup> and only <em>even</em> integers immediately above it — odd values above the boundary are rounded to the nearest representable even. The corruption is invisible to the usual sanity checks: it doesn't overflow, doesn't error, and an aggregate checksum can hide it entirely (in our head-to-head a <code>SUM</code> matched despite 50% per-row corruption, because round-half-to-even makes the +1/&minus;1 errors cancel). You only see it per row.</p>
<p>In Go specifically, the trap is <code>json.Unmarshal</code> into an <code>interface{}</code> (or <code>map[string]any</code>): every JSON number becomes a <code>float64</code>, so an int64 that was written exactly comes back rounded even though the bytes on disk were correct.</p>

<h2 id="repro">The repro</h2>
<p>The whole class is visible in a two-line round-trip of a single big integer through a default JSON decode:</p>
<pre><code>${esc(`// Go: exact on disk, rounded on the way back
var v any
_ = json.Unmarshal([]byte(\`9007199254740993\`), &v)   // 2^53 + 1
fmt.Printf("%.0f\\n", v)   // 9007199254740992   <- off by one, no error

// The fix: decode through json.RawMessage / json.Number (UseNumber),
// never through interface{}:
d := json.NewDecoder(bytes.NewReader([]byte(\`9007199254740993\`)))
d.UseNumber()
var n json.Number
_ = d.Decode(&n)
fmt.Println(n.String())   // 9007199254740993   <- exact`)}</code></pre>
<p>The same boundary is why <code>wrangler d1 export</code> corrupts big integers before the data ever reaches a database, and why sluice's live-D1 reader deliberately avoids JSON numbers for integer columns.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The fix was a single doctrine, applied wherever an int64 can ride a JSON hop: decode with <code>json.RawMessage</code> / <code>UseNumber</code> (<code>json.Number</code>), never through <code>interface{}</code>. sluice's change-chunk decoder moved from <code>map[string]any</code> to <code>map[string]json.RawMessage</code> so big-ints survive the round-trip byte-exact; the live-D1 reader projects integers through <code>typeof()</code> + <code>CAST(... AS TEXT)</code> (and BLOBs through <code>hex()</code>) so no value above 2<sup>53</sup> is ever rendered as a JavaScript number. Both are documented on the <a href="/docs/type-mapping/#sqlite-d1">type-mapping page</a> and in the <a href="/docs/import-sqlite-d1/">SQLite / D1 import guide</a>.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>If your IDs are Snowflakes, or your rows count past 9,007,199,254,740,992, treat every JSON hop in your pipeline as a potential rounding event. Audit each one for how it decodes numbers — in Go that means never <code>interface{}</code> for a field that can hold an int64 — and don't let an aggregate checksum reassure you, because symmetric rounding can make a <code>SUM</code> match while half the individual rows are wrong. Verify big-int fidelity per row, on the actual values, against an oracle.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>sluice type-mapping — <a href="/docs/type-mapping/#sqlite-d1">the &gt;2<sup>53</sup> lossless-integer projection for SQLite / D1</a>.</li>
  <li>sluice import guide — <a href="/docs/import-sqlite-d1/">Import SQLite or Cloudflare D1</a> (the live-D1 reader path).</li>
  <li>Go <code>encoding/json</code> — <a href="https://pkg.go.dev/encoding/json#Decoder.UseNumber"><code>Decoder.UseNumber</code></a> and <a href="https://pkg.go.dev/encoding/json#Number"><code>json.Number</code></a>.</li>
  <li>The double-precision boundary — <a href="https://en.wikipedia.org/wiki/Double-precision_floating-point_format">IEEE-754 double-precision format</a> (exact integers up to 2<sup>53</sup>).</li>
</ul>
`,
  })
);

// ======================= FIELD NOTES: WAVE 2 =============================

// ---- Field Notes: REPLICA IDENTITY FULL + UPDATE -------------------------
write(
  "field-notes/replica-identity-full-updates",
  page({
    slug: "field-notes/replica-identity-full-updates",
    title: "REPLICA IDENTITY FULL silently ate our UPDATEs",
    subtitle: "Build a CDC UPDATE's WHERE clause over every old column and it works forever on int and varchar. Then a jsonb column rides along unchanged, its old value fails the equality round-trip, the UPDATE matches zero rows, and idempotency tolerance swallows the miss.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — Postgres logical-replication (slot-based) source, tables set to <code>REPLICA IDENTITY FULL</code>. Internally Bug 92 (CRITICAL silent loss, fixed v0.85.2).</p>

<h2 id="what-happened">What happened</h2>
<p>A Postgres-to-Postgres CDC stream silently diverged on the core, most-tested engine. An <code>UPDATE</code> that changed a cheap column on a table with <code>REPLICA IDENTITY FULL</code> never landed on the target — the applier logged <code>zero rows affected op=update</code> at INFO and moved on. Exit 0, no error, no lag. The target kept the stale row indefinitely. Every prior test on this path had passed, for months.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>With <code>REPLICA IDENTITY FULL</code>, Postgres ships the <em>entire</em> old row image in each UPDATE's <code>pgoutput</code> old-tuple. The tempting thing for a CDC applier to do is build the UPDATE's <code>WHERE</code> clause over every old column — it's right there, and it's a superset of the key. That works perfectly as long as every column's old value survives the <code>pgoutput</code> decode &rarr; rebind round-trip as an exact <code>=</code> match. Integers and <code>varchar</code> always do. A <strong>rich type does not</strong>: a <code>jsonb</code> value (or <code>timestamptz</code>, <code>bytea</code>, high-precision <code>numeric</code>) that rides along unchanged in the old tuple can fail the <code>=</code> predicate after the decode&ndash;rebind round-trip — semantically equal, not byte-equal in the way the equality operator sees. The <code>WHERE</code> matches zero rows, and the <a href="/docs/how-sluice-copies/">idempotency tolerance</a> that makes replay safe (a zero-row UPDATE is normal during re-apply) swallows the miss. Silent UPDATE loss on the engine you trust most.</p>
<p>The asymmetry is the tell: the DELETE path had narrowed its <code>WHERE</code> to identity-key columns since an earlier fix; the UPDATE path never got the symmetric narrowing, and the entire prior <code>FULL</code>-plus-UPDATE test corpus used only int and varchar columns, which round-trip exactly, so the <code>=</code> always matched and the loss never surfaced.</p>

<h2 id="repro">The repro</h2>
<p>Set a table to <code>REPLICA IDENTITY FULL</code>, give it a <code>jsonb</code> column, and update a <em>different</em> column while CDC tails it:</p>
<pre><code>${esc(`CREATE TABLE ledger (
  id     bigint PRIMARY KEY,
  seq    bigint,
  doc    jsonb,          -- rides along unchanged in the FULL old-tuple
  note   text
);
ALTER TABLE ledger REPLICA IDENTITY FULL;
INSERT INTO ledger VALUES (1, 1, '{"k":"v"}', 'a');

-- with a CDC stream tailing the slot, on the source:
UPDATE ledger SET seq = 30000 WHERE id = 1;   -- doc untouched

-- source: seq = 30000.  target (before the fix): still seq = 1,
--   applier logs "zero rows affected op=update", exit 0, no error.`)}</code></pre>
<p>What surfaced it in practice was a <strong>differential test</strong>: the same workload run through two independent CDC implementations — the slot-based engine and a trigger-based variant — with the two targets diffed. The brand-new variant was correct; the proven engine was wrong.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The fix narrows the UPDATE's <code>Before</code> image to the identity-key columns under <code>FULL</code>, so the <code>WHERE</code> becomes <code>id = $1</code> — mirroring the DELETE path's existing narrowing. It is pinned with a family matrix in the spirit of the <a href="/field-notes/numeric-array-flatten/">pin-the-class rule</a>: <code>numeric</code> / <code>jsonb</code> / <code>bytea</code> / temporal columns &times; <code>FULL</code> + UPDATE, because a green test on one representative rich type proves nothing about the others.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>Treat rich types — <code>jsonb</code>, <code>timestamptz</code>, <code>bytea</code>, high-precision <code>numeric</code> — as radioactive in equality predicates: a value that is semantically unchanged is not guaranteed to compare <code>=</code> after a decode&ndash;rebind round-trip. Narrow replication <code>WHERE</code> clauses to identity-key columns, never the full old tuple. And if you have two implementations of one contract, make them testify against each other — a differential run caught a CRITICAL silent-loss bug in the proven engine that months of single-implementation tests had missed.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Postgres <code>REPLICA IDENTITY</code> — <a href="https://www.postgresql.org/docs/current/sql-altertable.html#SQL-ALTERTABLE-REPLICA-IDENTITY">ALTER TABLE &hellip; REPLICA IDENTITY</a> (what <code>FULL</code> ships in the old tuple).</li>
  <li>Postgres logical-decoding output — <a href="https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html">logical replication message formats</a>.</li>
  <li>sluice CDC behavior across engines — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: Postgres replication-slot leaks ------------------------
write(
  "field-notes/postgres-slot-leaks",
  page({
    slug: "field-notes/postgres-slot-leaks",
    title: "Replication slots don't die with your process",
    subtitle: "A Postgres logical replication slot is a promise the server keeps: it retains WAL from the slot's restart_lsn until you drop it — even if the process that created it crashed weeks ago. We hit the class three separate ways, each invisible until the source disk fills.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — Postgres source, replication-slot lifecycle across crashes and early exits. Internally Bug 5 (fixed v0.2.0), Bug 137 (fixed v0.99.37), Bug 177 (fixed v0.99.179).</p>

<h2 id="what-happened">What happened</h2>
<p>A Postgres logical replication slot retains WAL from its <code>restart_lsn</code> onward until something drops it. A slot left behind by a dead process keeps pinning WAL forever — the server has no idea the client is gone, and it is doing exactly what you asked: holding the log so a consumer can resume. On a write-active source, an orphaned slot is a slow disk-fill with no loud signal until Postgres goes read-only. We hit this class three separate ways.</p>
<ul>
  <li><strong>A hard-killed backup.</strong> A PG-source <code>backup full</code> created a non-temporary snapshot-anchor slot (<code>sluice_backup_anchor_&lt;ts&gt;</code>). Kill it mid-run and the slot survives inactive; the subsequent resume creates a <em>new</em> anchor and never sweeps the old one, so every crashed run adds one more WAL-pinning orphan, each frozen at its creation-time <code>restart_lsn</code>.</li>
  <li><strong>A cold-start that refused for an unrelated reason.</strong> A <code>sync start</code> created its slot <em>before</em> the target-empty check, then hit <code>SLUICE-E-COLDSTART-TARGET-NOT-EMPTY</code> and exited — without dropping the slot it had just created. The refusal was loud and correct; the leaked slot behind it was silent.</li>
  <li><strong>The earliest version of the tool.</strong> In week one, any cold-start that failed between <code>CREATE_REPLICATION_SLOT</code> and clean shutdown left <code>sluice_slot</code> behind, and the next start refused with <code>replication slot "sluice_slot" already exists</code> until an operator ran <code>pg_drop_replication_slot</code> by hand.</li>
</ul>

<h2 id="why">Why (the mechanism)</h2>
<p>A non-temporary slot's lifetime is <em>server-side</em> and unbounded — it is decoupled from the TCP connection or OS process that created it, by design, so a consumer can disconnect and reconnect without losing its place. That is exactly why a crash leaks it: there is no session-teardown hook that drops a persistent slot, and <code>kill -9</code> gives the client no chance to clean up. Any code path that creates a slot and can exit abnormally — a crash, a signal, an early-return refusal — is therefore a potential leak, and the leak is invisible from the application side. You only see it in <code>pg_replication_slots</code>, or when the disk fills.</p>

<h2 id="repro">The repro</h2>
<p>Create a slot, kill the process before it drops it, and look at the catalog:</p>
<pre><code>${esc(`-- create a slot, then hard-kill the creating process (kill -9 / taskkill /F)
SELECT slot_name, temporary, active, restart_lsn
FROM pg_replication_slots
WHERE slot_name LIKE 'sluice_%';
--  sluice_backup_anchor_178...  | f | f | 0/1A2B3C4   <- persistent, inactive,
--                                                        pinning WAL at that LSN

-- the WAL it pins never recycles until you drop it:
SELECT pg_drop_replication_slot('sluice_backup_anchor_178...');`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The toolbox that closed the class:</p>
<ul>
  <li><strong>Protocol <code>TEMPORARY</code> slots</strong> for anything single-run-scoped. A temporary slot auto-drops when its session ends — including under <code>kill -9</code> — so a crashed backup no longer leaks its anchor. (<code>CREATE_REPLICATION_SLOT &hellip; TEMPORARY</code> supports <code>EXPORT_SNAPSHOT</code>, so the snapshot-anchored backup path can use it.)</li>
  <li><strong>An orphan sweep with an age safety margin</strong> on the resume path, for slots leaked by pre-fix binaries: old orphans are dropped with an INFO naming each one; a slot younger than the margin is only WARN-named (it might belong to a concurrent run), never auto-dropped.</li>
  <li><strong>Teardown-on-refusal ordering</strong>: an early-exit refusal now abandons the slot it created before returning, so the target-not-empty path leaves the source slot count unchanged.</li>
</ul>
<p>This is the <a href="/docs/postgres-source-prep/">contain-Postgres-complexity</a> tenet in practice: slot lifecycle is surfaced explicitly — via <code>sluice slot list</code> / <code>slot drop</code> and named WARNs — rather than silently auto-handled or silently leaked.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>If your tool creates replication slots (or any server-side, session-decoupled resource), <strong>your crash paths are part of your API.</strong> Enumerate every way the process can exit abnormally — signal, panic, early-return refusal, hard kill — and make sure each one either can't leak the resource (protocol-<code>TEMPORARY</code>) or is reconciled on the next run (an age-bounded sweep). A resource whose lifetime the server owns will outlive your process by default; that is a feature you have to opt out of, not a bug you can ignore.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Postgres replication slots — <a href="https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS">streaming replication slots</a> and <a href="https://www.postgresql.org/docs/current/view-pg-replication-slots.html"><code>pg_replication_slots</code></a>.</li>
  <li>The replication protocol's <code>CREATE_REPLICATION_SLOT &hellip; TEMPORARY</code> — <a href="https://www.postgresql.org/docs/current/protocol-replication.html">streaming replication protocol</a>.</li>
  <li>sluice Postgres-source preparation — <a href="/docs/postgres-source-prep/">Prepare a Postgres source</a> and the <a href="/docs/managed-postgres-slotless/">managed (slot-less) path</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: MySQL ENUM emoji --------------------------------------
write(
  "field-notes/mysql-enum-emoji",
  page({
    slug: "field-notes/mysql-enum-emoji",
    title: "MySQL's data dictionary turned our emoji into question marks",
    subtitle: "A MySQL ENUM whose label contains an emoji doesn't contain that emoji by the time you read it back. MySQL substitutes ? for 4-byte UTF-8 characters in ENUM/SET labels at CREATE TABLE time, regardless of column charset — and the label is gone from the catalog before any client sees it.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL &rarr; Postgres cross-engine migrate, <code>ENUM</code>/<code>SET</code> columns with supplementary-plane labels. Internally Bug 106; documented and surfaced in v0.92.2. This is a MySQL server behavior, not a sluice bug.</p>

<h2 id="what-happened">What happened</h2>
<p>A MySQL &rarr; Postgres migrate of a table with <code>ENUM('vanilla','strawberry-🍓', &hellip;)</code> on a <code>utf8mb4</code> column created the target enum type with a corrupted label — <code>strawberry-?</code> — and then loud-failed the first row INSERT, because the source row's genuine <code>F0 9F 8D 93</code> bytes matched nothing in the target enum:</p>
<pre><code>${esc(`ERROR: invalid input value for enum enum_utf8_flavor_enum: "strawberry-🍓" (SQLSTATE 22P02)`)}</code></pre>
<p>The row <em>data</em> was fine. The enum <em>label</em> in the schema was already <code>?</code> before sluice ever read it.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>MySQL's data dictionary silently substitutes <code>?</code> for supplementary-plane (4-byte UTF-8) characters in <code>ENUM</code>/<code>SET</code> <em>labels</em> at <code>CREATE TABLE</code> time — regardless of the column's charset. 2-byte and 3-byte BMP characters (<code>é</code>, <code>日</code>) survive; only 4-byte characters (emoji) are transliterated. Inspect the label bytes and the loss is unambiguous:</p>
<pre><code>${esc(`strawberry-?  hex=737472617762657272792d3f   <- emoji replaced with 0x3f '?'
espéçial      hex=657370c3a9c3a769616c       <- 2-byte chars survived
日本語        hex=e697a5e69cace8aa9e         <- 3-byte chars survived`)}</code></pre>
<p>The crucial part: this happens to the <strong>label in the catalog</strong>, not to the column's row data. A stored row keeps the real bytes; only the enum's <em>definition</em> is corrupted, at table-creation time, before any client reads it back. So a cross-engine migration faithfully creates a target enum type with the mangled label and then can't insert the source's honest bytes. <code>mysqldump</code> reproduces the identical loss — the label is gone from the source's own catalog, so no tool can recover it. The original suspicion was a session-charset issue (<code>character_set_results</code>), but forcing <code>utf8mb4</code> on the connection does not fix it; the substitution is a server-side data-dictionary property.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`CREATE TABLE enum_utf8 (
  id BIGINT PRIMARY KEY,
  flavor ENUM('vanilla','strawberry-🍓','espéçial','日本語') CHARACTER SET utf8mb4
);

-- read the label back — the emoji is already '?', regardless of your session charset:
SELECT COLUMN_TYPE FROM information_schema.COLUMNS
 WHERE TABLE_NAME = 'enum_utf8' AND COLUMN_NAME = 'flavor';
--  enum('vanilla','strawberry-?','espéçial','日本語')`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The only honest response available: sluice detects a <code>?</code> in <code>ENUM</code>/<code>SET</code> label metadata at schema-read and WARNs before the runtime INSERT loud-fails, so the operator learns about the loss at the top of the run instead of mid-copy. The heuristic is kept narrow (warn only when a label literally contains <code>?</code>) to avoid false positives, and the escape hatch is <code>--type-override &lt;table&gt;.&lt;col&gt;=text</code>, which carries the column as free text so the real bytes migrate. sluice can't recover the original label — nobody can — but it refuses to let the loss be a surprise.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>Character-set correctness is not uniform across a database's own surfaces. A column declared <code>utf8mb4</code> stores 4-byte characters perfectly in its <em>rows</em> while the same server silently downgrades them in <em>identifiers and enum labels</em> in the data dictionary. When you copy schema, you are copying metadata that may have passed through a lossier path than the data did — verify label and identifier bytes with <code>hex()</code>, not by eye, and treat a corrupted catalog value as unrecoverable rather than assuming a re-read with the right charset will heal it.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL <code>ENUM</code> type and its limits — <a href="https://dev.mysql.com/doc/refman/8.0/en/enum.html">MySQL 8.0 Reference Manual: the ENUM type</a>.</li>
  <li>MySQL character-set support and <code>utf8mb4</code> — <a href="https://dev.mysql.com/doc/refman/8.0/en/charset-unicode-utf8mb4.html">the utf8mb4 character set</a>.</li>
  <li>sluice type mapping and overrides — <a href="/docs/type-mapping/">type mapping</a> (the <code>--type-override</code> escape).</li>
</ul>
`,
  })
);

// ---- Field Notes: Vitess tx killer meets a WAN --------------------------
write(
  "field-notes/vitess-tx-killer-wan",
  page({
    slug: "field-notes/vitess-tx-killer-wan",
    title: "The 20-second guillotine: Vitess's transaction killer meets a 96 ms WAN",
    subtitle: "Continuous CDC into PlanetScale MySQL over the internet stalled at effectively zero throughput. The failure geometry: with no statement pipelining an N-row apply costs N round-trips; at 96 ms RTT a 1,000-row batch takes ~100 seconds; Vitess kills any transaction at 20 seconds; the adaptive batch controller shrinks the batch — and converges to a stall.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — trigger-CDC continuous apply into PlanetScale MySQL (Vitess) at ~96 ms RTT, and into PlanetScale Postgres. Internally Bug 168 (Postgres apply path, fixed v0.99.153) and Bug 169 (MySQL/Vitess apply path, insert path fixed v0.99.155; update/delete tail tracked under ADR-0138).</p>

<h2 id="what-happened">What happened</h2>
<p>A continuous CDC sync into a PlanetScale MySQL target over the public internet stalled. With the default apply config, every apply transaction took far longer than Vitess's hard 20-second transaction timeout and was killed:</p>
<pre><code>${esc(`Error 1105: ... tx killer rollback ... exceeded timeout: 20s`)}</code></pre>
<p>The adaptive batch controller reacted to the failures and multiplicatively shrank the batch — 1000 &rarr; 500 &rarr; 250 &rarr; 125 &rarr; 62 — but the p95 stayed around 22 seconds, batches kept getting killed, and durable progress was roughly nil (over ~210 seconds the target advanced about 50 net rows; the durable resume position never left <code>last_id=0</code>). A self-tuning system had converged to a stall.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The apply path issued its statements one round-trip at a time — no statement pipelining, no multi-row coalescing — so an N-row apply transaction costs about N network round-trips. At a 96 ms RTT, a 1,000-row batch is <code>1000 &times; ~2&times;RTT &asymp; ~100 s</code>, well past the 20-second killer. So the two knobs fight each other with no winning setting: every batch <em>big enough to be efficient</em> overruns the killer, and every batch <em>small enough to commit</em> crawls at roughly <code>lanes / RTT</code> — with 4 lanes over 96 ms, on the order of 20&ndash;30 changes/s. The controller can only pick between "killed" and "crawling."</p>
<p>The clean proof that the bottleneck was per-row round-trips and not batch/transaction count came from the Postgres side of the same test: pinning a large <em>static</em> batch (<code>--no-auto-tune --apply-batch-size 1000</code>) barely moved throughput — about 63 changes/s, essentially unchanged from the auto-tuned collapse. If batch <em>count</em> were the cost, a 1,000-row static batch would have jumped; it didn't, because the cost is 1,000 serial round-trips either way. Routing the identical workload through a <strong>pipelined</strong> applier (a batch costs ~1&ndash;2 RTT instead of N) took Postgres from ~63/s to <strong>~5,000 changes/s</strong>. Latency &times; protocol shape beats every knob.</p>

<h2 id="repro">The repro</h2>
<p>On a high-latency link (add ~80&ndash;100 ms with <code>tc netem</code> if you don't have a real WAN), run continuous CDC into a Vitess/PlanetScale MySQL target under a sustained write workload and watch the durable apply position:</p>
<pre><code>${esc(`# generate a backlog, then apply over the WAN with the default config:
#   the 20 s tx-killer fires, AIMD collapses the batch toward 1,
#   durable progress ~0 (last_id stays near 0).
# cap the batch low enough to commit inside 20 s to confirm the RTT floor:
sluice sync start --no-auto-tune --apply-batch-size 80 ...
#   no tx-kills now — but only ~20-30 changes/s, two orders of
#   magnitude below the ~2,600/s the source generates. It diverges.`)}</code></pre>
<p>The diagnostic knob is the static-batch test: if pinning a large static batch <em>doesn't</em> raise throughput, your bottleneck is per-row round-trips, and no batch-size setting will save you.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The real fix is to remove the per-row round-trips. On the <strong>Postgres</strong> apply path, sluice routes the batch through a statement-pipelined applier so a batch of N changes costs ~1&ndash;2 RTT — measured ~5,000 changes/s over the WAN where the round-trip-bound path managed ~63/s. On the <strong>MySQL/Vitess</strong> path, the insert-heavy case is handled by multi-row <code>INSERT</code> coalescing: re-validated on real PlanetScale MySQL at ~101 ms RTT, an insert-only 200,003-change backlog drained at ~4,000 changes/s with the default config and the 20-second killer never firing — versus the prior default-config stall (roughly 100&ndash;200&times;). The update/delete-heavy MySQL path is still round-trip-bound and is tracked as MySQL apply-parity work under ADR-0138; until it lands, migrate/cold-copy (a streaming <code>COPY</code>/bulk-load protocol, bandwidth-bound not RTT-bound) is the safe cross-region primitive.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>Over a WAN, the shape of your protocol dominates every tuning knob. If your applier isn't pipelined or multi-row-coalesced, an N-row batch costs N round-trips, and no adaptive batch controller can find a setting that is both efficient and within a managed database's transaction timeout — it will converge to a stall, which is worse than an honest error because it looks like the system is <em>trying</em>. And managed-database transaction killers (Vitess's 20 s, others' equivalents) turn "slow" into "wedged": a batch that would merely have been slow on a self-hosted server gets rolled back entirely. Measure round-trip cost directly — the static-batch test — before you trust batch size as a lever.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Vitess transaction timeout / tx-killer — <a href="https://vitess.io/docs/reference/query-serving/transactions/">Vitess transactions reference</a> (the <code>--queryserver-config-transaction-timeout</code> behavior).</li>
  <li>sluice PlanetScale &amp; Vitess guidance — <a href="/docs/planetscale-vitess/">PlanetScale &amp; Vitess</a> and <a href="/docs/planetscale-postgres/">PlanetScale Postgres</a>.</li>
  <li>How sluice's CDC apply works — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: D1 is not local SQLite --------------------------------
write(
  "field-notes/d1-not-local-sqlite",
  page({
    slug: "field-notes/d1-not-local-sqlite",
    title: "Cloudflare D1 is not your local SQLite",
    subtitle: "Our type-inference validated candidate columns with SQLite GLOB patterns — a UUID check is a 356-character char-class pattern — and passed every test we had, including a multi-GB head-to-head. Then it hit live D1 and died instantly: code 7500, LIKE or GLOB pattern too complex, on a 1,750-row table with pristine data.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — live Cloudflare D1 source (<code>--source-driver d1</code>) with <code>--infer-types</code>. Addressed by ADR-0145 (<code>migrate --stage-local</code>), shipped v0.99.167.</p>

<h2 id="what-happened">What happened</h2>
<p>sluice's <code>--infer-types</code> feature validates candidate columns with SQLite <code>GLOB</code> patterns — the UUID-conformance check is a ~356-character character-class pattern (32 repetitions of <code>[0-9a-fA-F]</code>), the ISO-datetime check ~79 characters. It passed every test we had, including a multi-GB head-to-head. Then it ran against a live D1 database and died instantly:</p>
<pre><code>${esc(`HTTP 400  code 7500: "LIKE or GLOB pattern too complex"`)}</code></pre>
<p>Not on a huge table — on a <strong>1,750-row table with pristine data</strong>, on the first <code>*_at</code> / <code>*_uuid</code> candidate column. The failure was size-independent, and no local test could ever have produced it.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>D1's SQLite build ships a low <code>SQLITE_MAX_LIKE_PATTERN_LENGTH</code>, well below the ~356-character UUID pattern. Every stock local SQLite — and <code>modernc.org/sqlite</code>, the pure-Go build sluice uses locally — accepts the default cap of <strong>50,000</strong>, so the long pattern compiles fine everywhere except on the real service. The dialect is identical; the <em>limit</em> is a hidden configuration surface you can't see from the SQL. So the whole failure class was invisible until the query ran on D1 itself: "SQLite-compatible" local testing told us nothing about it.</p>
<p>One layer deeper sat a second cliff: even where the pattern is accepted (boolean/JSON checks), an unbounded full-column validation scan over a multi-GB table trips D1's <strong>per-query CPU ceiling</strong> and aborts with <code>HTTP 429 / code 7429</code>. Two independent hidden limits, both absent from every local engine.</p>

<h2 id="repro">The repro</h2>
<p>Run a long-enough <code>GLOB</code> against a live D1 database — the row count and data quality are irrelevant:</p>
<pre><code>${esc(`-- against live Cloudflare D1 (e.g. via wrangler d1 execute):
-- a ~356-char character-class pattern like the UUID-conformance check
SELECT count(*) FROM customers
 WHERE org_uuid GLOB '[0-9a-fA-F][0-9a-fA-F]... (32x) ...';
--  D1: HTTP 400 code 7500 "LIKE or GLOB pattern too complex"

-- the identical query on any local SQLite (incl. modernc) with the
-- default SQLITE_MAX_LIKE_PATTERN_LENGTH = 50000 runs fine.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The fix stops fighting the caps one query shape at a time. <code>migrate --stage-local</code> (D1 source only) first replicates the live D1 database into a <strong>byte-faithful</strong> local SQLite file, then runs the entire migrate — schema read, <code>--infer-types</code> validation, and bulk copy — against that local file via the existing <code>sqlite</code> engine, where neither the pattern-complexity limit nor the CPU ceiling exists. Staging closes the <em>whole class</em> of D1 HTTP-query limits (the GLOB cap, the CPU ceiling, ad-hoc <code>COUNT</code>/<code>MAX</code> 429s) in one move, and because the staged file carries D1's original conservative SQLite types, inference makes identical decisions. It auto-engages when <code>--infer-types</code> is set against a D1 source (the direct path is structurally broken there) unless you pass <code>--no-stage-local</code>. Crucially the staging is <em>lossless</em>, unlike <code>wrangler d1 export</code>, which rounds integers above 2<sup>53</sup> through a JavaScript double (see <a href="/field-notes/int64-json-boundary/">2<sup>53</sup> is a database boundary now</a>). A prototyped rowid-windowed "chunked validation" alternative was parked: it addresses only the CPU ceiling, not the GLOB-complexity limit — the same long patterns still abort at <code>code 7500</code> before any CPU budget is reached.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>When you target a hosted build of an embedded engine, the SQL dialect is the same but the <em>limits</em> are a config surface you can't see and can't test against locally: pattern-length caps, per-query CPU/time ceilings, statement-size and result-size bounds. "SQLite-compatible" (or "Postgres-wire-compatible") tells you about syntax, not about the operational envelope. Validate against the real service early, and when the hosted limits are a moving target, the robust move is often to get the data onto an unconstrained local copy and do the heavy work there rather than negotiating with each cap individually.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>sluice import guide — <a href="/docs/import-sqlite-d1/">Import SQLite or Cloudflare D1</a> (the <code>--stage-local</code> path).</li>
  <li>Cloudflare D1 limits — <a href="https://developers.cloudflare.com/d1/platform/limits/">D1 platform limits</a>.</li>
  <li>SQLite's <code>SQLITE_MAX_LIKE_PATTERN_LENGTH</code> — <a href="https://www.sqlite.org/limits.html">SQLite implementation limits</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: SQLite DECIMAL affinity -------------------------------
write(
  "field-notes/sqlite-decimal-affinity",
  page({
    slug: "field-notes/sqlite-decimal-affinity",
    title: "SQLite's DECIMAL is a suggestion: 19.99, stored as 19.989999999999998",
    subtitle: "SQLite doesn't have column types; it has affinities. Declare DECIMAL(10,2) and you get NUMERIC affinity, which stores any non-integer as a float64 — so 19.99 lands as 19.989999999999998 on disk. Not a rounding bug: an engine storage property.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — SQLite as a migrate target (writer) and as a source (reader). Internally Bug 162 (CRITICAL silent corruption, target side, fixed v0.99.147) and Bug 163 (loud COPY abort, source side, fixed v0.99.150).</p>

<h2 id="what-happened">What happened</h2>
<p>Migrating an ordinary money column into a SQLite target, a decimal <code>19.99</code> landed on disk as <code>19.989999999999998</code> — exit 0, no warning. The produced <code>.db</code> is the whole deliverable of that path (the documented flow is <em>X &rarr; SQLite &rarr; Cloudflare D1</em> via <code>wrangler d1 import</code>), so the corrupted value is exactly what the next consumer reads. This wasn't a sluice rounding bug; it was SQLite storing the value as a binary float because of how its type system works.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>SQLite doesn't have column types — it has <strong>affinities</strong>. A column declared <code>DECIMAL(10,2)</code> (or <code>NUMERIC</code>) carries NUMERIC affinity, and SQLite coerces any non-integer inserted value to REAL — a float64 — on store. The first guard against this checked the wrong predicate: it refused values "beyond ~15 significant digits," on the theory that precision loss is about digit count. But float64 inexactness is not about significant digits; it is about <strong>dyadic representability</strong> — whether the value is a finite base-2 fraction. <code>19.99 = 1999/100</code> has a denominator that isn't a power of two, so it is <em>not</em> exactly representable in float64 despite having only four significant digits, and it slipped straight past the &gt;15-digit guard. Essentially every real-world money value (<code>19.99</code>, <code>5.10</code>, <code>0.10</code>) is non-dyadic, so essentially every money value was silently floated. Integer-valued decimals (<code>100.00</code> &rarr; INTEGER <code>100</code>) and the rare dyadic value stored exactly, which is why spot checks missed it.</p>
<p>The <strong>reader</strong> direction has its own trap. SQLite renders a stored REAL back with Go's <code>strconv.FormatFloat(v, 'g', -1, 64)</code>, and the <code>'g'</code> verb flips to exponent notation at magnitude &ge;&nbsp;10<sup>6</sup> (or &lt;&nbsp;10<sup>-4</sup>). So a perfectly ordinary <code>1000000.00</code> renders as <code>"1e+06"</code> — and pgx's binary <code>numeric</code> (OID 1700) COPY encoder cannot find an encode plan for an exponent-notation string, so the migration aborts:</p>
<pre><code>${esc(`ERROR: unable to encode "1e-10" into binary format for numeric (OID 1700):
       cannot find encode plan (SQLSTATE 57014)`)}</code></pre>
<p>An entirely ordinary $1,000,000.00 in a SQLite <code>DECIMAL</code> column was enough to abort a SQLite&nbsp;&rarr;&nbsp;Postgres migrate.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- WRITER side: what a "DECIMAL" SQLite target actually stores
CREATE TABLE m (id INTEGER PRIMARY KEY, price DECIMAL(10,2));
INSERT INTO m VALUES (1, 19.99), (2, 5.10), (3, 100.00);
SELECT id, typeof(price), price FROM m;
--  1 | real    | 19.989999999999998   <- non-dyadic, silently floated
--  2 | real    | 5.0999999999999996
--  3 | integer | 100                  <- integer-valued: exact

-- READER side: 'g'-verb exponent rendering aborts a binary numeric COPY
INSERT INTO m VALUES (4, 1000000.00);   -- typeof -> real
--  Go's FormatFloat(..., 'g', ...) renders 1e+06 -> pgx numeric COPY: SQLSTATE 57014`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Two fixes for one engine property. The writer now stores decimal/numeric columns as <strong>TEXT affinity by default</strong>, so the value is preserved byte-exact (<code>19.99</code> stays <code>'19.99'</code>) and sluice's own reader decodes TEXT&nbsp;&rarr;&nbsp;decimal cleanly — this also keeps the value <code>wrangler d1 import</code>-safe. The reader now renders floats with the <code>'f'</code> verb instead of <code>'g'</code>, so <code>1000000</code> renders as plain digits that pgx's numeric encoder accepts. The change of predicate is the real lesson: the guard moved from "significant-digit count" to "not exactly representable in float64."</p>

<h2 id="lesson">The transferable lesson</h2>
<p>If you produce <code>.db</code> files for anyone — or consume them — a declared column type in SQLite tells you almost nothing; check <code>typeof()</code> on the actual stored value. And when you reason about float precision, the predicate is <strong>dyadic representability</strong>, not significant-digit count: <code>19.99</code> at four digits is lossy while some 17-digit values are exact, because base-2 can only finitely represent fractions whose denominator is a power of two. A guard written against "big numbers" will wave through every ordinary price.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>SQLite type affinity — <a href="https://www.sqlite.org/datatype3.html">datatypes in SQLite (§3, type affinity)</a>.</li>
  <li>sluice type mapping for SQLite / D1 — <a href="/docs/type-mapping/#sqlite-d1">type mapping</a>.</li>
  <li>Go <code>strconv.FormatFloat</code> — <a href="https://pkg.go.dev/strconv#FormatFloat">the <code>'f'</code> vs <code>'g'</code> verbs</a> (exponent switch-over).</li>
  <li>The dyadic-rational boundary — <a href="https://en.wikipedia.org/wiki/Double-precision_floating-point_format">IEEE-754 double-precision format</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: SQLite WAL checkpoint starvation ----------------------
write(
  "field-notes/sqlite-wal-checkpoint-starvation",
  page({
    slug: "field-notes/sqlite-wal-checkpoint-starvation",
    title: "One long-lived reader, 75 GB of WAL",
    subtitle: "A continuous-CDC run against a 20 GB SQLite source watched the -wal file grow from zero to 75 GB in 52 minutes — while the change-log table it tracked stayed bounded at a few thousand rows. In WAL mode, a checkpoint can only reclaim frames older than the oldest live reader's snapshot.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — continuous <code>sqlite-trigger</code> CDC against a WAL-mode SQLite source, ~52-minute endurance run. Internally Bug 167 (found v0.99.151, fixed v0.99.152).</p>

<h2 id="what-happened">What happened</h2>
<p>A continuous-CDC endurance run against a 20 GB SQLite source watched the <code>-wal</code> sidecar file grow from zero to <strong>75 GB in 52 minutes</strong> — roughly 1.4 GB/min, linear, with no plateau — while the change-log table the sync tracked stayed bounded at a few thousand rows the whole time (a periodic prune kept its row count in check). Exactly-once was never in doubt; the harm was pure disk-fill, and it capped how long a continuous sync against a SQLite source could run. The process RSS crept up in lockstep, ~0.9 MB/min.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>In WAL mode, a checkpoint can only copy-and-reclaim frames older than the <strong>oldest live reader's snapshot</strong>. A reader holding a snapshot pins every WAL frame at or after its read-mark, so the checkpoint can restart the WAL but never <em>truncate</em> the file. sluice's poll loop kept a live read on the source between polls, so the WAL accumulated every superseded version of the same heavily-churned change-log B-tree pages — each insert-then-prune-delete rewrites the same pages, and every old version stayed pinned. An explicit <code>PRAGMA wal_checkpoint(TRUNCATE)</code> <em>with the sync still running</em> could not reclaim the 75 GB.</p>
<p>Ground truth was theatrical: the instant the process was killed and its read snapshot released, the last-connection-close checkpoint <strong>truncated the 75 GB WAL to zero</strong>, and the whole thing collapsed to about 0.6 GB of genuinely new pages in the main file. So ~74 GB of it was superseded frames the reader's snapshot had pinned. The precise culprit turned out to be subtle: it wasn't a single explicit long transaction but the poller's <code>database/sql</code> connection pool retaining an <strong>idle connection</strong> whose stale WAL read-mark pinned the checkpoint. (The RSS creep tracked the WAL, not the Go heap — it was <code>modernc</code>'s OS-level mmap of the ever-growing <code>-wal</code>, a secondary effect that bounding the WAL also bounds.)</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`# multi-GB WAL-mode SQLite source; start a continuous CDC sync to any target;
# drive a sustained insert/update/delete workload while pruning the change-log
# so its ROW count stays bounded; sample the WAL each minute:
stat --format='%s' big.db-wal     # climbs ~GB/min, no plateau,
                                  # even though the change-log row count is flat

# stop the sync -> the last connection closes -> the WAL truncates to ~0.
# That truncation-on-close is the proof the running reader pinned it.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The fix is protocol hygiene, not tuning, and it has two parts (local-SQLite path only — the <code>d1-trigger</code> source polls over HTTP with no local pager and is unaffected). First, the poller's read connection is no longer retained idle (<code>SetMaxIdleConns(0)</code>), so its WAL read-mark is released after each poll and a checkpoint can reset the WAL — this alone held the WAL flat at ~8 MB in a focused repro where the default idle pool grew it to 158 MB in 12 seconds. Second, the poll loop issues <code>PRAGMA wal_checkpoint(TRUNCATE)</code> on a 30-second cadence (busy-tolerant: a <code>BUSY</code> result just retries next cadence), so the WAL stays bounded even when the operator's own application has disabled <code>wal_autocheckpoint</code>. The checkpoint runs in the poll goroutine between polls, never racing the read, and never touches the watermark or the exactly-once path.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>A reader's snapshot pins the log — this is the same principle that makes an idle Postgres replication slot fill a disk (<a href="/field-notes/postgres-slot-leaks/">slots don't die with your process</a>) and long transactions bloat any MVCC engine's dead-tuple space. SQLite just shows it to you as a single file you can <code>stat</code>. If you hold a long-lived read against a churning table, you are silently retaining every superseded version of the pages you touch; release the snapshot periodically (short-lived read transactions, and mind your connection pool's <em>idle</em> connections — a pooled idle connection holds a read-mark just as a live query does) so the log can be reclaimed. And watch for the second-order effect: a growing WAL that gets mmap'd can look like a memory leak while your heap stays perfectly flat.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>SQLite Write-Ahead Logging — <a href="https://www.sqlite.org/wal.html">the WAL design</a> (checkpointing and the reader-snapshot constraint).</li>
  <li><code>PRAGMA wal_checkpoint</code> and <code>wal_autocheckpoint</code> — <a href="https://www.sqlite.org/pragma.html#pragma_wal_checkpoint">SQLite pragmas</a>.</li>
  <li>sluice trigger-based CDC — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: empty object vs empty array ---------------------------
write(
  "field-notes/empty-object-vs-array",
  page({
    slug: "field-notes/empty-object-vs-array",
    title: "{}: two characters, two types, one silent corruption",
    subtitle: "In Postgres, {} is an empty array literal. In JSON, it's an empty object. Funnel both through one value-preparation path and []byte(\"{}\") is genuinely ambiguous — and for nine releases our MySQL writer resolved it the wrong way.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL writer, empty JSON object on bulk copy. Internally Bug 47 (fixed v0.29.1; reproduced identically on every binary from v0.20.0 through v0.29.0).</p>

<h2 id="what-happened">What happened</h2>
<p>A MySQL source value <code>attrs = '{}'</code> (an empty JSON <em>object</em>, <code>JSON_TYPE</code> = <code>OBJECT</code>) round-tripped through sluice and landed on a MySQL target as <code>attrs = '[]'</code> — an empty <em>array</em>, <code>JSON_TYPE</code> = <code>ARRAY</code>. Every other JSON shape was perfect: populated objects, empty arrays, populated arrays, JSON null, JSON scalars. Only the empty object flipped type, and it did so silently, on every release for nine versions.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The two literals collide on their bytes. In Postgres, <code>{}</code> is the empty <em>array</em> literal; in JSON, <code>{}</code> is the empty <em>object</em>. When a migration pipeline funnels both worlds through one value-preparation path, <code>[]byte("{}")</code> arriving at the encoder is <strong>genuinely ambiguous</strong> — the bytes alone cannot say whether they mean "empty PG array, which for a MySQL JSON column should become <code>[]</code>" or "empty MySQL JSON object, which should stay <code>{}</code>." The MySQL writer guessed array, so empty objects became <code>[]</code>.</p>
<p>The instructive part is the first fix attempt, which was rolled back within a day. Simply preserving <code>{}</code> as an object broke the opposite case — a Postgres empty array overridden onto a MySQL JSON column <em>should</em> land as <code>[]</code> — because no local heuristic can disambiguate two bytes that carry two legitimate meanings. The writer didn't need a cleverer guess; it needed <em>information it didn't have</em>: the source column's type, threaded down to the encoder.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- MySQL source: six canonical JSON shapes
INSERT INTO t (id, attrs) VALUES
  (1, '{"role":"admin"}'),  -- populated object: preserved
  (2, '{}'),                -- empty object:     CORRUPTED -> []
  (3, '[]'),                -- empty array:      preserved
  (4, '[1,2,3]'),           -- populated array:  preserved
  (5, 'null'),              -- JSON null:        preserved
  (6, '"hello"');           -- scalar:           preserved

-- migrate MySQL -> MySQL, then on the target:
SELECT id, JSON_TYPE(attrs) FROM t WHERE id = 2;
--  before the fix: ARRAY   (source was OBJECT)`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The fix threads the missing context through the IR: <code>ir.Column</code> gained an optional <code>SourceColumnType</code> field that the translation layer populates, and the MySQL writer consults it to disambiguate — source type is an array &rarr; <code>[]</code>, otherwise &rarr; <code>{}</code>. The disambiguation is <em>column-scoped</em>, proven by a single-row test with two columns: an empty <code>text[]</code> overridden to a MySQL JSON column lands as <code>[]</code>, while an empty JSON object in the sibling column lands as <code>{}</code> — same row, opposite resolutions, because each carries its own source type.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>Value translation is only sound when type information travels <em>with</em> the value, all the way to the last encoder. The moment two distinct source types can serialize to identical bytes — <code>{}</code> the empty array and <code>{}</code> the empty object, or an empty string versus SQL <code>NULL</code>, or <code>0</code> the number versus <code>0</code> the boolean — a downstream stage that sees only the bytes cannot recover the intent, and any local heuristic it applies will be right for one meaning and wrong for the other. Don't make the encoder guess; carry the type.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Postgres array input syntax (<code>{}</code> as the empty array) — <a href="https://www.postgresql.org/docs/current/arrays.html">arrays</a>.</li>
  <li>MySQL JSON type and <code>JSON_TYPE()</code> — <a href="https://dev.mysql.com/doc/refman/8.0/en/json.html">the JSON data type</a>.</li>
  <li>sluice type mapping (how source type is carried across the translate boundary) — <a href="/docs/type-mapping/">type mapping</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: zero-value config trap --------------------------------
write(
  "field-notes/zero-value-config-trap",
  page({
    slug: "field-notes/zero-value-config-trap",
    title: "The zero value is a loaded gun",
    subtitle: "Twice in this project a config field that “defaults on” silently defaulted off (or worse) for every caller that didn't go through the CLI — because in Go, every construction site that doesn't set a field gets the zero value. Both had real database consequences.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — two config-defaulting bugs with database consequences. The first (a CDC resnapshot path) is the v0.99.51 trap behind ADR-0093; the second is Bug 180, an un-extendable encrypted backup chain (fixed v0.99.185).</p>

<h2 id="what-happened">What happened</h2>
<p>Twice, a config field meant to "default on" silently defaulted <em>off</em> — or to an unreachable value — for every caller that didn't construct it through the CLI. Both looked correct in a unit test and both had a real database consequence: one a CDC resnapshot path, the other an encrypted backup chain you couldn't extend.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>In Go, every struct construction site that doesn't set a field gets that field's <strong>zero value</strong> — <code>false</code> for a bool, <code>""</code> for a string. The CLI is one construction site; every test, every internal broker/chain path, and every future caller is another, and they all get the zero value unless they explicitly set the field. A field <em>named for its on-behavior</em> silently inverts to off for all of them.</p>
<ul>
  <li><strong>Round one — a boolean defaulting the wrong way.</strong> <code>AutoResnapshotOnInvalidPosition</code> was intended to default <em>true</em>. But every test and internal construction that didn't set it got <code>false</code> and took the suppressed branch. The race-detector integration job surfaced it as a nil-deref panic on that branch — an intended-on safety behavior was off everywhere except the CLI.</li>
  <li><strong>Round two — a default that made a feature unreachable, and it shipped.</strong> The backup encrypt-mode feature "omit <code>--encrypt-mode</code> to inherit the chain's mode" keyed the inherit branch on an empty string. But <code>kong</code>, the CLI parser, fills the flag's declared default (<code>"per-chain"</code>) whenever the operator omits it — so no CLI invocation could ever produce the empty string the inherit branch needed. The branch was dead from the parser's side. The unit test passed <code>""</code> directly and went green, sailing right past the layer that made it unreachable. The operator-visible result: extending or resuming a <code>per-chunk</code>-encrypted backup chain via the natural "omit the flag" invocation was refused.</li>
</ul>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`type Streamer struct {
    // intended to default ON — but every caller that doesn't set it
    // gets the zero value (false) and silently takes the OFF branch:
    AutoResnapshotOnInvalidPosition bool
}

s := Streamer{}          // a test, a broker path, a future caller...
// s.AutoResnapshotOnInvalidPosition == false  -> suppressed branch

// The kong variant: a direct-call test cannot see a default the parser injects.
//   flag omitted on the CLI -> kong fills "per-chain" -> inherit branch (keyed
//   on "") is unreachable; but a unit test that passes "" directly goes green.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Two rules fell out, both now project doctrine. First: <strong>name a boolean config for its opt-out</strong> (<code>SuppressX</code>, <code>NoX</code>), never <code>EnableX</code>-defaulting-true-by-intent, so the zero value <em>is</em> the safe, common behavior and no construction site can silently invert it. Second: <strong>pin any omitted-flag semantics through the real argument parser</strong>, not a direct call — a unit test that hands the function a value the parser would never produce (an empty string kong fills with a default) proves nothing about the actual CLI path. Bug 180's fix is verified end-to-end: omitting <code>--encrypt-mode</code> now resolves to <code>""</code>, flows to the orchestrator, and correctly inherits the chain's mode, so an incremental into a <code>per-chunk</code> chain succeeds and restores byte-exact.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>In any language with zero-value initialization, the default that matters is the one an <em>unset</em> field takes, not the one your primary constructor writes — and your CLI is only one of many constructors. Make the zero value the safe, common case. And when a behavior is gated on a specific config value, especially an omitted or empty one, test it <em>through the real parser</em>: a framework default (kong, argparse, a builder's fallback) can quietly make a branch unreachable while a direct-call unit test that supplies the value by hand stays green. The green test is testing a code path no user can reach.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Go zero values — <a href="https://go.dev/ref/spec#The_zero_value">the language spec on zero values</a>.</li>
  <li><code>kong</code>, the CLI parser sluice uses (default injection) — <a href="https://github.com/alecthomas/kong">github.com/alecthomas/kong</a>.</li>
  <li>sluice encrypted-backup chains and modes — <a href="/docs/encrypted-backups/">Take encrypted backups</a> and <a href="/docs/from-backup-sync/">Sync from a backup chain</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: MySQL JSON = bind parameter ---------------------------
write(
  "field-notes/mysql-json-where-cast",
  page({
    slug: "field-notes/mysql-json-where-cast",
    title: "MySQL won't match a JSON column by bind parameter",
    subtitle: "WHERE json_col = ? matches zero rows in MySQL whether you bind the value as a string or as bytes — the server won't cast the parameter to JSON for the comparison. On a CDC UPDATE, replay-idempotency tolerance turns that zero-row match into silent divergence.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL &rarr; MySQL logical replication (CDC apply) touching a <code>JSON</code> column. Internally the applier value-shaping fix, ADR-0013 (v0.2.2).</p>

<h2 id="what-happened">What happened</h2>
<p>A MySQL-to-MySQL CDC UPDATE on a table with a <code>JSON</code> column silently applied nothing: zero rows affected, stream position advanced, exit 0, no error. The same applier in the <em>other</em> direction — Postgres to MySQL — failed <strong>loudly</strong> on the identical column, crashing with <code>Cannot create a JSON value from a string with CHARACTER SET 'binary'</code>. One applier, one JSON column, two directions, opposite symptoms — and only the loud one was safe.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The applier bound the row's values straight into parameterised SQL. Two MySQL-isms bit, in sequence:</p>
<ul>
  <li><strong>The bytes.</strong> <code>go-sql-driver/mysql</code> tags a <code>[]byte</code> parameter with the <code>_binary</code> introducer, and MySQL rejects that for a <code>JSON</code> column (<code>… CHARACTER SET 'binary'</code>) — the loud PG&rarr;MySQL crash. The bulk-copy path had already learned to convert JSON <code>[]byte</code> to a <code>string</code>; the CDC path hadn't inherited the fix.</li>
  <li><strong>The comparison.</strong> The deeper one, and the silent one: <strong>MySQL's <code>=</code> does not implicitly cast a <code>?</code> bind parameter to JSON</strong> — bind the value as a <code>string</code> or as <code>[]byte</code>, either way <code>WHERE doc = ?</code> compares a <code>JSON</code> column against a non-JSON parameter and matches <em>nothing</em>. The UPDATE found no row to change.</li>
</ul>
<p>What made the second one invisible is a property of every correct CDC applier: it must tolerate <em>zero rows affected</em>, because logical-replication resume re-applies events idempotently (a re-applied UPDATE legitimately matches zero rows the second time — <a href="/docs/how-sluice-copies/">that tolerance is what makes replay safe</a>). So the applier could not tell "already applied" from "never matched," logged the zero-row result as normal, advanced the position, and diverged the target with no signal.</p>

<h2 id="repro">The repro</h2>
<p>The comparison, in isolation — no replication needed:</p>
<pre><code>${esc(`CREATE TABLE ledger (id BIGINT PRIMARY KEY, doc JSON);
INSERT INTO ledger VALUES (1, '{"k":"v"}');

-- a JSON column compared against a (string/bytes) parameter:
SELECT * FROM ledger WHERE doc = '{"k":"v"}';              -- 0 rows
-- the same comparison, parameter cast to JSON first:
SELECT * FROM ledger WHERE doc = CAST('{"k":"v"}' AS JSON); -- 1 row

-- so a CDC applier binding: UPDATE ledger SET ... WHERE doc = ?
--   matches nothing, reports 0 rows affected, and (idempotency
--   tolerance) advances the stream position anyway.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The CDC applier now routes every bound value through the same per-type <code>prepareValue</code> shaping the bulk-copy path uses (JSON <code>[]byte</code> &rarr; <code>string</code>, and the rest), driven by a lazily-populated per-table column-type cache. For the comparison itself, a <code>placeholderFor(type)</code> helper emits <code>CAST(? AS JSON)</code> instead of a bare <code>?</code> for JSON-typed columns, so the equality is JSON-to-JSON and matches. The Postgres applier needs no cast equivalent — pgx inspects per-column type metadata natively. And a <code>Debug</code> line now fires whenever an UPDATE or DELETE matches zero rows: resume idempotency still depends on tolerating that case, but the silence now leaves a footprint.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>A parameterised <code>=</code> against a typed column is not type-agnostic: MySQL will not coerce a bind parameter into JSON, so a comparison that reads correctly matches nothing at runtime. And when the consumer is a CDC applier, its <em>idempotency tolerance</em> — the very thing that makes replay safe — is exactly what hides a never-matched predicate. This is the MySQL sibling of a Postgres story we hit on the same class: <a href="/field-notes/replica-identity-full-updates/">REPLICA IDENTITY FULL silently ate our UPDATEs</a>, where a <code>jsonb</code> value failed an equality round-trip. Same shape, two engines, two root causes: when equality quietly stops matching, replay-tolerance swallows the loss.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL JSON comparison &amp; the need to cast — <a href="https://dev.mysql.com/doc/refman/8.0/en/json.html">The JSON Data Type</a> and <a href="https://dev.mysql.com/doc/refman/8.0/en/cast-functions.html"><code>CAST(… AS JSON)</code></a>.</li>
  <li>The <code>_binary</code> charset introducer behavior — <a href="https://dev.mysql.com/doc/refman/8.0/en/charset-introducer.html">character set introducers</a>.</li>
  <li>Why a CDC applier tolerates zero-row applies — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: MySQL LOAD DATA charset dilemma -----------------------
write(
  "field-notes/mysql-load-data-charset",
  page({
    slug: "field-notes/mysql-load-data-charset",
    title: "One LOAD DATA can't load a BLOB and a JSON column at once",
    subtitle: "A BLOB column needs CHARACTER SET binary or the server rejects its first non-ASCII byte; a JSON column rejects its input under CHARACTER SET binary. The two requirements point opposite ways, and there is no statement-level clause that satisfies both.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL bulk load via <code>LOAD DATA LOCAL INFILE</code> into a table with both a binary and a JSON column. Internally the LOAD DATA row writer, ADR-0026.</p>

<h2 id="what-happened">What happened</h2>
<p>The fast bulk-load path — <code>LOAD DATA LOCAL INFILE</code>, typically 5&ndash;10&times; faster than parameter-bound multi-row INSERTs because the server parses one statement and one stream — hit a table that carried both a <code>BLOB</code>/<code>VARBINARY</code> column and a <code>JSON</code> column. There is no single <code>CHARACTER SET</code> clause on the statement that loads both. Pick either one and the other column's rows are rejected.</p>

<h2 id="why">Why (the mechanism)</h2>
<p><code>LOAD DATA</code> validates every input byte against a charset, and that charset is a <em>statement-level</em> setting — one <code>CHARACTER SET</code> clause for all columns. The two column types want opposite things from it:</p>
<ul>
  <li><strong>Without <code>CHARACTER SET binary</code></strong>, the server validates input against the connection charset (utf8mb4) and rejects the first non-ASCII byte in a <code>BLOB</code>/<code>VARBINARY</code> column with <code>Error 1300: Invalid utf8mb4 character string</code>. Any binary column is silently broken.</li>
  <li><strong>With <code>CHARACTER SET binary</code></strong>, the server flips: a <code>JSON</code> column rejects its input with <code>Cannot create a JSON value from a string with CHARACTER SET 'binary'</code>, because JSON requires a Unicode-tagged input stream.</li>
</ul>
<p>The requirements are mutually exclusive at the statement level: binary columns demand the raw-bytes charset, JSON columns demand a Unicode one, and you get to name exactly one.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`CREATE TABLE mixed (id INT PRIMARY KEY, blob_col BLOB, json_col JSON);

-- utf8mb4 (default): the BLOB's first non-ASCII byte →
--   ERROR 1300 (HY000): Invalid utf8mb4 character string
LOAD DATA LOCAL INFILE 'Reader::x' INTO TABLE mixed
  CHARACTER SET utf8mb4 (id, blob_col, json_col);

-- CHARACTER SET binary: the JSON column →
--   ERROR 3144 (22032): Cannot create a JSON value from a string
--   with CHARACTER SET 'binary'
LOAD DATA LOCAL INFILE 'Reader::x' INTO TABLE mixed
  CHARACTER SET binary (id, blob_col, json_col);`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Load every field into a user variable under <code>CHARACTER SET binary</code>, then re-tag per column in a <code>SET</code> clause. Binary, numeric, and temporal columns take their variable verbatim (raw bytes, exactly what they want); <code>JSON</code>, <code>TEXT</code>, <code>VARCHAR</code>, and <code>SET</code> columns get <code>CONVERT(@cN USING utf8mb4)</code> — the bytes are unchanged, only the charset <em>tag</em> is corrected:</p>
<pre><code>${esc(`LOAD DATA LOCAL INFILE 'Reader::x' INTO TABLE mixed
  CHARACTER SET binary
  (@c0, @c1, @c2)
  SET id       = @c0,
      blob_col = @c1,                      -- raw bytes, verbatim
      json_col = CONVERT(@c2 USING utf8mb4); -- re-tagged to Unicode`)}</code></pre>
<p>The per-column re-tag is a named, tested wart (<code>columnSetExpr</code>): adding a new type that needs re-tagging is a one-line switch case. (Geometry stays on the batched-INSERT path and forgoes the LOAD DATA speedup; the fallback names the offending column in a WARN so the cause is diagnosable from one log line.)</p>

<h2 id="lesson">The transferable lesson</h2>
<p><code>CHARACTER SET</code> on <code>LOAD DATA</code> is a single, statement-wide, all-columns setting for what is really a <em>per-column</em> problem — and MySQL's own type system contains two columns that demand incompatible answers. The escape hatch is a general one: when a bulk statement must apply different byte-interpretation rules to different columns, funnel every field through a user variable and do the per-column work in a <code>SET</code> clause, where each column gets its own expression. It is the row-writer analogue of never trusting a single global setting to be right for every member of a heterogeneous set.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL <code>LOAD DATA</code>, its <code>CHARACTER SET</code> clause, and the user-variable + <code>SET</code> form — <a href="https://dev.mysql.com/doc/refman/8.0/en/load-data.html"><code>LOAD DATA</code> statement</a>.</li>
  <li>Why JSON rejects a binary charset — <a href="https://dev.mysql.com/doc/refman/8.0/en/json.html">The JSON Data Type</a>.</li>
  <li>How sluice bulk-loads a MySQL target — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: Postgres idle-slot failover trap ----------------------
write(
  "field-notes/postgres-idle-slot-failover",
  page({
    slug: "field-notes/postgres-idle-slot-failover",
    title: "Every HA knob on, and the slot still vanished at failover",
    subtitle: "Patroni slot-sync on, sync_replication_slots on, hot_standby_feedback on — and a logical slot that hadn't advanced during the sync window was still lost on promotion. “HA-replicated” means the slot's LSN is copied on a timer, not that the slot can't be lost.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — Postgres HA (Patroni / PG&nbsp;17 native slot sync) source, failover during a quiet-source window. Operator-confirmed in production. See <a href="/docs/postgres-source-prep/">Prepare a Postgres source</a>.</p>

<h2 id="what-happened">What happened</h2>
<p>Every mechanism for surviving a failover was configured: Patroni <code>slots:</code> (the permanent logical slot), <code>sync_replication_slots = on</code>, and <code>hot_standby_feedback = on</code>. A failover promoted the standby, and the CDC stream came back with <code>wal_status = 'lost'</code> — the slot was present but invalid, pointing at WAL that no longer existed. Nothing in Postgres's logs named the dropped slot at failover time; it surfaced only when the consumer reconnected.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>Slot sync — Patroni's, and PG&nbsp;17's native equivalent gated by <code>logical_slot_sync_timeout</code> (default 300s) — is a primary&rarr;standby <strong>pull on a timer</strong>. The standby periodically copies the slot's LSN from the primary. The copy is therefore only ever as fresh as the last time the primary's slot <em>advanced</em>. If the primary's slot has not moved for the duration of the sync window — because the source is quiet, the consumer is paused, or the consumer's host is down — the standby's replica copy stays pinned at an old LSN. Promote that standby, and the new primary's slot points at WAL that has already been recycled: <code>wal_status = 'lost'</code> on the next resume.</p>
<p>The counter-intuitive part: the fragile case is the <em>idle</em> slot, not the busy one. A slot that isn't advancing can't be synced fresh, so “no traffic” — which feels safe — is exactly the condition that lets a failover strand it.</p>

<h2 id="repro">The diagnostic</h2>
<p>A failover is hard to stage on demand, but the precondition is observable: watch whether the slot's <code>confirmed_flush_lsn</code> advances on your workload.</p>
<pre><code>${esc(`SELECT slot_name, wal_status, active, confirmed_flush_lsn
FROM pg_replication_slots
WHERE slot_type = 'logical';

-- On a quiet source, sample confirmed_flush_lsn over time. If it does
-- NOT advance for hours, the standby's synced copy is frozen at that
-- LSN — and a failover during that window will surface wal_status='lost'
-- on resume. Advancement rate is the pre-production check.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Keep the slot advancing, two ways, and fall through cleanly if it's lost anyway:</p>
<ul>
  <li><strong>Keep the consumer active.</strong> sluice's PG CDC reader sends <code>pg_send_standby_status_update</code> every 10&nbsp;seconds whether or not events are flowing, so the slot reads as <code>active</code> from the primary's perspective and the standby's sync keeps pace. The operational rule: run <code>sync start</code> <em>continuously</em>, not as a one-shot during low-traffic windows.</li>
  <li><strong>Make a quiet source advance on purpose.</strong> For genuinely idle databases, inject WAL activity with <code>SELECT pg_logical_emit_message(false, 'sluice-heartbeat', '')</code> on a timer — it writes to WAL without modifying any user data (sluice's reader sees and discards it), guaranteeing the slot moves even if the active consumer briefly disconnects.</li>
  <li><strong>Backstop.</strong> If the slot is lost regardless, <code>sync start --resume</code> detects it, drops it, and falls through to a fresh cold-start rather than silently stalling.</li>
</ul>

<h2 id="lesson">The transferable lesson</h2>
<p>“HA-replicated” for a logical replication slot means <em>the slot's LSN is copied to the standby on a timer</em> — not that the slot cannot be lost. Because the sync copies a position, a slot that doesn't advance can't be synced fresh, which inverts the usual intuition: the idle slot is the fragile one, not the busy one. On a quiet source, don't rely on the slot's position drifting forward on its own — make it advance, with an active consumer or an explicit WAL heartbeat. This is a specific instance of a broader Postgres-slot truth we hit from the other side too: <a href="/field-notes/postgres-slot-leaks/">a slot's lifetime is the server's to manage, not your process's</a>.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>PG&nbsp;17 logical replication slot synchronization &amp; <code>logical_slot_sync_timeout</code> — <a href="https://www.postgresql.org/docs/current/logical-replication-failover.html">logical replication failover</a>.</li>
  <li><code>pg_logical_emit_message</code> (a WAL write with no user-data change) — <a href="https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-DBOBJECT">logical decoding message functions</a>.</li>
  <li>Patroni permanent slots &amp; slot failover — <a href="https://patroni.readthedocs.io/en/latest/dynamic_configuration.html">Patroni dynamic configuration</a>.</li>
  <li>sluice's Postgres source prep and the idle-slot mitigations — <a href="/docs/postgres-source-prep/">Prepare a Postgres source</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: Postgres LSN is timeline-scoped -----------------------
write(
  "field-notes/postgres-lsn-timeline-scoped",
  page({
    slug: "field-notes/postgres-lsn-timeline-scoped",
    title: "A Postgres LSN means nothing without its timeline",
    subtitle: "A logical-replication LSN is only comparable within a (system_id, timeline) tuple. Resume after a PITR or a promotion and the same slot name and same stored LSN point into a different WAL reference frame — the source streams from it happily, and events are silently skipped or replayed.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — Postgres logical-replication (slot-based) source, resume after a source-side PITR / standby promotion / base-backup clone. Internally ADR-0051 (a severity-A finding from a Postgres-internals audit).</p>

<h2 id="what-happened">What happened</h2>
<p>A CDC stream resumed against a source that had been point-in-time-restored, picked up from its persisted <code>(slot, lsn)</code> position, and silently diverged. No error, no gap in the logs. The slot still existed by name; the stored LSN was still a valid-looking number; the source streamed WAL from it without complaint. But the rows that landed were not the rows that should have.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>A Postgres LSN is not a global coordinate. It is only meaningful within a <code>(system_id, timeline)</code> tuple: the <code>system_id</code> identifies a specific cluster, the timeline identifies a specific branch of its WAL history. LSN values from one timeline are simply not comparable to LSN values from another. Three ordinary operational events change that reference frame out from under a stored position:</p>
<ul>
  <li>a <strong>standby promotion</strong> increments the timeline (same <code>system_id</code>, new timeline);</li>
  <li>a <strong>PITR</strong> can produce a new timeline within the same cluster, or a fresh cluster from a base backup (new <code>system_id</code>);</li>
  <li>pointing the tool at a <strong>different instance</strong> that happens to share the DSN host:port shape (a clone) — new <code>system_id</code> entirely.</li>
</ul>
<p>The replication protocol hands you the identity on a plate — <code>IDENTIFY_SYSTEM</code> returns <code>(systemid, timeline, xlogpos, dbname)</code> before <code>START_REPLICATION</code> — but it is easy to call it only on cold-start to read <code>xlogpos</code> and discard the rest. Do that, and on resume you send the old LSN into the new timeline's WAL and the server obliges. The divergence is silent because nothing on either side is looking at the mismatch.</p>
<p>The sharp contrast is MySQL: a GTID set from a different <code>server_uuid</code> simply fails <code>GTID_SUBSET</code> against the new source's executed set, so the same class refuses itself for free. Postgres's raw LSN carries no such self-identifying provenance — you have to pin it yourself.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- capture the identity the LSN belongs to, before you trust the LSN:
IDENTIFY_SYSTEM;
--  systemid            | timeline | xlogpos   | dbname
--  7382...             |        1 | 0/1A2B3C4 | app

-- promote a standby (timeline -> 2), or PITR, then reconnect and:
IDENTIFY_SYSTEM;
--  systemid            | timeline | xlogpos   | dbname
--  7382...             |        2 | 0/95F00A0 | app
--            same slot name, same stored LSN 0/1A2B3C4 — but timeline 2's
--            WAL frame. Streaming from it is silently wrong.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>sluice pins <code>(SystemID, Timeline)</code> from <code>IDENTIFY_SYSTEM</code> onto the persisted position token and re-issues <code>IDENTIFY_SYSTEM</code> on every reconnect — <em>before</em> the slot-existence check, so a diverged source surfaces "source identity has changed" rather than a misleading "slot missing." On divergence it names both the old and new <code>(systemid, timeline)</code> so an operator can confirm the change matches their intended PITR/promotion, and refuses by wrapping the same <code>position-invalid</code> sentinel that routes a missing slot to a loud cold-start fall-through. There is deliberately no <code>--ignore-source-identity-change</code> flag: the old LSN is <em>by definition</em> meaningless against the new source, so "stay strict" is the only honest semantic. (Legacy tokens with no pin are accepted once, with an INFO line, then pinned going forward.)</p>

<h2 id="lesson">The transferable lesson</h2>
<p>If you persist a Postgres LSN, persist the <code>(system_id, timeline)</code> it belongs to alongside it, and compare on every reconnect. A stored replication position is a coordinate in a reference frame, not an absolute address — and the ordinary HA events you most want to survive (failover, restore) are exactly the ones that change the frame while leaving the slot name and the number looking valid. Unlike a GTID, a bare LSN won't catch its own staleness for you; that check is yours to write, and its absence is a silent-loss class.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Postgres replication protocol — <a href="https://www.postgresql.org/docs/current/protocol-replication.html"><code>IDENTIFY_SYSTEM</code> and <code>START_REPLICATION</code></a> (the identity tuple returned before streaming).</li>
  <li>Timelines and how promotion/PITR create them — <a href="https://www.postgresql.org/docs/current/continuous-archiving.html#BACKUP-TIMELINES">WAL timelines</a>.</li>
  <li>sluice's Postgres source preparation — <a href="/docs/postgres-source-prep/">Prepare a Postgres source</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: pgoutput streaming parse vs emit ----------------------
write(
  "field-notes/pgoutput-streaming-abort",
  page({
    slug: "field-notes/pgoutput-streaming-abort",
    title: "proto_version lets you parse streaming; only streaming='on' emits it",
    subtitle: "Two pgoutput knobs are easy to conflate. The receiver flag equips you to parse streamed transactions; a separate publisher flag makes the server actually send them. The gap between them hides a silent-loss shape: a dropped StreamAbort leaves already-committed chunks on the target.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — Postgres logical replication via <code>pgoutput</code>, a defensive audit of the streaming-protocol dispatch. Internally ADR-0055 (finding F1 of a Postgres-internals audit).</p>

<h2 id="what-happened">What happened</h2>
<p>A protocol audit found a <code>default:</code> branch in the WAL dispatcher that silently skipped <code>StreamAbortMessageV2</code>. Harmless in the tool's current configuration — but one config change away from durable, undetectable divergence. The interesting part is <em>why</em> it was latent, which is a pair of pgoutput knobs that look like one.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>pgoutput negotiates streaming through two independent capabilities on <code>START_REPLICATION</code>:</p>
<ul>
  <li><strong><code>proto_version</code> &ge; 2</strong> equips the <em>receiver</em> to parse the streaming frames — <code>StreamStart</code> / <code>StreamStop</code> / <code>StreamCommit</code> / <code>StreamAbortV2</code> — for transactions that exceed <code>logical_decoding_work_mem</code> (default 64&nbsp;MB) at the source.</li>
  <li><strong><code>streaming = 'on'</code></strong> (PG&nbsp;14+) or <strong><code>'parallel'</code></strong> (PG&nbsp;16+) makes the <em>publisher</em> actually emit those frames. Pass <code>proto_version = 2</code> <em>without</em> it and an oversized transaction is buffered and spilled to disk server-side, then delivered as one ordinary begin / rows / commit unit after it fully decodes.</li>
</ul>
<p>Parsing capability and emission are separate switches. Now the trap: suppose streaming is enabled (a config drift, a future change) and a consumer maps each streamed chunk to its own target transaction — a reasonable "one boundary → one commit" design. Chunk 1 commits durably on the target. Chunk 2 commits. Chunk N commits. Then the source <em>rolls the transaction back</em> and emits <code>StreamAbortMessageV2</code>. Drop that message and the N chunks stay committed on the target while the source has no record of them. The target now carries rows the source rolled back.</p>
<p>What makes it nasty is the <em>shape</em> of the loss. It is not a missing-rows gap that a row-count or checksum diff would catch — it is <em>extra</em> rows relative to the post-abort source, and nothing upstream is signalling their existence.</p>

<h2 id="repro">The repro (the two knobs)</h2>
<pre><code>${esc(`-- receiver equipped to PARSE streaming, but publisher not asked to EMIT it:
START_REPLICATION SLOT s LOGICAL 0/0 (proto_version '2', publication_names 'p');
--   a 200 MB transaction spills to pg_replslot/<slot>/ and arrives as ONE
--   begin/rows/commit unit. No StreamStart ever appears.

-- ask the publisher to emit it too:
START_REPLICATION SLOT s LOGICAL 0/0
  (proto_version '2', streaming 'on', publication_names 'p');
--   now the same txn arrives as StreamStart / rows / StreamStop chunks,
--   and a source ROLLBACK arrives as StreamAbortV2 — which a consumer
--   MUST act on, not skip.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>sluice runs <code>proto_version = 2</code> deliberately <em>without</em> <code>streaming</code>, so one source transaction maps to one target transaction (the alignment its batched apply depends on) and oversized transactions are the source's memory problem, not a target-consistency problem. The audit fix replaces the silent <code>default:</code> skip with an explicit <code>StreamAbortMessageV2</code> arm that refuses loudly if a streamed abort is ever seen — so a future flip of the publisher flag can't quietly resurrect the extra-rows class. (The spill it trades for is now observable too: PG&nbsp;14+ exposes <code>spill_txns</code> / <code>spill_bytes</code> in <code>pg_stat_replication_slots</code>.)</p>

<h2 id="lesson">The transferable lesson</h2>
<p>When a protocol negotiates a capability from both ends, "I can parse it" and "you will send it" are different switches, and the interesting failures live in the gap. Enumerate the messages a capability <em>could</em> deliver even if your current config never triggers them, and make the ones you don't handle <strong>refuse loudly</strong> rather than fall through a silent <code>default:</code> — because the config that starts triggering them is one flag away, and a protocol message you drop is a decision you made without knowing it. Watch especially for loss that shows up as <em>extra</em> committed state rather than a gap: checksums and row counts are built to find gaps.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>pgoutput protocol &amp; the <code>streaming</code> option — <a href="https://www.postgresql.org/docs/current/protocol-logical-replication.html">logical streaming replication protocol</a> and <a href="https://www.postgresql.org/docs/current/sql-createsubscription.html"><code>streaming</code> subscription option</a>.</li>
  <li>Streaming-of-in-progress-transactions &amp; the spill counters — <a href="https://www.postgresql.org/docs/current/view-pg-stat-replication-slots.html"><code>pg_stat_replication_slots</code></a>.</li>
  <li>How sluice maps source transactions to target transactions — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: CREATE IF NOT EXISTS is not atomic --------------------
write(
  "field-notes/create-if-not-exists-race",
  page({
    slug: "field-notes/create-if-not-exists-race",
    title: "CREATE IF NOT EXISTS is not a lock",
    subtitle: "CREATE TABLE / TYPE … IF NOT EXISTS does a catalog pre-check and then an insert, and those two steps aren't atomic against a concurrent creation of the same name. Race it and one side gets a unique_violation on pg_class — from the statement that reads like it can't fail.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — Postgres target, parallel schema build / parallel restore creating objects concurrently. Internally the catalog-race retry wrapper (control table, then the index-build path — live-caught during a parallel restore).</p>

<h2 id="what-happened">What happened</h2>
<p>Two connections ran <code>CREATE TABLE … IF NOT EXISTS</code> for the same name at nearly the same instant, and one of them failed with <code>ERROR: duplicate key value violates unique constraint "pg_class_relname_nsp_index" (SQLSTATE 23505)</code>. From the statement whose entire purpose is to be a safe no-op when the object already exists.</p>

<h2 id="why">Why (the mechanism)</h2>
<p><code>IF NOT EXISTS</code> is not a lock and not atomic. It is a two-step operation: check the system catalog (<code>pg_class</code> for a relation, <code>pg_type</code> for a type) for the name, and if absent, insert the catalog row. Two sessions can both pass the "absent" check before either inserts, and then the second insert collides on the catalog's own unique index — <code>pg_class_relname_nsp_index</code> for a table/index, <code>pg_type_typname_nsp_index</code> for a type — surfacing as SQLSTATE <code>23505 unique_violation</code>. The guard reads like idempotence; under concurrency it is a check-then-act race, and Postgres enforces name uniqueness at the catalog layer regardless of the friendly clause.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- two psql sessions, interleaved:
-- session A                         -- session B
BEGIN;
                                     BEGIN;
CREATE TABLE IF NOT EXISTS t (id int);
                                     CREATE TABLE IF NOT EXISTS t (id int);
COMMIT;                              -- blocks on A, then:
                                     -- ERROR: duplicate key value violates
                                     --   unique constraint
                                     --   "pg_class_relname_nsp_index" (23505)`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>sluice retries the failing statement — but only on the narrow, provably-benign shape: a <code>23505</code> whose constraint is a <em>catalog</em> index (<code>pg_class_relname_nsp_index</code> / <code>pg_type_typname_nsp_index</code>), which means "someone else just created this exact object" and the correct outcome (the object exists) has been reached. A <code>23505</code> on a <em>user</em> table's primary key or unique constraint is a genuine data conflict and stays loud — never swallowed by the retry. The same wrapper covers both the control-table setup and the concurrent index-build path.</p>

<h2 id="enum-corollary">The sharper cousin: CREATE TYPE has no IF NOT EXISTS at all</h2>
<p>The same "<code>IF NOT EXISTS</code> is not the safety you think" trap has an even sharper edge for Postgres <code>ENUM</code> types — because there the guard doesn't exist. <code>CREATE TYPE ... AS ENUM</code> has no <code>IF NOT EXISTS</code> form, so a cold-start that creates enum types and is then interrupted mid-copy re-enters its schema phase on resume and <strong>hard-fails with <code>SQLSTATE 42710 "type already exists"</code></strong> — turning every restart into a crash-loop with zero progress. It's especially nasty because the resume path deliberately skips the populated-target preflight on the assumption that the schema phase is fully idempotent — true for the <code>CREATE TABLE IF NOT EXISTS</code> sitting right next to it, false for the enum. Postgres's idempotent equivalent is a <code>DO</code> block that swallows <code>duplicate_object</code>:</p>
<pre><code>${esc(`DO $$ BEGIN
  CREATE TYPE status AS ENUM ('active','closed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;`)}</code></pre>
<p>And enum types <em>outlive</em> the columns that use them — drop the column and the type is orphaned, not cleaned up — so a re-create after a partial drop collides on the same <code>42710</code>. The generalization: on Postgres a first-class catalog object's "make it exist" step is neither atomic (the <code>pg_class</code>/<code>pg_type</code> race above) nor universally guarded (<code>CREATE TYPE</code> has no <code>IF NOT EXISTS</code>), so any resume-or-retry path that assumes "re-running CREATE is safe" has to earn that assumption per object type.</p>

<h2 id="lesson">The transferable lesson</h2>
<p><code>IF NOT EXISTS</code> (and <code>CREATE OR REPLACE</code>, and most "make it exist" DDL) is a convenience, not a concurrency primitive — it removes the error when <em>you</em> ran it twice in sequence, not when two workers run it at once. If your tool issues DDL in parallel, treat a catalog <code>23505</code> as an expected, retryable outcome of the race, and scope the retry tightly to the catalog constraint so a real user-data uniqueness violation still fails loudly. The tell that you have this bug is a "can't happen" duplicate-key error on a statement you thought was idempotent.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Postgres on the non-atomicity of <code>IF NOT EXISTS</code> — <a href="https://www.postgresql.org/docs/current/sql-createtable.html"><code>CREATE TABLE</code></a> (the <code>IF NOT EXISTS</code> note) and the <a href="https://www.postgresql.org/docs/current/errcodes-appendix.html">error-code appendix</a> (<code>23505 unique_violation</code>).</li>
  <li>The system catalogs that enforce name uniqueness — <a href="https://www.postgresql.org/docs/current/catalog-pg-class.html"><code>pg_class</code></a> / <a href="https://www.postgresql.org/docs/current/catalog-pg-type.html"><code>pg_type</code></a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: CDC carries no column default -------------------------
write(
  "field-notes/cdc-carries-no-default",
  page({
    slug: "field-notes/cdc-carries-no-default",
    title: "The replication stream never tells you the column default",
    subtitle: "Neither pgoutput nor the MySQL binlog carries a column's DEFAULT. Forward an ADD COLUMN … DEFAULT now() over CDC and the target re-evaluates the default on its own — so every row that shipped before the ALTER gets a different value than the source's backfill.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — cross-engine CDC schema-change forwarding, an <code>ALTER TABLE … ADD COLUMN … DEFAULT &lt;volatile&gt;</code> on the source mid-stream. Internally ADR-0058 (online schema-change forwarding) + Bug 90 / Bug 91.</p>

<h2 id="what-happened">What happened</h2>
<p>A source added a column with a default — <code>ALTER TABLE orders ADD COLUMN created_at timestamptz DEFAULT now()</code> — while CDC was tailing it. The DDL forwarded to the target and new rows looked fine. But every row that had <em>already</em> shipped to the target before the ALTER carried a different <code>created_at</code> than the same row on the source. Silent per-row divergence across the whole pre-existing table.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>Two facts combine. First, <strong>the replication wire format does not carry a column's DEFAULT.</strong> pgoutput's <code>RelationMessage</code> describes each column's name, type OID, and flags — there is no <code>attdefault</code> slot. MySQL's <code>TableMapEvent</code> describes column types and metadata — there is no <code>COLUMN_DEFAULT</code>. A CDC schema-forwarder literally cannot see the default in the stream; it only sees the DDL text (or the relation shape).</p>
<p>Second, <strong>a volatile default is evaluated at ALTER time, per row.</strong> When the source runs <code>ADD COLUMN … DEFAULT now()</code> (or <code>random()</code>, <code>gen_random_uuid()</code>, MySQL <code>UUID()</code> / <code>RAND()</code>), it backfills every existing row with the default <em>evaluated then, on the source</em>. If the target only replays the DDL, it re-evaluates the default independently — a different <code>now()</code>, different random values, different UUIDs — for its own copy of those rows. The two backfills disagree, row by row. A <em>constant</em> default (<code>DEFAULT 0</code>, <code>DEFAULT 'active'</code>) is safe precisely because it evaluates identically on both sides; the failure dispatches on the default's <strong>volatility class</strong>, not on any one function.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- source, with CDC tailing and rows already replicated to the target:
ALTER TABLE orders ADD COLUMN created_at timestamptz DEFAULT now();
--   source backfills existing rows with the ALTER-time now(), e.g.
--   2026-05-25 10:00:00+00 for every pre-existing row.

-- target, replaying only the DDL:
ALTER TABLE orders ADD COLUMN created_at timestamptz DEFAULT now();
--   target backfills the SAME rows with ITS now(), e.g.
--   2026-05-25 10:00:07+00 — 7 seconds off, every row, silently.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>sluice classifies the default's volatility when it forwards an <code>ADD COLUMN</code>. A constant/immutable default is safe to replay as-is. A <em>volatile</em> default (time, random, UUID, sequence <code>nextval</code>) cannot be reconstructed identically from the DDL alone, so sluice does not let the target re-evaluate it — it forwards the column and drives an explicit, source-authoritative backfill of the already-shipped rows (or refuses loudly for the shapes it doesn't forward), rather than trusting two independent evaluations to agree. Sequence defaults get their own volatility classification (a <code>nextval</code> is as non-reproducible as <code>now()</code>).</p>

<h2 id="lesson">The transferable lesson</h2>
<p>A replication stream carries <em>data changes</em>, not the schema's generative rules — the DEFAULT is metadata that lives in the catalog, and neither pgoutput nor the binlog puts it on the wire. So "replay the DDL on the target" is only correct when the default is a constant. The moment a default is volatile, the source's ALTER-time backfill and the target's replayed backfill are two independent evaluations of a non-deterministic expression, and they will not match. If you forward schema changes over CDC, classify default volatility explicitly and treat volatile defaults as data to be copied from the source, never as DDL to be re-run.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>pgoutput <code>RelationMessage</code> (no default field) — <a href="https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html">logical replication message formats</a>.</li>
  <li>Postgres function volatility categories — <a href="https://www.postgresql.org/docs/current/xfunc-volatility.html">function volatility</a>.</li>
  <li>MySQL binlog <code>TABLE_MAP_EVENT</code> — <a href="https://dev.mysql.com/doc/dev/mysql-server/latest/classbinary__log_1_1Table__map__event.html">Table_map_event</a>.</li>
  <li>How sluice handles source schema changes during a sync — <a href="/docs/schema-changes/">Schema changes during a sync</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: MySQL TIME is a duration ------------------------------
write(
  "field-notes/mysql-time-is-a-duration",
  page({
    slug: "field-notes/mysql-time-is-a-duration",
    title: "MySQL TIME is a duration, not a time of day",
    subtitle: "A MySQL TIME column ranges -838:59:59 to 838:59:59 and models elapsed duration, not clock time. Postgres time is a time-of-day, 00:00 to 24:00 — so any negative or over-24-hour MySQL TIME has no home there. The faithful target is interval.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL &rarr; Postgres migration of a <code>TIME</code> column. Internally the <code>TIME &rarr; ir.Interval</code> type mapping.</p>

<h2 id="what-happened">What happened</h2>
<p>A MySQL-to-Postgres migration mapped a <code>TIME</code> column to Postgres <code>time</code> by name — the obvious pairing — and rows carrying values like <code>500:30:00</code> (a stopwatch total) or <code>-12:30:00</code> (a negative offset) had nowhere to land. The names match; the semantics do not.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>MySQL's <code>TIME</code> is a <strong>signed duration</strong>, documented range <code>-838:59:59</code> to <code>838:59:59</code> — roughly &plusmn;35 days. It is designed to hold elapsed time (a lap time, a total worked, a delta), which is why it goes negative and well past 24 hours. Postgres <code>time</code> is a <strong>time of day</strong>: <code>00:00:00</code> to <code>24:00:00</code>, a point on the clock, with no notion of negative or "more than a day." They share a name and a <code>HH:MM:SS</code> spelling, and diverge completely at the edges. Any MySQL <code>TIME</code> outside <code>[00:00, 24:00)</code> — negative, or over 24 hours — simply cannot be represented as a Postgres <code>time</code>. The correct Postgres home for a duration is <code>interval</code>, which is signed and unbounded in exactly the way <code>TIME</code> needs.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- MySQL: TIME holds durations, signed, well past 24h
CREATE TABLE laps (id INT, elapsed TIME);
INSERT INTO laps VALUES (1, '500:30:00'), (2, '-12:30:00');  -- both valid

-- Postgres time is a clock reading — these have no representation:
SELECT '500:30:00'::time;   -- ERROR: date/time field value out of range
SELECT '-12:30:00'::time;   -- ERROR: invalid input syntax for type time
-- the faithful target:
SELECT '500:30:00'::interval;  -- 500:30:00
SELECT '-12:30:00'::interval;  -- -12:30:00`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>sluice maps MySQL <code>TIME</code> to the IR's <code>Interval</code> type, which lands on Postgres <code>interval</code> — so the full signed, &plusmn;838-hour range round-trips instead of clipping or erroring at the <code>time</code> boundary. The name-based <code>TIME &rarr; time</code> pairing is exactly the trap the IR exists to avoid: translation is by <em>semantics</em>, resolved in one place, not by matching type spellings across engines.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>Two databases can give a type the same name and the same surface syntax and mean different things by it — MySQL <code>TIME</code> is a <em>duration type</em> wearing a time-of-day costume. When you translate types across engines, map on the value's <em>semantics and range</em>, not its name: the question isn't "does Postgres have a <code>time</code>?" but "what does MySQL let this column hold, and what's the Postgres type that holds all of it?" The answer for <code>TIME</code> is <code>interval</code>, and you only learn that by looking at the range, not the label.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL <code>TIME</code> range and duration semantics — <a href="https://dev.mysql.com/doc/refman/8.0/en/time.html">The <code>TIME</code> Type</a> (&minus;838:59:59 … 838:59:59).</li>
  <li>Postgres <code>time</code> vs <code>interval</code> — <a href="https://www.postgresql.org/docs/current/datatype-datetime.html">date/time types</a>.</li>
  <li>sluice's type-mapping policy — <a href="/docs/type-mapping/">Type mapping</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: Postgres text can't hold a NUL byte -------------------
write(
  "field-notes/postgres-text-no-nul-byte",
  page({
    slug: "field-notes/postgres-text-no-nul-byte",
    title: "Postgres text can't hold a NUL byte",
    subtitle: "text, varchar, and char reject an embedded 0x00 with SQLSTATE 22021; MySQL char/text store it without complaint. A cross-engine copy hits it, and because it fires inside the COPY protocol the error lands far from the offending row.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL &rarr; Postgres copy of a text column containing an embedded NUL byte. Internally the Postgres <code>prepareValue</code> NUL guard.</p>

<h2 id="what-happened">What happened</h2>
<p>A cross-engine copy of a perfectly ordinary <code>VARCHAR</code> column failed on the Postgres side with a cryptic <code>invalid byte sequence for encoding "UTF8": 0x00</code> — and because it surfaced inside the bulk <code>COPY</code> stream, the error landed nowhere near the row that carried the byte. The source column held a string with an embedded <code>0x00</code> (a stray NUL from an upstream C string, a serialized blob mislabeled as text, a bad import), which MySQL had stored without objection.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>Postgres text types — <code>text</code>, <code>varchar</code>, <code>char</code> — <strong>cannot store a <code>0x00</code> byte</strong>. The NUL is reserved as a string terminator in the server's internal C representation, so an embedded one is rejected as an invalid byte sequence (SQLSTATE <code>22021</code>, character-not-in-repertoire). MySQL's <code>CHAR</code>/<code>VARCHAR</code>/<code>TEXT</code> have no such rule — they treat the NUL as an ordinary byte and store it. So the value is legal on one engine and illegal on the other, and a migration is exactly where the two meet. The diagnosis is made harder by <code>COPY</code>: the failure fires while streaming the bulk buffer, so the error message is detached from the individual offending row.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- MySQL stores an embedded NUL happily:
CREATE TABLE t (id INT, s VARCHAR(64));
INSERT INTO t VALUES (1, CONCAT('a', CHAR(0), 'b'));   -- OK, 3 bytes

-- Postgres rejects the same bytes in a text type:
SELECT E'a\\x00b'::text;
--   ERROR: invalid byte sequence for encoding "UTF8": 0x00  (SQLSTATE 22021)
-- bytea holds arbitrary bytes, NUL included:
SELECT E'\\x610062'::bytea;   -- \\x610062, no complaint`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>sluice refuses the value loudly with a coded error (<code>SLUICE-E-VALUE-NUL-BYTE</code>) that names the column and the constraint, rather than letting the opaque COPY-stream error surface far from the row — and rather than the tempting silent "fix" of stripping the NUL, which would quietly alter the data. The data-preserving path, when you genuinely need to carry those bytes, is to target <code>bytea</code>, which stores arbitrary binary including <code>0x00</code>. Loud refusal with the remedy named beats a cryptic wire error or a silent mutation.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>"It's a string column on both sides" is not the same as "the same bytes are legal on both sides." Postgres text is Unicode text with a hard rule — no <code>0x00</code> — that MySQL text does not share, so a value that lives happily in MySQL is a hard error in Postgres. When the two disagree about what bytes a type may hold, the honest options are to refuse loudly (naming the column and the fix) or to route the data to a type that can hold it (<code>bytea</code>); silently stripping the offending byte to make the insert succeed is data corruption wearing the disguise of a bug fix.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Postgres on the NUL character in text — <a href="https://www.postgresql.org/docs/current/datatype-character.html">character types</a> and SQLSTATE <code>22021</code> in the <a href="https://www.postgresql.org/docs/current/errcodes-appendix.html">error-code appendix</a>.</li>
  <li><code>bytea</code> for arbitrary bytes — <a href="https://www.postgresql.org/docs/current/datatype-binary.html">binary data types</a>.</li>
  <li>sluice's value contract and coded refusals — <a href="/docs/error-codes/">Error &amp; exit codes</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: MySQL binlog transaction compression ------------------
write(
  "field-notes/binlog-transaction-compression",
  page({
    slug: "field-notes/binlog-transaction-compression",
    title: "A whole transaction in one zstd binlog event",
    subtitle: "MySQL 8.0.20+ can pack an entire transaction into a single compressed TRANSACTION_PAYLOAD_EVENT. A binlog reader without a handler for it applies nothing and freezes its position with no error — and the server zeroes the inner events' end_log_pos, so a naive resume restarts mid-payload and dies.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL &rarr; target CDC from a source with <code>binlog_transaction_compression = ON</code>. Internally the <code>TRANSACTION_PAYLOAD_EVENT</code> decode + resume-alignment fix.</p>

<h2 id="what-happened">What happened</h2>
<p>CDC from a MySQL 8.0.20+ source that had <code>binlog_transaction_compression</code> enabled (common for WAN replication and disk savings) silently applied nothing for compressed transactions: rows never landed, the stream position froze, and there was no error. Turning the setting off "fixed" it — which is the tell that the reader was missing an event type, not hitting a bug.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>With <code>binlog_transaction_compression = ON</code>, the server packs a whole transaction — its <code>TABLE_MAP</code>, its <code>ROWS</code> events, its <code>XID</code> — into a single zstd-compressed <code>TRANSACTION_PAYLOAD_EVENT</code>. A binlog consumer that doesn't recognize that event type simply skips it: zero rows applied, position advanced past it, no error raised. Everything the transaction did is inside a payload the reader walked past.</p>
<p>There is a second, sharper trap in the resume path. Inside the payload, the server <strong>zeroes the <code>end_log_pos</code> of the inner events</strong> (they no longer have a meaningful standalone file offset — they live inside the outer event). A resumer that stamps its checkpoint from an inner event's header therefore records position <code>0</code>, and on warm-resume restarts <em>inside</em> the payload — where it finds row events with no preceding table map and dies with <code>"no corresponding table map event."</code> The correct checkpoint is the <em>outer</em> <code>TRANSACTION_PAYLOAD_EVENT</code>'s <code>LogPos</code> (the transaction boundary). GTID-mode streams dodge this half, because the <code>GTIDEvent</code> precedes the payload and carries the resumable coordinate.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- source (MySQL 8.0.20+):
SET GLOBAL binlog_transaction_compression = ON;
INSERT INTO t VALUES (1), (2), (3);   -- one compressed txn

-- in the binlog, instead of TABLE_MAP + WRITE_ROWS + XID you now see:
--   Transaction_payload   (compression: ZSTD)
--     └─ TABLE_MAP / WRITE_ROWS / XID  (inner; end_log_pos = 0)
-- a reader with no Transaction_payload handler applies 0 of the 3 rows,
-- reports no error, and advances past it.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>sluice decompresses the <code>TRANSACTION_PAYLOAD_EVENT</code> and dispatches its inner events as if they had arrived uncompressed, so a compressed source is transparent. For the resume half, it stamps its checkpoint from the <em>outer</em> payload event's <code>LogPos</code> (the transaction boundary), never an inner event's zeroed <code>end_log_pos</code> — so a warm-resume lands on a transaction boundary and never mid-payload. Both halves are pinned by regression tests, because the failure only appears with the setting on and a resume across a compressed transaction.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>A binlog reader's completeness is defined by the source settings it has <em>never seen</em>, not the ones it was tested against. <code>binlog_transaction_compression</code> is off by default, so a reader can pass every local test and silently drop every transaction the moment a DBA turns it on for bandwidth. Two lessons ride together: handle (or loudly refuse) every binlog event type the source <em>can</em> emit, not just the common ones; and when a container event rewrites its children's coordinates — here, zeroing inner <code>end_log_pos</code> — make sure your resume checkpoint comes from the coordinate that's still valid (the outer boundary), or your recovery path breaks exactly when you need it.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL binlog transaction compression — <a href="https://dev.mysql.com/doc/refman/8.0/en/binary-log-transaction-compression.html">binary log transaction compression</a> and the <a href="https://dev.mysql.com/doc/dev/mysql-server/latest/classbinary__log_1_1Transaction__payload__event.html"><code>Transaction_payload_event</code></a>.</li>
  <li>sluice's MySQL CDC and resume model — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: Vitess per-shard primary key --------------------------
write(
  "field-notes/vitess-per-shard-primary-key",
  page({
    slug: "field-notes/vitess-per-shard-primary-key",
    title: "Your primary key is only unique per shard",
    subtitle: "vtgate merges every Vitess/PlanetScale shard into one logical stream, but per-shard id ranges mean the same primary-key value legitimately exists on several shards. Copy them into one target table with that key and the collisions silently overwrite — exit 0, rows short.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — sharded Vitess / PlanetScale keyspace consolidated into a single target table. Internally Bug 152 + ADR-0048 (<code>--inject-shard-column</code>).</p>

<h2 id="what-happened">What happened</h2>
<p>Consolidating a sharded Vitess keyspace into one target table finished clean — exit 0 — with fewer rows on the target than the sum of the shards. No error, no duplicate-key complaint. Rows from different shards that shared a primary-key value had silently overwritten each other.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>A sharded keyspace behind vtgate presents as <em>one</em> logical database, so it is natural to treat it as one source and copy it into one target table. But uniqueness in Vitess is <strong>per shard</strong>, not global: each shard runs its own MySQL with its own auto-increment range, and tenant-local or hash-partitioned ids mean primary-key value <code>42</code> can legitimately exist on shard <code>-80</code> and again on shard <code>80-</code>, as two entirely different rows. Merge those into a single target table whose primary key is that id, and the second insert of <code>42</code> collides with the first. If the copy uses an upsert/replace, the collisions silently overwrite; if it uses plain inserts, the target's own PK rejects them — either way the consolidated table is short, and unless you are diffing counts per shard it looks like a clean run.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- vtgate presents one stream; the shards each own id 42:
mysql> SHOW VITESS_SHARDS;
--  customer/-80
--  customer/80-
-- shard -80: (id=42, name='alice')   shard 80-: (id=42, name='bob')

-- consolidate into one target with id as PK:
--   INSERT (42,'alice')  -> ok
--   INSERT (42,'bob')    -> duplicate key / or REPLACE overwrites alice
-- result: one row for id=42, one tenant silently lost.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>sluice makes the shard identity part of the target key. With <code>--inject-shard-column NAME=VALUE</code> it adds a discriminator column carrying each source's shard identity and folds it into the target's primary/unique key, so <code>(shard, id)</code> is globally unique and no row is overwritten. The consolidation preflight discovers the shard set (via <code>SHOW VITESS_SHARDS</code>) and — critically — <strong>fails closed</strong> if it can't establish that the merged keys will be unique, rather than proceeding into a silent overwrite. (If your ids are already provably global — Vitess sequences, or UUIDs — you don't need the discriminator, but that has to be true, not assumed.)</p>

<h2 id="lesson">The transferable lesson</h2>
<p>"One connection endpoint" does not mean "one key space." A sharded database presented through a single proxy still enforces uniqueness at the shard, so any primary key that isn't provably global — anything backed by per-shard auto-increment or per-tenant numbering — collides the moment you consolidate. Before merging N sources into one table, prove the key is globally unique or make it so (add the shard discriminator to the key), and make the check fail <em>closed</em> — because the failure mode is silent overwrite, and a row-count that's merely "smaller than expected" is easy to rationalize away.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Vitess sharding &amp; per-shard uniqueness — <a href="https://vitess.io/docs/reference/features/sharding/">Vitess sharding</a> and <a href="https://vitess.io/docs/reference/features/vitess-sequences/">Vitess sequences</a> (the global-id escape hatch).</li>
  <li>sluice multi-source consolidation — <a href="/docs/multi-database/">Migrate many databases or schemas</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: MySQL ENUM ordinal / SET bitmask on the wire ----------
write(
  "field-notes/mysql-enum-set-binlog-encoding",
  page({
    slug: "field-notes/mysql-enum-set-binlog-encoding",
    title: "ENUM is an ordinal and SET is a bitmask on the wire",
    subtitle: "In a raw binlog row event a MySQL ENUM cell is its 1-based ordinal and a SET cell is a numeric bitmask; the member-name list lives only in the table definition, never in the event. Decode without the schema and SET('a','c') becomes \"5\". Snapshot and VStream hand you text, so it hides until raw CDC.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL raw-binlog CDC of <code>ENUM</code> / <code>SET</code> columns. Internally Bug 145 (ENUM ordinal) + Bug 148 (SET bitmask).</p>

<h2 id="what-happened">What happened</h2>
<p>A MySQL CDC stream delivered an <code>ENUM('small','medium','large')</code> value as <code>2</code> and a <code>SET('a','b','c')</code> value as <code>5</code> instead of <code>'medium'</code> and <code>'a,c'</code>. The same columns had round-tripped perfectly during the bulk-copy snapshot — the divergence appeared only once the raw binlog took over.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>MySQL stores <code>ENUM</code> and <code>SET</code> as integers and puts those integers, not the labels, on the binlog wire:</p>
<ul>
  <li>an <code>ENUM</code> cell in a <code>RowsEvent</code> is its <strong>1-based ordinal</strong> (<code>'medium'</code> &rarr; <code>2</code>);</li>
  <li>a <code>SET</code> cell is a <strong>numeric bitmask</strong> (bit <em>i</em> &rarr; the <em>i</em>-th member; <code>'a','c'</code> &rarr; <code>0b101</code> = <code>5</code>), sized to the storage width.</li>
</ul>
<p>The mapping from those integers back to label strings lives <em>only</em> in the table definition — it is never in the row event. A CDC reader that doesn't join the event against the schema decodes the raw integer and emits <code>"2"</code> / <code>"5"</code>. What hides the bug is that the two <em>other</em> ways of reading the same data both resolve the labels for you: a snapshot via <code>database/sql</code> returns the text, and Vitess VStream returns the text — so everything looks correct until you hit the raw binlog path, where the integers are all you get. (And a bit set beyond the declared members must be an error, not silently dropped.)</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`CREATE TABLE t (id INT, size ENUM('small','medium','large'), tags SET('a','b','c'));
INSERT INTO t VALUES (1, 'medium', 'a,c');

-- a snapshot query resolves the labels:
SELECT size, tags FROM t;           -- 'medium', 'a,c'

-- the raw binlog RowsEvent carries the integers:
--   size = 2         (1-based ordinal of 'medium')
--   tags = 5         (bitmask 0b101 = 'a' | 'c')
-- decode without the ENUM/SET member list and you store "2" and "5".`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>sluice carries the <code>ENUM</code>/<code>SET</code> member lists from the table's schema into the binlog decoder, so an ordinal is resolved back to its label and a bitmask is expanded to the comma-joined member set — matching exactly what the snapshot and VStream paths produce, so the two halves of a cold-start-then-CDC migration agree. A bitmask bit or ordinal outside the declared members is refused loudly rather than dropped, because a value the schema can't explain is a signal, not a row to guess at. This is a companion to a different <code>ENUM</code>/<code>SET</code> trap — <a href="/field-notes/mysql-enum-emoji/">MySQL substituting <code>?</code> for a 4-byte-UTF-8 label at <code>CREATE TABLE</code></a> — two independent ways these "simple" types are sneakier than they look.</p>

<h2 id="lesson">The transferable lesson</h2>
<p><code>ENUM</code> and <code>SET</code> are integers in a trenchcoat: an ordinal and a bitmask on disk and on the binlog wire, with the crucial integer&rarr;label dictionary held only in the table definition. Any decoder that reads the raw replication stream must join it against the schema to recover meaning — and the danger is that the easy paths (query results, VStream) do that join for you, so the raw-binlog path is the one place the abstraction leaks, and it leaks silently as plausible-looking numbers. When a value's meaning lives in metadata separate from the value, make sure every read path has that metadata in hand.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL <code>ENUM</code> and <code>SET</code> storage (ordinal / bitmask) — <a href="https://dev.mysql.com/doc/refman/8.0/en/enum.html">The <code>ENUM</code> Type</a> and <a href="https://dev.mysql.com/doc/refman/8.0/en/set.html">The <code>SET</code> Type</a>.</li>
  <li>Binlog row images — <a href="https://dev.mysql.com/doc/dev/mysql-server/latest/classbinary__log_1_1Rows__event.html"><code>Rows_event</code></a>.</li>
  <li>sluice's cross-engine value contract — <a href="/docs/type-mapping/">Type mapping</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: VStream snapshot bounded memory -----------------------
write(
  "field-notes/vstream-snapshot-oom",
  page({
    slug: "field-notes/vstream-snapshot-oom",
    title: "The cold-start that buffered a whole table into swap",
    subtitle: "A 13 GB PlanetScale table drove the process to ~41 GB of RAM and got OOM-killed with zero rows written — the VStream snapshot reader held the entire copy phase in memory before a single row reached the target. The buffer wasn't laziness; three engine behaviors forced it.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — PlanetScale / Vitess cold-start (VStream COPY snapshot) of one large table. Internally ADR-0071 (extends the ADR-0028 memory-bounded-streaming audit, which never reached this reader).</p>

<h2 id="what-happened">What happened</h2>
<p>A cold-start snapshot of a ~13 GB, ~19M-row PlanetScale table walked the process's RSS up 28 &rarr; 38 &rarr; ~41 GB on a 32 GB host, into swap, until the OOM killer reaped it — and <strong>not one row had been written to the target</strong> the entire time. The most ordinary cold-start shape there is (one big table) was an unbounded-memory failure.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The VStream snapshot reader drained the <em>entire</em> COPY phase into an in-memory <code>map[table][]Row</code> before it returned the stream — it only completed after the <em>global</em> <code>COPY_COMPLETED</code> event, and only then did bulk-copy to the target begin. So peak memory was the whole snapshot, and target writes couldn't start until the buffer was full.</p>
<p>The uncomfortable part is that the buffer wasn't sloppiness — three VStream behaviors <em>force</em> a receiver to buffer, and a naive "just stream it straight through" rewrite breaks all three:</p>
<ul>
  <li><strong>Order decoupling.</strong> VStream emits COPY rows in <em>its</em> order; the orchestrator consumes table-by-table in <em>its</em> order. Something has to hold the rows whose turn hasn't come.</li>
  <li><strong>Multi-shard fan-in.</strong> One logical table's rows arrive interleaved from N shards; they're merged by unqualified table name, which means collecting across the whole stream.</li>
  <li><strong>Inline dedup.</strong> Vitess re-emits rows already behind its scan cursor during COPY (binlog catch-up); those duplicate PKs are dropped as events arrive, which needs the stream in hand.</li>
</ul>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Two changes, shipped together. First, a correctness floor: the buffer is now accounted in bytes and <strong>refuses loudly</strong> over a cap (naming the table and the <code>--max-buffer-bytes</code> guidance) instead of growing into swap — a silent OOM becomes a bounded, diagnosable error. Second, the real fix: stop draining to completion. After capturing field metadata and the initial position, the reader returns immediately and pumps the gRPC stream from a background goroutine <em>under the byte cap</em>, emitting each table's rows as they arrive. A slow target backpressures the channel, which backpressures the <code>Recv</code>, which backpressures Vitess — so memory stays constant and target writes start right away. All three forcing invariants are preserved inside the bounded pump: dedup stays inline, shard fan-in still merges by name, and the snapshot position still finalizes at <code>COPY_COMPLETED</code>.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>When a snapshot or CDC wire protocol <em>decouples the order it emits from the order you consume</em> — and especially when it also fans in from multiple shards and expects you to dedup inline — it has quietly made you a buffering system, and the buffer is unbounded by default until one large table walks you into swap. The fix is not to remove the buffer (those invariants are real) but to <strong>bound it by bytes and backpressure the source</strong>: pump under a cap so a slow consumer slows the producer, and refuse loudly rather than silently at the ceiling. The tell for this bug is a process that sits at growing RSS with zero output — it isn't slow, it's buffering the world before it starts.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Vitess VStream COPY / catch-up semantics — <a href="https://vitess.io/docs/reference/vreplication/vstream/">VStream</a>.</li>
  <li>gRPC flow control / backpressure — <a href="https://grpc.io/docs/what-is-grpc/core-concepts/">gRPC core concepts</a>.</li>
  <li>How sluice cold-starts a sync — <a href="/docs/zero-downtime-cutover/">Zero-downtime migration</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: migrate-state quadratic JSON blob ---------------------
write(
  "field-notes/migrate-state-quadratic-blob",
  page({
    slug: "field-notes/migrate-state-quadratic-blob",
    title: "One JSON blob in one row is a quadratic write",
    subtitle: "Storing all per-table progress as a single growing JSON blob and re-upserting it on every checkpoint is O(n²) work. On Postgres the amplification lands somewhere specific: a new tuple version plus a re-TOAST of the whole value, every time, on one hot row — while the clone runs inside the lock your workers are waiting on.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — the resumable-migration state store under a high-frequency checkpoint loop across many tables. Internally ADR-0082 (a HIGH-rated P1 audit finding).</p>

<h2 id="what-happened">What happened</h2>
<p>Sluice's resumable-migration progress lived as one JSON blob — the whole <code>map[table]TableProgress</code> — in a single database row, re-written on every checkpoint. At the 10,000-table scale the parallel copy pool targets, that one row was re-encoded and re-upserted <strong>≥20,000 times</strong> per migration (two breadcrumbs per table, plus a resume cursor every 5,000 rows, plus a checkpoint per chunk), each write carrying the whole ~0.86 MB blob. It worked fine at ten tables and quietly became a performance wall at ten thousand.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>There are two costs stacked on top of each other. The first is the obvious quadratic: the blob grows linearly with table count, and it's rewritten a number of times that also grows with table count, so total work is O(n&sup2;). The second is where it hurts on a real database — <strong>Postgres MVCC and TOAST</strong>:</p>
<ul>
  <li>An <code>UPDATE</code> in Postgres doesn't overwrite in place; it writes a <em>new tuple version</em> and marks the old one dead (to be reclaimed by vacuum later). Rewriting one row 20,000 times creates 20,000 dead versions of that row.</li>
  <li>A ~0.86 MB value is far past the ~2 KB inline threshold, so it lives in <strong>TOAST</strong> (the out-of-line storage for oversized values). Each update re-TOASTs the whole value into fresh chunks. The measured write amplification was ~17 GB — for a progress log.</li>
  <li>And the whole-map deep clone that precedes the encode ran <em>inside the state mutex</em>, so every checkpoint serialized against all the parallel copy workers — the O(n) clone was also a contention point.</li>
</ul>
<p>The row count you think you're bounded by (tables) is not the row count that bites (tuple versions of one hot row).</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Split the single blob into a <strong>header row plus one row per table</strong>, and give the store an O(1) per-table write. A checkpoint now upserts a single small progress row instead of re-encoding the whole map, so total work drops to O(n) and the TOAST re-write is per-table, not per-everything. The concurrency win comes for free: because workers now write <em>different</em> rows, the state mutex stops serializing them. (An additive <code>state_format</code> column lets an in-flight legacy blob upgrade in place, once.)</p>

<h2 id="lesson">The transferable lesson</h2>
<p>"Just keep the state as one JSON column and upsert it" is an O(n&sup2;) amplifier the moment the state grows and the checkpoints are frequent — and on an MVCC database the cost is not merely re-serialization: every write is a new tuple version plus a re-TOAST of the entire oversized value, all concentrated on one hot row that also becomes a lock. Give any growing state map an O(1) per-key write surface (a row per key), and you fix the algorithmic cost, the storage amplification, and the write contention in one move. The same shape shows up in this project's <a href="/field-notes/backup-manifest-quadratic/">backup manifest</a> — a growing metadata object rewritten once per unit of progress is the pattern to watch for — and, per <em>tick</em> instead of per write, in a <a href="/field-notes/poll-cost-grows-with-history/">poller that re-derives its state from full history</a>.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Postgres MVCC (an UPDATE writes a new row version) — <a href="https://www.postgresql.org/docs/current/mvcc-intro.html">concurrency control intro</a> and <a href="https://www.postgresql.org/docs/current/routine-vacuuming.html">routine vacuuming</a>.</li>
  <li>TOAST (out-of-line storage for large values) — <a href="https://www.postgresql.org/docs/current/storage-toast.html">TOAST</a>.</li>
  <li>sluice's resumable migration model — <a href="/docs/preview-and-validate/">Preview &amp; validate</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: O(n^2) backup manifest --------------------------------
write(
  "field-notes/backup-manifest-quadratic",
  page({
    slug: "field-notes/backup-manifest-quadratic",
    title: "Rewriting the whole manifest, once per chunk",
    subtitle: "Every backup checkpoint re-wrote the entire manifest.json, schema included. Since the manifest grows with table count, the total was quadratic — a measured ~78 hours of pure manifest rewriting at 100k tables. And the two obvious ways to fix it are the same quadratic in disguise.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — <code>sluice backup full</code> of a many-table database; per-chunk and per-table checkpoints. Internally ADR-0086.</p>

<h2 id="what-happened">What happened</h2>
<p>Every per-chunk and per-table checkpoint during a backup re-marshaled the <em>entire</em> manifest — the full embedded schema along with it — and re-wrote the whole <code>manifest.json</code>. The manifest grows linearly with table count, and it was rewritten a number of times that also grows with table count, so the total checkpoint work was quadratic. A scale probe put a number on it: roughly <code>0.018·N + 2.77e-5·N²</code> seconds over N tables — about <strong>78 hours of pure manifest rewriting at 100,000 tables, ~322 days at a million</strong>. Every other part of the backup path is linear; this was the one super-linear wall.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>It is the textbook <code>O(grows with N) × (done N times) = O(N²)</code>, hiding in plain sight because it is invisible at small scale: a backup of a few dozen tables rewrites a small file a few dozen times and finishes instantly, so nothing in local testing flags it. The checkpoints themselves can't just be thinned out — the crash contract (a crash leaves at most <code>tableParallelism</code> tables to redo) and the content-addressed upload-skip both depend on durable per-event progress. The work is load-bearing; the <em>full rewrite per event</em> is the waste.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Split the in-progress manifest into a <strong>base written once</strong> (schema, anchor, encryption header, the pre-staged table entries — the heavy immutable parts) plus an <strong>append-only <code>manifest.progress.jsonl</code> sidecar</strong> — one compact JSON line per checkpoint, O(1) per event — folded back into a byte-identical self-contained <code>manifest.json</code> at success. That's the easy half. The instructive half is what they <em>didn't</em> do:</p>
<ul>
  <li>The sidecar append is a single <code>O_APPEND</code> write plus fsync — <strong>deliberately not the usual write-to-temp-then-rename</strong>. Append-then-rename re-copies the whole growing file on every call: the exact quadratic being removed, wearing the costume of a safe atomic write.</li>
  <li>Object stores (S3/GCS/Azure) have no append primitive, and emulating one with read-modify-write re-copies the object every call — <strong>quadratic again</strong>. So the blob-store path keeps the legacy full-rewrite behavior, as a named, WARN-logged wart rather than a silent one.</li>
</ul>

<h2 id="lesson">The transferable lesson</h2>
<p>A metadata object that grows with your work and is rewritten once per unit of progress is silently O(n&sup2;), and it will pass every test you run at small scale and only surface as <em>days</em> at 100k. The fix is append-only rather than rewrite — but the trap has a second floor: the two most natural ways to make an append "safe" (write-to-tmp-and-rename, or read-modify-write on a store with no native append) each re-copy the whole file per call and quietly reintroduce the exact quadratic you set out to kill. When you replace an O(n&sup2;) rewrite, verify the replacement is genuinely O(1) per step and not an O(n) copy in disguise — and where the substrate can't give you a true append (object storage), say so out loud instead of shipping the quadratic silently. The same "stop rewriting the whole growing thing per checkpoint" lesson bit this project's <a href="/field-notes/migrate-state-quadratic-blob/">migration state store</a> too, there through MVCC and TOAST — and it recurs per <em>tick</em> rather than per write in a <a href="/field-notes/poll-cost-grows-with-history/">poller that re-reads all of history</a>.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>POSIX <code>O_APPEND</code> atomic appends — <a href="https://pubs.opengroup.org/onlinepubs/9699919799/functions/open.html"><code>open()</code></a>.</li>
  <li>Why object stores aren't append-friendly — <a href="https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#BasicsObjects">S3 objects are immutable (replace-whole-object)</a>.</li>
  <li>sluice's backup format &amp; checkpoints — <a href="/docs/encrypted-backups/">Take encrypted backups</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: batch by bytes, not rows ------------------------------
write(
  "field-notes/batch-by-bytes-not-rows",
  page({
    slug: "field-notes/batch-by-bytes-not-rows",
    title: "Count your bytes, not your rows",
    subtitle: "A batch size tuned for narrow OLTP rows — 5,000 rows, under 10 MB — quietly pins hundreds of MB the moment the workload is MB-scale TEXT, BYTEA, JSON, or geometry. Row count is a proxy for memory, and it's only honest when rows are uniform.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — bulk-copy (batched INSERT) and CDC apply into a target, a batch size set by row count meeting wide columns. Internally ADR-0028 (memory-bounded streaming).</p>

<h2 id="what-happened">What happened</h2>
<p>The batch accumulators were bounded by <strong>row count</strong> — <code>--bulk-batch-size 5000</code> for bulk INSERT, <code>--apply-batch-size</code> for CDC. On the narrow OLTP rows most tests use, 5,000 rows is under 10 MB and everything is fine. On a table with MB-scale <code>TEXT</code> / <code>BYTEA</code> / <code>JSON</code> / geometry columns, the same 5,000-row batch pinned <em>hundreds of MB</em> of driver parameter buffer — and a 500-change CDC batch holding one open transaction's parameter slice did the same. Memory spiked exactly where the configured batch size promised it wouldn't.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>Row count is a stand-in for memory that only holds when every row is about the same small size. A batch accumulator holds N rows' worth of shaped values and driver parameter buffers before it flushes — that's N &times; (row width), and row width varies across workloads by orders of magnitude. A schema with one wide column breaks the proxy: <code>5000 &times; 10&nbsp;bytes</code> is 50&nbsp;KB, <code>5000 &times; 2&nbsp;MB</code> is 10&nbsp;GB, same batch size. Notably, the <code>COPY</code> and <code>LOAD DATA</code> paths were <em>immune</em> — they stream row-by-row through driver-controlled wire buffers and never hold N rows at once — so only the two <strong>accumulators</strong> (batched INSERT, and the open-transaction CDC apply) had the problem. The bound was on the wrong axis.</p>

<h2 id="repro">The repro (the arithmetic)</h2>
<pre><code>${esc(`-- same batch size, four orders of magnitude apart in memory:
--   narrow:  5000 rows x ~10 B/row   = ~50 KB   in flight
--   wide:    5000 rows x ~2 MB/row   = ~10 GB   in flight
-- a batch size that is safe for your test data is a memory bomb for
-- someone else's schema — a single BYTEA/JSON/geometry column does it.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Add a byte budget: <code>--max-buffer-bytes</code> (default 64 MiB) that flushes on whichever fires first, the row count or the accumulated bytes. A wide-row workload transparently uses a smaller batch; a narrow one keeps the full count. The streaming paths (<code>COPY</code>, <code>LOAD DATA</code>) need no change, because they were never accumulators. The precedent is worth stealing: PlanetScale's pscale dumper already flushes its bulk-INSERT batcher at ~1 MB of <em>statement body</em>, not a fixed row count, for exactly this reason.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>Row count is a proxy for memory, and the proxy is only accurate when rows are uniform. The moment a schema has a wide column — a blob, a document, a geometry — "5,000 rows" can mean 50 KB or 10 GB, so a batch size that's safe for your data is a memory bomb for someone else's. Bound an accumulator by the resource you actually care about (bytes), and keep the count as a secondary cap. And know which of your paths are accumulators and which are streamers: the streaming ones were never at risk here, because they never hold the whole batch at once — the same reason a byte cap belongs on the two that do. (It's the smaller cousin of a <a href="/field-notes/vstream-snapshot-oom/">snapshot reader that buffered a whole table into swap</a>.)</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Postgres large-value storage (why a "row" can be megabytes) — <a href="https://www.postgresql.org/docs/current/storage-toast.html">TOAST</a>.</li>
  <li>The 1 MB statement-body flush precedent — pscale / mydumper batch sizing conventions.</li>
  <li>How sluice copies data (streaming vs batched paths) — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: poll cost grows with history --------------------------
write(
  "field-notes/poll-cost-grows-with-history",
  page({
    slug: "field-notes/poll-cost-grows-with-history",
    title: "A poller that re-reads all of history every tick",
    subtitle: "A backup broker rebuilt its entire lineage chain on every 30-second tick — one object-store GET per manifest, even when nothing had changed. On a week-old stream that's ~2,000 GETs a tick, forever, with a tick that could outlast its own interval. The cost was tied to the age of the stream, not the size of the change.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — the backup broker following a live backup chain on object storage to replay new increments into a target. Internally the broker chain-cache fix.</p>

<h2 id="what-happened">What happened</h2>
<p>The broker follows a growing backup chain and, every 30 seconds, replays whatever is new into the target. To find "what's new," it rebuilt the <em>entire</em> lineage chain from the root on every tick — one object-store <code>GET</code> plus a JSON decode per manifest — even when nothing had changed since the last tick. On a week-old stream rolling over every 5 minutes, the chain is ~2,000 manifests, so an idle tick did ~2,000 GETs, and a single tick could take longer than the 30-second interval that was supposed to trigger the next one.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The walk was <strong>O(history) per tick</strong> — not quadratic, but a per-tick cost that grows linearly with total accumulated history and never levels off. A poller that re-derives its state from the full history on every interval has a cost bound to the <em>age</em> of the stream rather than the <em>size of the change</em>, so the steady-state (nothing happened) is also the expensive case, and it gets more expensive every day the stream runs. On object storage the sting is doubled: each chain-walk read is a billed <code>GET</code> with real network latency, so "re-read everything, find nothing changed" is both slow and a line item.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Cache the walked chain, keyed on a cheap <strong>change-token</strong>: the raw-byte identity of the two objects that are rewritten whenever the chain changes — <code>lineage.json</code> (rewritten on every structural change) and the tail manifest (rewritten in place per checkpoint). Read the token <em>before</em> the rebuild, so a racing writer can only ever make the cached key look older, never let a stale chain be served — the worst case is one unnecessary rebuild, never a wrong answer. An idle tick drops from ~2,000 GETs to exactly two.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>A polling system that re-derives its state from full history on every tick has a per-tick cost that grows without bound as the history grows — invisible on day one, a self-inflicted slowdown (and a storage bill) by week two, precisely because the <em>idle</em> path is the expensive one. The fix isn't to poll less often; it's to make "nothing changed" cheap: cache on a small change-token, validate the token before the expensive rebuild, and order the reads so a concurrent writer can only invalidate conservatively. This is the same family as two other things that bit this project — <a href="/field-notes/backup-manifest-quadratic/">rewriting the whole manifest per chunk</a> and <a href="/field-notes/migrate-state-quadratic-blob/">re-encoding the whole state blob per checkpoint</a> — all three pay for the entire accumulated size on every small step, and all three pass every fresh, small-scale test and only bite with age or volume.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Object-store request cost &amp; latency (why per-tick GET counts matter) — <a href="https://aws.amazon.com/s3/pricing/">S3 request pricing</a>.</li>
  <li>Change-token / conditional-read patterns — <a href="https://developer.mozilla.org/en-US/docs/Web/HTTP/Conditional_requests">HTTP conditional requests</a> (ETag/If-None-Match, the same idea applied to a cache key).</li>
  <li>sluice's backup chain &amp; broker — <a href="/docs/from-backup-sync/">Sync from a backup chain</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: binlog event volume ----------------------------------
write(
  "field-notes/binlog-event-volume",
  page({
    slug: "field-notes/binlog-event-volume",
    title: "One INSERT is three binlog events (or four)",
    subtitle: "The binlog is a log of events, not row changes. A single-row INSERT lands as three (BEGIN / WRITE_ROWS / XID), plus a spurious empty BEGIN/COMMIT per new connection — so if you size a rollover bound by INSERT count, budget 4×. Postgres counts differently again.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — sizing <code>sluice backup stream</code>'s <code>--rollover-max-changes</code> against expected INSERT counts on a MySQL source. See <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</p>

<h2 id="what-happened">What happened</h2>
<p>An operator set an incremental-backup rollover bound against the number of INSERTs they expected to drive, and the windows closed 3&ndash;4&times; earlier than that — rows they thought would land in the <em>current</em> incremental spilled into the next one. The count the tool bounds on and the count in the operator's head were measuring different things.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The MySQL binlog records <strong>events</strong>, not user-visible row changes, and a change is wrapped in transaction framing. A single autocommit one-row <code>INSERT</code> is <strong>three</strong> events:</p>
<pre><code>${esc(`1. BEGIN            (QueryEvent)
2. WRITE_ROWS_EVENTv2   (the actual row)
3. XID              (commit)`)}</code></pre>
<p>A multi-row <code>INSERT ... VALUES (r1),(r2),...,(rN)</code> collapses the row events into one each, so it's <code>2 + N</code> (BEGIN + N row events + XID) — a 1,000-row multi-row insert is ~1,002 events, not 3,000. On top of the per-transaction framing there's a per-<em>connection</em> tax: many client sessions emit an <strong>empty BEGIN/COMMIT pair</strong> before their first DML, because the driver issues a session-setup statement (<code>SET autocommit</code>, <code>SET time_zone</code>, …) inside an implicit transaction that gets logged but carries no rows. So naive INSERT-counting under-counts binlog events by 3&ndash;4&times;. Postgres is different again: <code>pgoutput</code> delivers one countable change per row and surfaces transaction boundaries as separate <code>Begin</code>/<code>Commit</code> messages the consumer doesn't count as changes — so a PG operator can size by INSERT count directly, no multiplier.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The rule of thumb, documented for the flag: on a MySQL source, budget at least <strong>4&times;</strong> your expected INSERT count for <code>--rollover-max-changes</code> (the 3-event per-row shape plus headroom for the empty pair and other bookkeeping — heartbeats, rotate, format-description). Predictable bulk multi-row shapes can go tighter (the <code>2 + N</code> collapse). On Postgres, no multiplier.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>"Number of changes" is an engine-specific unit. MySQL's binlog is a log of <em>events</em> — row images plus the BEGIN/XID framing around every transaction, plus a per-connection empty pair — so it runs 3&ndash;4&times; ahead of the row count you're thinking of; Postgres's logical stream is closer to one-per-row. When you bound anything against a replication log (a rollover, a batch, an alert threshold), bound it against the log's own unit, and remember the same "count the changes" knob does not mean the same thing across engines.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL binlog event types — <a href="https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_replication.html">the replication event stream</a> (<code>QUERY_EVENT</code>, <code>WRITE_ROWS_EVENT</code>, <code>XID_EVENT</code>).</li>
  <li>Postgres <code>pgoutput</code> per-row messages — <a href="https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html">logical replication message formats</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: binlog temporal values are strings --------------------
write(
  "field-notes/binlog-temporal-strings",
  page({
    slug: "field-notes/binlog-temporal-strings",
    title: "parseTime governs the query protocol, not the binlog",
    subtitle: "parseTime=true on the DSN makes the query driver return time.Time. But the replication stream is a different code path, and it hands temporal columns back as raw strings regardless. The first TIMESTAMP row killed the CDC pump — and the silent channel-close looked exactly like a network stall for two release cycles.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL &rarr; target CDC on any table with a <code>TIMESTAMP</code> / <code>DATETIME</code> / <code>DATE</code> column. Internally Bug 12.</p>

<h2 id="what-happened">What happened</h2>
<p>A MySQL CDC stream against any table with a temporal column silently applied <strong>zero</strong> events — the channel just went quiet, exactly like a stalled network connection. The mis-diagnosis chased port-forwarding and connectivity for two release cycles before the real cause surfaced: the very first temporal row event was killing the pump.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The DSN carried <code>parseTime=true</code>, which tells <code>go-sql-driver/mysql</code> to return <code>time.Time</code> for temporal columns — but that setting governs the <strong>query</strong> protocol (the result path of a normal <code>SELECT</code>). The binlog <strong>replication</strong> stream is a separate code path, and it hands temporal values back as their raw <em>string</em> form (<code>"2026-05-05 20:38:23"</code>) no matter what the DSN says. The row decoder accepted only a <code>time.Time</code>, so the first temporal row event raised <code>cannot decode string as time.Time (parseTime=true should be set)</code>. And the way that error surfaced is what turned a loud bug into a silent one: the pump reported it via a deferred <code>setErr</code> (visible only through a later <code>Err()</code> call, never logged at the point of failure), then closed the events channel. Downstream, the applier just saw the channel close with zero events — a fatal decode error wearing the costume of an idle stream.</p>

<h2 id="repro">The repro</h2>
<pre><code>${esc(`-- source: any table with a temporal column, CDC tailing it
CREATE TABLE t (id INT PRIMARY KEY, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
INSERT INTO t (id) VALUES (1);
-- pre-fix: the binlog row event carries ts as the string "2026-05-05 20:38:23";
--   the decoder rejects it, the pump setErr()s and closes the channel,
--   the applier sees 0 events. Looks identical to a dead connection.`)}</code></pre>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>The binlog decoder now parses MySQL's canonical temporal string forms — second-precision, microsecond-precision, and date-only — plus their byte-slice equivalents and the <code>0000-00-00</code> zero-value sentinel, rather than assuming a pre-parsed <code>time.Time</code>. (Pinned end-to-end against a real <code>mysql:8.0</code>: pre-fix dropped 100% of CDC events on a temporal table, post-fix all flow.)</p>

<h2 id="lesson">The transferable lesson</h2>
<p>A driver flag like <code>parseTime</code> tunes the <em>query</em> protocol, not the <em>replication</em> stream — they are different paths through the same driver, and the binlog hands you raw strings whatever the DSN claims. When a setting clearly "works" for your queries but CDC breaks on the exact type it should govern, suspect that the replication path never saw the flag. The companion lesson is about failure visibility: a fatal error routed only through a deferred <code>Err()</code> — not logged where it happens — is indistinguishable from a healthy-but-idle stream, and that ambiguity is what cost the two release cycles. Surface pump-fatal errors <em>loudly, at the point of failure</em>. (The binlog is not the query protocol in more ways than one — it also <a href="/field-notes/binlog-transaction-compression/">compresses whole transactions into a single event</a> a query-path reader never sees.)</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>go-sql-driver <code>parseTime</code> (a connection/query-path option) — <a href="https://github.com/go-sql-driver/mysql#parsetime">go-sql-driver/mysql parameters</a>.</li>
  <li>MySQL binlog row images carry temporal values in their own encoding — <a href="https://dev.mysql.com/doc/dev/mysql-server/latest/classbinary__log_1_1Rows__event.html"><code>Rows_event</code></a>.</li>
  <li>How sluice reads MySQL CDC — <a href="/docs/how-sluice-copies/">How sluice copies your data</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: BIT crosses the wire as bytes -------------------------
write(
  "field-notes/mysql-bit-wire-bytes",
  page({
    slug: "field-notes/mysql-bit-wire-bytes",
    title: "BIT crosses the wire as bytes, and the engines disagree on layout",
    subtitle: "MySQL hands BIT(N) back as ceil(N/8) right-justified big-endian bytes; Postgres surfaces bit as a '0'/'1' text string. Carry the raw bytes between them through one []byte path and you silently store the ASCII of the digits, not the bits.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — migrating a <code>BIT</code> column between MySQL and Postgres. Internally catalog Bug 75.</p>

<h2 id="what-happened">What happened</h2>
<p>Carrying a <code>BIT(N)</code> value between engines through a single <code>[]byte</code> IR path silently corrupted every value — it stored the ASCII bytes of the <code>'0'</code>/<code>'1'</code> digits and the writer then kept only the last one. A bit field that looked like a trivial "just move the bytes" column was the one that lost its data.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The two engines put <code>BIT</code> on the wire in completely different shapes, and a raw-bytes IR is ambiguous between them:</p>
<ul>
  <li><strong>MySQL</strong> hands <code>BIT(N)</code> back as <code>ceil(N/8)</code> big-endian bytes, right-justified — the value's bits <em>packed</em> into the minimum number of bytes. <code>BIT(14) = b'10110100110010'</code> is two packed bytes.</li>
  <li><strong>Postgres</strong>'s <code>bit</code> / <code>bit varying</code> text I/O surfaces the value as a <code>'0'</code>/<code>'1'</code> <em>text string</em> already — the same form as the literal <code>B'1010'</code>.</li>
</ul>
<p>So "the bytes" means packed bits on one side and ASCII digit characters on the other. A pipeline that grabbed the driver's bytes and re-decoded them as if they were packed bits took Postgres's <code>"10110100110010"</code> (fourteen ASCII characters) and interpreted it as raw bit-bytes — storing garbage, then truncating to the last byte. Same code path, opposite meaning, silent loss.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Carry a single <strong>canonical form</strong>: a <code>'0'</code>/<code>'1'</code> text bit-string, most-significant bit first, exactly the column's declared bit-length (the same form Postgres's text I/O and <code>B'…'</code> literals use). It's engine-neutral and exact for any width. MySQL's packed bytes convert in via <code>BitBytesToString</code> (unpack <code>ceil(N/8)</code> right-justified big-endian bytes into the N-character string); the MySQL writer binds the <code>uint64</code> form, not the raw bytes, so the write side doesn't re-introduce the ambiguity either. The canonical string is the one representation that can't be misread between the packed and expanded layouts.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>"It's a bit field, just move the bytes" hides that two databases disagree on what "the bytes" <em>are</em>: MySQL packs the bits into <code>ceil(N/8)</code> big-endian bytes, Postgres's text protocol hands you the ASCII <code>'0'</code>/<code>'1'</code> expansion. A raw-<code>[]byte</code> intermediate is ambiguous between the packed and expanded forms, and the ambiguity resolves as silent corruption. When two engines encode the same logical value differently on the wire, don't pass the wire bytes through — pick a canonical representation that is unambiguous at every width and convert at each engine boundary.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL <code>BIT</code> storage &amp; retrieval — <a href="https://dev.mysql.com/doc/refman/8.0/en/bit-type.html">The <code>BIT</code> Type</a> and <a href="https://dev.mysql.com/doc/refman/8.0/en/bit-value-literals.html">bit-value literals</a>.</li>
  <li>Postgres <code>bit</code> text I/O — <a href="https://www.postgresql.org/docs/current/datatype-bit.html">bit-string types</a>.</li>
  <li>sluice's cross-engine value contract — <a href="/docs/type-mapping/">Type mapping</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: BIGINT UNSIGNED overflows int64 -----------------------
write(
  "field-notes/bigint-unsigned-uint64",
  page({
    slug: "field-notes/bigint-unsigned-uint64",
    title: "BIGINT UNSIGNED overflows both bigint and int64",
    subtitle: "A MySQL BIGINT UNSIGNED reaches 2⁶⁴−1, past Postgres bigint's 2⁶³−1 — and past Go's int64, so above that boundary the driver hands the value back as a uint64 a []byte/string-only decoder can't route. The type mismatch is known; the driver-representation switch is the sharp edge.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — migrating a MySQL <code>BIGINT UNSIGNED</code> column holding values above 2<sup>63</sup>&minus;1 to Postgres. A value-fidelity finding from the test rig.</p>

<h2 id="what-happened">What happened</h2>
<p>A MySQL <code>BIGINT UNSIGNED</code> column carrying values above <code>2^63-1</code> had <strong>no working migration path</strong> to Postgres — and, worse, the loud error's <em>recommended recovery</em> didn't function either. This never silently lost data (it failed loudly), but it blocked a common migration and then lied about how to unblock it.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>Three boundaries stack up at the same value:</p>
<ul>
  <li><strong>The target type.</strong> <code>BIGINT UNSIGNED</code> reaches <code>2^64-1</code> (18,446,744,073,709,551,615); Postgres <code>bigint</code> tops out at <code>2^63-1</code>. So above the signed max it can't be a <code>bigint</code> at all — it needs <code>numeric</code> or <code>text</code>.</li>
  <li><strong>The driver representation (the sharp edge).</strong> Above <code>int64</code>'s max, <code>go-sql-driver/mysql</code> stops returning a <code>[]byte</code>/<code>string</code> and returns a <strong><code>uint64</code></strong>. The value decoder's <code>decodeDecimal</code>/<code>decodeString</code> only handled <code>[]byte</code>/<code>string</code>, so even the explicit escape hatch <code>--type-override COL=decimal|text</code> failed with <code>cannot decode uint64 as {Decimal|string}</code>.</li>
  <li><strong>The broken remediation.</strong> The unsigned-bigint notice told operators to use <code>--type-override TABLE.COL=numeric</code> — but <code>numeric</code> wasn't a recognized override token (only <code>decimal</code> is), and bare <code>decimal</code> defaulted to <code>numeric(10,0)</code>, far too few digits for a 20-digit value. The documented fix pointed at a flag that didn't parse and a type too small to hold the number.</li>
</ul>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Add <code>uint64</code>/<code>int64</code> cases to the decimal and string decoders that carry the exact decimal text via <code>strconv.FormatUint</code>/<code>FormatInt</code>, so a <code>BIGINT UNSIGNED</code> migrates as an exact Postgres <code>numeric</code> or <code>text</code> value — no precision lost. And correct the remediation hint at every site it's surfaced (the notice, the schema-preview output, the doc comments) to the token that actually parses, with enough digits for the value.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>An unsigned 64-bit integer is a <em>triple</em> boundary: it overflows the target's signed <code>bigint</code>, it overflows the language's <code>int64</code>, and at that second overflow the driver quietly changes the Go type it hands you (<code>uint64</code>, not the <code>[]byte</code>/<code>string</code> your decoder was built for). A migration that maps the type but never sees the over-<code>int64max</code> representation fails on exactly the values that justified making the column unsigned. And the meta-lesson: <strong>a loud-failure remedy is code too.</strong> If the error names a flag token that doesn't exist or a type too narrow for the value, "we refuse loudly and tell you the fix" degrades into "we refuse loudly and mislead you" — so test your remediation strings through the real parser, the same way you'd test a feature. (This is one of a family of <a href="/field-notes/int64-json-boundary/">integer-boundary</a> hazards where the number outgrows the pipe carrying it.)</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL integer ranges — <a href="https://dev.mysql.com/doc/refman/8.0/en/integer-types.html">integer types</a> (<code>BIGINT UNSIGNED</code> = 0 … 2⁶⁴&minus;1).</li>
  <li>Postgres numeric ranges — <a href="https://www.postgresql.org/docs/current/datatype-numeric.html"><code>bigint</code> vs <code>numeric</code></a>.</li>
  <li>go-sql-driver returns <code>uint64</code> above <code>int64</code> max — <a href="https://github.com/go-sql-driver/mysql">go-sql-driver/mysql</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: snapshot/position boundary gap ------------------------
write(
  "field-notes/snapshot-position-gap",
  page({
    slug: "field-notes/snapshot-position-gap",
    title: "The transaction that lands in neither the snapshot nor the binlog",
    subtitle: "Capture the consistent snapshot and the binlog position as two separate statements, and a transaction committing between them falls into the gap: after the frozen read view, below the recorded offset. It's in neither the bulk copy nor the CDC tail. A global read lock across both closes the seam.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — MySQL cold-start: freezing a consistent snapshot for the bulk copy and recording the binlog position for the CDC handoff. Internally the FTWRL-freeze fix; caught by a concurrent-writes-during-cold-start test (2299/2300 rows under <code>-race</code>).</p>

<h2 id="what-happened">What happened</h2>
<p>A MySQL cold-start — bulk-copy a consistent snapshot, then hand off to CDC from a recorded binlog position — intermittently lost a single row under concurrent writes. The row was in neither the snapshot copy nor the CDC tail, with no error. (It was first mis-diagnosed as a slow-apply flake and "fixed" by raising a catch-up ceiling; the row never arrived at any ceiling, because it was never in the stream at all.)</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The snapshot view and the start position were captured as <strong>two separate statements</strong>:</p>
<pre><code>${esc(`START TRANSACTION WITH CONSISTENT SNAPSHOT;   -- freezes the read view (bulk copy)
--   << any transaction committing HERE falls into the gap >>
SHOW BINARY LOG STATUS;                        -- records the CDC start offset`)}</code></pre>
<p>A transaction that commits in the window <em>between</em> those two statements lands in neither phase: it committed <strong>after</strong> the read view froze, so the snapshot bulk-copy doesn't see it; and its binlog offset is <strong>below</strong> the position recorded a moment later, so CDC starts after it and skips it. The row exists on the source and in the binlog, but above the snapshot's cut and below the stream's cut — a silent-loss boundary exactly one transaction wide.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>Wrap the capture in <code>FLUSH TABLES WITH READ LOCK ... UNLOCK TABLES</code> — the mydumper/Debezium consistent-snapshot pattern — so the snapshot's read view and the recorded binlog position name the <em>exact same</em> logical cut, with no commit able to interleave between them. The open transaction keeps the snapshot alive after the lock is released, and writes that resume afterward are captured by CDC from the frozen position. <code>FLUSH TABLES WITH READ LOCK</code> needs the <code>RELOAD</code> privilege; without it, sluice warns and falls back to the prior lock-free capture rather than failing the run (a least-privilege single-DB user who never hits the window keeps working).</p>

<h2 id="lesson">The transferable lesson</h2>
<p>When a cold-start hands off from a bulk snapshot to a change stream, the snapshot's consistency point and the stream's start position must be the <em>same instant</em> — capture them as two statements and the window between them is a silent-loss gap for any transaction that commits there (above the snapshot, below the position). The remedy is to make the two reads name one logical cut, classically by holding a global read lock across both so nothing can commit in between. This is the canonical consistent-snapshot dance — mydumper and Debezium do exactly this — and it's canonical precisely because everyone who builds snapshot-to-CDC handoff rediscovers the same one-transaction-wide hole, usually as a single mysteriously-missing row that looks like anything but a boundary bug.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>MySQL consistent snapshots &amp; <code>FLUSH TABLES WITH READ LOCK</code> — <a href="https://dev.mysql.com/doc/refman/8.0/en/flush.html"><code>FLUSH</code></a> and <a href="https://dev.mysql.com/doc/refman/8.0/en/innodb-consistent-read.html">InnoDB consistent reads</a>.</li>
  <li>The pattern in the wild — <a href="https://debezium.io/documentation/reference/stable/connectors/mysql.html">Debezium MySQL connector snapshot</a> / mydumper's <code>--trx-consistency-only</code>.</li>
  <li>How sluice cold-starts and hands off to CDC — <a href="/docs/zero-downtime-cutover/">Zero-downtime migration</a>.</li>
</ul>
`,
  })
);

// ---- Field Notes: a CDC position can lead or trail its rows --------------
write(
  "field-notes/cdc-position-leads-or-trails",
  page({
    slug: "field-notes/cdc-position-leads-or-trails",
    title: "A CDC position isn't a universal coordinate",
    subtitle: "A change-stream gives you a position token to resume from and to reason about order — but engines disagree, non-obviously, on whether that token sits before or after the rows it names. Postgres and MySQL put a schema/DDL position ahead of the rows it introduces; Vitess stamps its commit token after them. Any “did we reach the boundary?” check written against one engine silently false-negatives on the other.",
    body: `
<p class="fn-meta"><strong>Observed</strong> — hardening logical-backup restore against a manifest-tamper silent-loss. The completeness guard asked “was this incremental's data fully applied?” by testing whether a schema-history snapshot was anchored exactly at the window's end position — sound on Postgres and MySQL-binlog, a false negative on Vitess/PlanetScale.</p>

<h2 id="what-happened">What happened</h2>
<p>A backup incremental records an <code>end_position</code> — the change-stream coordinate its replay must reach — and a list of change chunks carrying the row events. To catch a store-level adversary who deletes the chunks (an unsigned backup), restore asserts the replay actually <em>reaches</em> <code>end_position</code>: either the last replayed change lands exactly there, <em>or</em> a schema-history snapshot is anchored exactly there. That second clause exists for a legitimate DDL-only window (a schema change, no row writes) — such a window advances <code>end_position</code> to the schema snapshot's own position, so a snapshot sitting at the boundary means “nothing was dropped, this window was always schema-only.”</p>
<p>On Postgres and MySQL that reasoning holds. On Vitess it is a silent false negative: an <em>emptied</em> data window — chunks deleted, rows lost — whose final transaction happened to first-touch a table leaves that table's routine schema snapshot sitting exactly at <code>end_position</code>, so the guard reads “boundary reached” and waves the data loss through.</p>

<h2 id="why">Why (the mechanism)</h2>
<p>The three engines stamp their positions on <em>different sides</em> of the same rows:</p>
<ul>
  <li><strong>Postgres logical replication</strong> — a <code>RelationMessage</code> (the schema/relation descriptor) carries its own WAL position, and that <code>WALStart</code> strictly precedes the LSNs of the rows it introduces. The schema anchor <em>leads</em> the rows.</li>
  <li><strong>MySQL binlog</strong> — a DDL <code>Query</code> event's log position precedes the row events that follow it. Again the schema/DDL position <em>leads</em> the rows.</li>
  <li><strong>Vitess / PlanetScale VStream</strong> — the resumable coordinate is the <code>VGTID</code>, and VStream emits it <em>per transaction commit, after</em> the rows the commit covers. The token <em>trails</em> its rows. So a table's first-touch schema snapshot and the row changes in the <em>same</em> transaction are handed to you carrying one and the same position.</li>
</ul>
<p>Because Postgres and MySQL put the schema anchor before the rows, a routine data-window snapshot is always anchored <em>below</em> the window's last row — so a snapshot found <em>at</em> the end position can only be a genuine DDL-only window, and the heuristic is exact. On Vitess the snapshot and the rows share a position, so “snapshot at the end position” no longer distinguishes “schema-only window” from “data window whose rows were deleted.” Same code, same manifest shape — a different answer purely because the engine writes the coordinate on the other side of the rows.</p>

<h2 id="what-sluice-does">What sluice does about it</h2>
<p>sluice records the source engine's ordering as a capability, <code>CDCPositionCommitsAfterRows</code> (declared for the VStream flavors), and stamps it on every incremental manifest at backup time. When restore or the live broker sees it set, it refuses to treat a schema anchor at the boundary as proof of applied data — on those engines <em>only</em> an actually-replayed change-chunk tail counts, so an emptied-data window is refused loudly instead of restored short. Postgres and MySQL-binlog, whose anchor strictly precedes its rows, keep trusting the anchor, so a legitimate schema-only window still restores. The trust decision is gated on a declared property of the engine, not hard-coded per engine name.</p>

<h2 id="lesson">The transferable lesson</h2>
<p>A CDC position is <em>not</em> a universal coordinate. Whether the commit/GTID/LSN token an engine hands you sits <em>before</em> or <em>after</em> the rows it's associated with is an engine-specific property of the wire protocol — Postgres and MySQL lead with the schema position, Vitess trails with the commit token — and any “did we reach the boundary?” or event-ordering assumption you write against one engine is silently unsound the moment you point it at another. If a completeness or ordering check compares a position to “where the rows are,” it has to know which side of the rows <em>that</em> engine stamps the position on; anything else passes its tests on the engine you wrote it against and false-negatives on the one you didn't.</p>

<h2 id="sources">Primary sources</h2>
<ul>
  <li>Postgres logical replication protocol — the <a href="https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html">Relation message</a> and its position, ahead of the row messages it describes.</li>
  <li>Vitess VStream / VGTID — the <a href="https://vitess.io/docs/reference/vreplication/vstream/">VStream API</a> delivers a <code>VGTID</code> at each transaction boundary, after the row events it covers.</li>
  <li>How sluice replays a backup chain and its recorded positions — <a href="/docs/from-backup-sync/">Sync from a backup chain</a>.</li>
</ul>
`,
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
const pageURL = (slug) => SITE + pagePath(slug);

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

// Field Notes are their own top-level section (not part of the docs NAV), so
// they're listed here from FIELD_NOTES directly — newest first, with dates.
llms += `\n## Field Notes\n\n`;
{
  const landing = bySlug.get("field-notes");
  llms += `- [Field Notes](${pageURL("field-notes")})${landing && landing.subtitle ? ": " + landing.subtitle : ""}\n`;
  for (const n of FIELD_NOTES_NEWEST) {
    const p = bySlug.get("field-notes/" + n.slug);
    const note = p && p.subtitle ? ": " + p.subtitle : "";
    llms += `- [${n.date} · ${n.label}](${pageURL("field-notes/" + n.slug)})${note}\n`;
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
  const rel = p.slug === "" ? "docs" : isFieldNote(p.slug) ? p.slug : "docs/" + p.slug;
  const dir = join(ROOT, rel);
  mkdirSync(dir, { recursive: true });
  let md = `# ${p.title}\n`;
  if (p.subtitle) md += `\n> ${p.subtitle}\n`;
  md += `\n${textify(p.body)}\n\n---\nCanonical page: ${pageURL(p.slug)} · Full docs index: ${SITE}/llms.txt\n`;
  writeFileSync(join(dir, "index.md"), md);
}
console.log("wrote per-page index.md (" + EMITTED.length + " pages)");

console.log("done.");
