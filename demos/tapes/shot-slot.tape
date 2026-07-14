# screenshots page — slot list: rounded-border table of logical-replication slots
Output shot-slot.gif

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
# The source DSN lives in SLUICE_SOURCE (from env.sh), not the visible command
# line — so the screenshot never shows a password. slot list reads --source from it.
Type "source /demo/env.sh"
Enter
Type 'export SLUICE_SOURCE="$PG_SLOTS"'
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "sluice slot list --source-driver postgres"
Sleep 300ms
Enter
Sleep 700ms
Screenshot shot-slot-s1.png
Sleep 900ms
Screenshot shot-slot-s2.png
Sleep 1200ms
Screenshot shot-slot-s3.png
Sleep 1500ms
Screenshot shot-slot-s4.png
Sleep 800ms
