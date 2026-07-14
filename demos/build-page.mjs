// Generates /screenshots/index.html from demos/manifest.json — the single
// source of truth. Run after the capture harness updates frames:
//     node demos/build-page.mjs
// A section marked "pending" is skipped until its frame files exist on disk,
// so partially-captured surfaces never render a broken image.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const m = JSON.parse(readFileSync(join(ROOT, "demos", "manifest.json"), "utf8"));
const A = "/" + m.assetsDir; // web path, e.g. /assets/screenshots
const diskAsset = (f) => join(ROOT, m.assetsDir, f);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A section renders only if every one of its frame files is on disk. This lets
// the manifest declare surfaces before they're captured without breaking the page.
const ready = (s) => s.frames.every((f) => existsSync(diskAsset(f.file)));

const figure = (f) =>
  `<figure class="shot"><div class="frame"><img src="${A}/${f.file}" alt="${esc(f.step)}" loading="lazy"></div>` +
  `<figcaption><span class="step">${esc(f.step)}</span>${esc(f.caption)}</figcaption></figure>`;

const section = (s) => {
  const n = s.frames.length;
  return `  <section class="cmd-shot">
    <div class="head"><h2><code>${esc(s.command)}</code></h2><p>${esc(s.tagline)}</p></div>
    <div class="grid n${n}">${s.frames.map(figure).join("")}</div>
  </section>`;
};

const shown = m.sections.filter(ready);
const skipped = m.sections.filter((s) => !ready(s)).map((s) => s.id);
if (skipped.length) console.log("skipped (no frames yet):", skipped.join(", "));

// Optional "More demos" strip. Each demo prefers <video> (webm+mp4, from the
// same tape as the gif) and falls back to the gif; renders only if the gif is
// present. Title + description are separate block elements so they can't run
// together regardless of stylesheet load order.
const demos = (m.demos || []).filter((d) => existsSync(diskAsset(d.file)));
const demoCard = (d) => {
  const base = d.file.replace(/\.(gif|mp4|webm)$/, "");
  const hasVid = existsSync(diskAsset(base + ".webm")) || existsSync(diskAsset(base + ".mp4"));
  const media = hasVid
    ? `<video autoplay loop muted playsinline poster="${A}/${base}.gif">` +
      (existsSync(diskAsset(base + ".webm")) ? `<source src="${A}/${base}.webm" type="video/webm">` : "") +
      (existsSync(diskAsset(base + ".mp4")) ? `<source src="${A}/${base}.mp4" type="video/mp4">` : "") +
      `<img src="${A}/${base}.gif" alt="${esc(d.title)}"></video>`
    : `<img src="${A}/${base}.gif" alt="${esc(d.title)}" loading="lazy">`;
  return `<figure class="demo-card"><div class="frame">${media}</div>` +
    `<figcaption><span class="demo-title">${esc(d.title)}</span><span class="demo-desc">${esc(d.caption)}</span></figcaption></figure>`;
};
const demosStrip = demos.length
  ? `<section class="demos-strip">
    <h2>More demos</h2>
    <div class="demos-grid">${demos.map(demoCard).join("")}</div>
  </section>`
  : "";

