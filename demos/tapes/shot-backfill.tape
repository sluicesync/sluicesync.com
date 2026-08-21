# screenshots page — backfill duo: phase checklist mid-Update -> summary panel
Output shot-backfill.gif

Set Shell bash
Set FontSize 22
Set Width 1320
Set Height 700
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set Padding 24

Hide
Type "export PATH=/demo:$PATH"
Enter
Type "chmod +x /demo/sluice"
Enter
# DSNs come from /demo/env.sh (gitignored); see demos/README.md
Type "source /demo/env.sh"
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type 'sluice backfill --driver mysql --dsn "$MYSQL_SHOP" --table catalog_items --set "price_tier = CASE WHEN price_cents < 5500 THEN 1 WHEN price_cents < 11000 THEN 2 ELSE 3 END" --where "price_tier IS NULL" --batch-size 300 --verify --restart'
Sleep 300ms
Enter
Sleep 600ms
Screenshot shot-backfill-s1.png
Sleep 1400ms
Screenshot shot-backfill-s2.png
Sleep 2s
Screenshot shot-backfill-s3.png
Sleep 2500ms
Screenshot shot-backfill-s4.png
Sleep 3s
Screenshot shot-backfill-s5.png
Sleep 2500ms
Screenshot shot-backfill-s6.png
Sleep 800ms
