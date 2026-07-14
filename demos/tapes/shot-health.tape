# screenshots page — sync health: per-stream freshness + source-side lag probe
Output shot-health.gif

Set Shell bash
Set FontSize 20
Set Width 1360
Set Height 640
Set Theme "Catppuccin Mocha"
Set TypingSpeed 42ms
Set Padding 24

Hide
Type "export PATH=/demo:$PATH"
Enter
Type "chmod +x /demo/sluice"
Enter
# DSNs come from /demo/env.sh (gitignored); see demos/README.md
Type "source /demo/env.sh"
Enter
Type 'export ANALYTICS="$PG_FLEET_ANALYTICS"'
Enter
Type 'export USERSRC="$PG_FLEET_USERS"'
Enter
Type 'export WAREHOUSE="$PG_FLEET_WAREHOUSE"'
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "# Health probe: users-to-analytics (Postgres -> Postgres), with source-side lag."
Enter
Sleep 800ms
Type "sluice sync health --stream-id users-to-analytics --target-driver postgres --target $ANALYTICS \"
Enter
Type "  --source-driver postgres --source $USERSRC --max-stale-seconds 120 --max-lag-bytes 1048576"
Sleep 300ms
Enter
Sleep 2500ms
Screenshot shot-health-s1.png
Sleep 1500ms
Type "# Health probe: orders-to-warehouse (MySQL -> Postgres)."
Enter
Sleep 700ms
Type "sluice sync health --stream-id orders-to-warehouse --target-driver postgres --target $WAREHOUSE --max-stale-seconds 120"
Sleep 300ms
Enter
Sleep 2500ms
Screenshot shot-health-s2.png
Sleep 1200ms