const heroVideo = m.hero.video;
const heroHtml = `<div class="shots-hero">
  <h1>See sluice <span class="g">in action</span></h1>
  <p class="lede">Every command and surface shows a clean, legible view — from a one-shot migration to a live continuous-sync stream, a fleet dashboard, and even the alert emails. Piped or scripted, the output stays the plain structured logs; these views appear only at an interactive terminal or in a browser.</p>
  <div class="demo">
    <video autoplay loop muted playsinline poster="${A}/${m.hero.poster}">
      <source src="${A}/${heroVideo}.webm" type="video/webm">
      <source src="${A}/${heroVideo}.mp4" type="video/mp4">
      <img src="${A}/${heroVideo}.gif" alt="sluice sync start live panel">
    </video>
  </div>
  <p class="demo-cap"><code>${esc(m.hero.command)}</code> — ${esc(m.hero.caption)}</p>
</div>`;

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screenshots — sluice</title>
<meta name="description" content="See sluice in action: every command and surface's live view, from a one-shot migration to continuous sync, the fleet dashboard, and alert emails — real runs of the released binary.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#0d1b22">
<link rel="stylesheet" href="/assets/docs.css">
<link rel="stylesheet" href="/assets/screenshots.css">
</head>
<body>
<header class="top">
  <div class="bar">
    <a class="brand" href="/"><img src="/sluice-logo-dark.png" alt="sluice"></a>
    <nav>
      <a href="/docs/">Docs</a>
      <a href="/field-notes/">Field Notes</a>
      <a class="active" href="/screenshots/">Screenshots</a>
      <a href="https://github.com/sluicesync/sluice">GitHub</a>
    </nav>
  </div>
</header>
${heroHtml}
<main class="shots-main">
<aside class="cred-note"><span class="cred-label">Where are the credentials?</span> The command lines below don't show any — by design. sluice reads connection DSNs from the <code>SLUICE_SOURCE</code> / <code>SLUICE_TARGET</code> environment variables (or a config file passed with <code>--config</code>), and secrets such as an encryption passphrase from <code>--encryption-passphrase-env</code> / <code>--encryption-passphrase-file</code> rather than a literal on the command line. Every command shown is exactly what runs — only the credentials are supplied out-of-band, so they never land in shell history or a screen recording.</aside>
${shown.map(section).join("\n")}
${demosStrip}
</main>
<footer class="shots-foot">Every frame is a real run of the released <code>sluice</code> binary · click any frame to enlarge · piped output, CI, and <code>--log-format=json</code> emit the same structured logs they always have — these views are additive. · <a href="/docs/">Docs</a> · <a href="https://github.com/sluicesync/sluice">github.com/sluicesync/sluice</a></footer>
<div class="lb" id="lightbox" role="dialog" aria-modal="true" aria-label="Enlarged view"><button class="lb-close" id="lbClose" aria-label="Close">&times;</button><img id="lbImg" src="" alt=""><video id="lbVid" controls loop playsinline></video></div>
<script>
(function(){
  var lb=document.getElementById('lightbox'),img=document.getElementById('lbImg'),vid=document.getElementById('lbVid'),c=document.getElementById('lbClose');
  function openImg(src,alt){vid.pause();vid.style.display='none';vid.removeAttribute('src');img.src=src;img.alt=alt||'';img.style.display='';lb.classList.add('open');c.focus();}
  function openVid(v){img.style.display='none';img.src='';while(vid.firstChild){vid.removeChild(vid.firstChild);}
    Array.prototype.forEach.call(v.querySelectorAll('source'),function(sr){var n=document.createElement('source');n.src=sr.src;n.type=sr.type;vid.appendChild(n);});
    var im=v.querySelector('img');vid.setAttribute('aria-label',(im&&im.alt)||'Demo video');vid.style.display='';vid.load();lb.classList.add('open');c.focus();var p=vid.play();if(p&&p.catch){p.catch(function(){});}}
  function close(){lb.classList.remove('open');img.src='';vid.pause();}
  // Screenshots (section frames) enlarge as images; demo/hero videos enlarge as playable video.
  document.querySelectorAll('.shot .frame img').forEach(function(el){el.addEventListener('click',function(){openImg(el.currentSrc||el.src,el.alt);});});
  document.querySelectorAll('.demo-card .frame video, .shots-hero .demo video').forEach(function(el){el.addEventListener('click',function(){openVid(el);});});
  lb.addEventListener('click',function(e){if(e.target!==img&&e.target!==vid){close();}});
  c.addEventListener('click',close);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&lb.classList.contains('open')){close();}});
})();
</script>
</body>
</html>
`;

writeFileSync(join(ROOT, "screenshots", "index.html"), page);
console.log(`wrote screenshots/index.html — ${shown.length} sections rendered`);
