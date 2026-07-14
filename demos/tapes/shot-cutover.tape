# screenshots page — cutover triptych: connect/read/prime phases -> summary panel
Output shot-cutover.gif

Set Shell bash
Set FontSize 22
Set Width 1200
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
Type 'export SLUICE_SOURCE="$MYSQL_SHOP"'
Enter
Type 'export SLUICE_TARGET="$PG_CUTDB"'
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "sluice cutover --source-driver mysql --target-driver postgres --include-table orders"
Sleep 300ms
Enter
Sleep 600ms
Screenshot shot-cutover-s1.png
Sleep 1200ms
Screenshot shot-cutover-s2.png
Sleep 1500ms
Screenshot shot-cutover-s3.png
Sleep 2000ms
Screenshot shot-cutover-s4.png
Sleep 2000ms
Screenshot shot-cutover-s5.png
Sleep 800ms
