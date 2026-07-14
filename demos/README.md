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
| `tapes/*.tape` | [VHS](https://github.com/charmbracelet/vhs) scripts for the terminal surfaces (credential-free — DSNs come from named vars). |
| `capture.sh` | Runs a tape (or `all`) through VHS on the rig network and copies the chosen frames into `assets/screenshots/`. |
| `env.example.sh` | Committed template for the per-tape DSN variables. Copy to `demo/env.sh` (gitignored) and fill in real values. |
| `fleet.example.yaml` | Committed template for the tui/dashboard fleet config. Copy to `demo/fleet.yaml` (gitignored). |
| `scenarios/README.md` | Per-tape rig prerequisites (which DBs/tables/slots/backup-chain each surface needs). |

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

## Capture harness

`capture.sh` runs a tape through VHS against the local rig and copies the chosen
frames into `../assets/screenshots/`. The credential model: **no DSN literal is
ever committed.** Each tape references named variables (`$MYSQL_SHOP`, `$PG_MIGDB`,
…) and `source /demo/env.sh` inside the recording shell; the real DSNs live only
in the gitignored `demo/` dir.

One-time rig staging:

```
cp env.example.sh     demo/env.sh        # then edit in your real DSNs
cp fleet.example.yaml demo/fleet.yaml    # only for the tui/fleet tape
# stage the released Linux binary at demo/sluice (from sluice_*_Linux_x86_64.tar.gz)
```

`demo/` (binary, `env.sh`, `fleet.yaml`, `bkup/` chains) is `.gitignore`d, so real
credentials never reach the public repo — only `env.example.sh` /
`fleet.example.yaml` (placeholders) are committed.

Then capture:

```
./capture.sh shot-migrate      # one surface
./capture.sh all               # every tape
node build-page.mjs            # rebuild the page from the refreshed frames
```

`capture.sh` resets the ephemeral `restoredb` before the restore tape; every other
tape assumes its rig fixtures already exist — see `scenarios/README.md` for the
per-tape DB/data prerequisites. The tape→committed-frame mapping lives in the
`copy_frames` case block in `capture.sh`. `shot-metrics` additionally pulls the
PlanetScale metrics token from a machine-local env file and passes it to the
container via `docker run -e` (never written into the tape).

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
