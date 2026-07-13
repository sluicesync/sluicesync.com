// Harness step: render the fleet HTML dashboard (sluice's
// internal/pipeline/dashboard.html) to assets/screenshots/dashboard.png.
//
// No server / no real network: we inject a fetch() stub returning a mock
// /api/fleet payload, patch it into the page's <head>, and screenshot the
// file:// with headless Chrome. --virtual-time-budget then lets the (now
// purely in-page) async render settle before the shot.
//
// Env:
//   SLUICE_REPO  path to the sluice checkout (default: ../sluice from here)
//   CHROME       path to a Chrome/Chromium/Edge binary (auto-detected on win)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..");
const SLUICE = process.env.SLUICE_REPO || join(SITE, "..", "sluice");
const DASH = join(SLUICE, "internal", "pipeline", "dashboard.html");
const OUT = join(SITE, "assets", "screenshots", "dashboard.png");
const TMP = join(HERE, "_dashboard-mock.html");

const CHROME =
  process.env.CHROME ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe",
   "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
   "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
if (!CHROME) { console.error("no Chrome/Edge/Chromium found; set CHROME"); process.exit(1); }

// A realistic fleet: mostly healthy, one reconnecting with a real error, so the
// dashboard shows its state colours + sort-by-health ordering.
const fleet = {
  generated_at: "2026-07-13T18:42:11Z",
  syncs: [
    { id: "orders-mysql-to-pg", state: "running", consecutive_failures: 0, restarts: 0, last_error: "", last_start: "2026-07-13T09:12:04Z", since: "2026-07-13T09:12:04Z", seconds_in_state: 34027 },
    { id: "users-pg-to-mysql", state: "running", consecutive_failures: 0, restarts: 1, last_error: "", last_start: "2026-07-13T14:05:51Z", since: "2026-07-13T14:05:51Z", seconds_in_state: 16360 },
    { id: "events-planetscale", state: "running", consecutive_failures: 0, restarts: 0, last_error: "", last_start: "2026-07-13T11:40:12Z", since: "2026-07-13T11:40:12Z", seconds_in_state: 25319 },
    { id: "audit-d1-to-pg", state: "reconnecting", consecutive_failures: 2, restarts: 3, last_error: "d1: query API returned 429 (rate limited); backing off", last_start: "2026-07-13T18:41:02Z", since: "2026-07-13T18:41:58Z", seconds_in_state: 13 },
    { id: "inventory-mysql-to-mysql", state: "running", consecutive_failures: 0, restarts: 0, last_error: "", last_start: "2026-07-12T22:03:30Z", since: "2026-07-12T22:03:30Z", seconds_in_state: 74921 },
  ],
};

const stub = `<script>
window.__FLEET__ = ${JSON.stringify(fleet)};
window.fetch = function(){ return Promise.resolve({ ok:true, status:200, json:function(){ return Promise.resolve(window.__FLEET__); } }); };
</script>`;

let html = readFileSync(DASH, "utf8").replace(/<head[^>]*>/i, (m) => m + "\n" + stub);
writeFileSync(TMP, html);

const r = spawnSync(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=2", "--window-size=1280,600",
  "--virtual-time-budget=3000", "--screenshot=" + OUT, "file:///" + TMP.replace(/\\/g, "/"),
], { stdio: "ignore" });
console.log(`dashboard render: chrome exit ${r.status} -> ${OUT}`);
