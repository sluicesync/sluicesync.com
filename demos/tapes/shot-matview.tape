# screenshots page — matview refresh triptych: refresh phase -> summary panel
Output shot-matview.gif

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
Type 'export SLUICE_TARGET="$PG_MIGDB"'
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "sluice matview refresh --target-driver postgres"
Sleep 300ms
Enter
Sleep 600ms
Screenshot shot-matview-s1.png
Sleep 1000ms
Screenshot shot-matview-s2.png
Sleep 1400ms
Screenshot shot-matview-s3.png
Sleep 1800ms
Screenshot shot-matview-s4.png
Sleep 800ms
