// Harness step: render sluice's alert email template to
// assets/screenshots/notify-email.png.
//
// The sample HTML is produced by sluice's own committed preview generator
// (internal/notify's TestRenderEmailSamples, gated on SLUICE_WRITE_EMAIL_SAMPLES),
// then screenshotted with headless Chrome. So the frame is always the real
// rendered template, never a hand-mocked copy.
//
// Env: SLUICE_REPO (default ../sluice), CHROME (auto-detected on win).
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..");
const SLUICE = process.env.SLUICE_REPO || join(SITE, "..", "sluice");
const SAMPLES = join(HERE, "_email-samples");
const OUT = join(SITE, "assets", "screenshots", "notify-email.png");
const SAMPLE = process.env.EMAIL_SAMPLE || "storage-util"; // storage-util | sync-lag | cpu-util

const CHROME =
  process.env.CHROME ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe",
   "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
   "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
if (!CHROME) { console.error("no Chrome/Edge/Chromium found; set CHROME"); process.exit(1); }

// 1. Generate the sample HTML from the sluice test (real template render).
mkdirSync(SAMPLES, { recursive: true });
const g = spawnSync("go", ["test", "-run", "TestRenderEmailSamples", "./internal/notify/..."],
  { cwd: SLUICE, env: { ...process.env, SLUICE_WRITE_EMAIL_SAMPLES: SAMPLES }, stdio: "inherit" });
if (g.status !== 0) { console.error("go test (email sample) failed"); process.exit(1); }

// The test resolves a relative SLUICE_WRITE_EMAIL_SAMPLES from internal/notify/../..,
// i.e. the repo root; SAMPLES is absolute so it lands there directly.
const htmlPath = join(SAMPLES, SAMPLE + ".html");
if (!existsSync(htmlPath)) { console.error("sample not found: " + htmlPath); process.exit(1); }

// 2. Screenshot it.
const r = spawnSync(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=2", "--window-size=760,650",
  "--screenshot=" + OUT, "file:///" + htmlPath.replace(/\\/g, "/"),
], { stdio: "ignore" });
console.log(`email render (${SAMPLE}): chrome exit ${r.status} -> ${OUT}`);
