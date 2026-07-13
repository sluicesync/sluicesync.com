# Screenshots capture harness

Generates the frames for the top-level **[/screenshots/](../screenshots/)** gallery,
and the page itself, from a single source of truth. Every frame is a real run of the
**released** `sluice` binary — never a hand-mocked copy.

## Pieces

| File | Role |
|---|---|
| `manifest.json` | **Source of truth.** Every surface: `id`, `command`, `kind` (`triptych` / `duo` / `single` / `htmlframe` / `demo`), `tagline`, `frames[]` (`file`, `step`, `caption`), and its `tape` or `render` script. `"pending": true` hides a surface until its frames exist. |
| `build-page.mjs` | Renders `../screenshots/index.html` from the manifest. Skips any surface whose frames aren't on disk. **Never hand-edit the page** — edit the manifest and rerun. |
| `render/dashboard.mjs` | Renders the fleet HTML dashboard (`sluice`'s `internal/pipeline/dashboard.html`) to a PNG headless — injects a mock `/api/fleet` payload, screenshots with Chrome/Edge. |
| `render/email.mjs` | Renders the threshold-alert email template — runs `sluice`'s own `TestRenderEmailSamples` (`internal/notify`) to get the real HTML, then screenshots it. |
| `tapes/*.tape` | [VHS](https://github.com/charmbracelet/vhs) scripts for the terminal surfaces. |
| `scenarios/*.sh` | Rig setup for each tape (seed the demo DBs/tables). |

`assets/screenshots/` holds the produced frames (committed). The `../assets/screenshots.css`
stylesheet + the lightbox are in the generated page.

## Regenerating

**One HTML surface** (no rig needed):
```
node demos/render/dashboard.mjs      # or render/email.mjs
node demos/build-page.mjs
```

**A terminal surface** — stage the released Linux binary at `demos/demo/sluice`
(from the release's `*_Linux_x86_64.tar.gz`), bring up the local rig
(`sluice-localrig-{mysql,pg}-{src,dst}`), run its scenario + tape via VHS on the
rig network, pick the best frame(s) into `assets/screenshots/`, then
`node demos/build-page.mjs`. See a tape's header for the VHS invocation.

## Keeping it current

After a release that changes a user-facing view, run the **`screenshots-refresher`**
agent (machine-local, in `.claude/agents/`): it scopes which surfaces changed,
regenerates them, **QA's each frame visually**, updates the manifest + rebuilds the
page, and commits. It's read-only against the `sluice` repo. An empty sweep (no
user-facing view changed) is a valid result.

## Discipline

- **Released binary only** — the page claims real runs of the shipped binary.
- **QA every frame by eye** — no leaked pre-panel INFO lines, no tofu glyphs, no
  clipped boxes, no tables overflowing the terminal width.
- The local rig containers are shared — never reset them; only create/drop the
  specific demo DBs/tables a scenario needs.
