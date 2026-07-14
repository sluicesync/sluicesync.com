# homepage hero + screenshots sync-start — continuous sync (MySQL -> Postgres) live panel.
# Consistent snapshot, then live CDC — position, freshness, rows applied, throughput.
# Drive source writes with a background writer in a side terminal so the CDC body
# climbs on camera (see demos/scenarios/README.md, "hero continuous-sync").
Output featured-sync.gif
Output featured-sync.mp4
Output featured-sync.webm

Set Shell bash
Set FontSize 22
Set Width 1300
Set Height 720
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set Padding 26

Hide
Type "export PATH=/demo:$PATH"
Enter
Type "chmod +x /demo/sluice"
Enter
# DSNs come from /demo/env.sh (gitignored); see demos/README.md
Type "source /demo/env.sh"
Enter
Type 'export SLUICE_SOURCE="$MYSQL_SHOP?tls=skip-verify"'
Enter
Type 'export SLUICE_TARGET="$PG_SHOPDB"'
Enter
Type "clear"
Enter
Show

Sleep 800ms
Type "# Continuous sync, MySQL to Postgres: consistent snapshot, then live CDC."
Enter
Sleep 1000ms
Type "sluice sync start --source-driver mysql --target-driver postgres --include-table live_signups --stream-id shop-cdc"
Sleep 400ms
Enter
Sleep 4s
Screenshot featured-sync-cdc1.png
Sleep 6s
Screenshot featured-sync-cdc2.png
Sleep 5s
Ctrl+C
Sleep 2500ms
Screenshot featured-sync-end.png
Sleep 800ms
