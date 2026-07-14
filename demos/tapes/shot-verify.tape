# screenshots page — verify triptych: phases -> checking -> summary panel
Output shot-verify.gif

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
Type 'export SLUICE_TARGET="$PG_MIGDB"'
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "sluice verify --source-driver mysql --target-driver postgres --include-table customers"
Sleep 300ms
Enter
Sleep 600ms
Screenshot shot-verify-s1.png
Sleep 1400ms
Screenshot shot-verify-s2.png
Sleep 2s
Screenshot shot-verify-s3.png
Sleep 2500ms
Screenshot shot-verify-s4.png
Sleep 3s
Screenshot shot-verify-s5.png
Sleep 2500ms
Screenshot shot-verify-s6.png
Sleep 800ms
