# screenshots — metrics-watch: live PlanetScale target metrics (sampled).
# The metrics token is passed to VHS via `docker run -e` at capture time, never
# hardcoded here (the CLI reads PLANETSCALE_METRICS_TOKEN_ID/_TOKEN from env).
# capture.sh sources those from the machine-local metrics-token file.
Output shot-metrics.gif
Output shot-metrics.mp4
Output shot-metrics.webm

Set Shell bash
Set FontSize 19
Set Width 1440
Set Height 520
Set Theme "Catppuccin Mocha"
Set TypingSpeed 42ms
Set Padding 24

Hide
Type "export PATH=/demo:$PATH"
Enter
Type "chmod +x /demo/sluice"
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "sluice metrics-watch --engine planetscale --planetscale-org sluicesync --planetscale-metrics-db soak-mysql231 --interval 4s"
Sleep 300ms
Enter
Sleep 15s
Screenshot shot-metrics.png
Sleep 500ms
Ctrl+C
Sleep 600ms
