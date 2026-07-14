# screenshots — slot list: wider terminal so the 6-column table fits cleanly
Output shot-slot-wide.gif

Set Shell bash
Set FontSize 20
Set Width 1680
Set Height 560
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set Padding 24

Hide
Type "export PATH=/demo:$PATH"
Enter
Type "chmod +x /demo/sluice"
Enter
# DSNs come from /demo/env.sh (gitignored); see demos/README.md
# Credentials come from the env (SLUICE_SOURCE), not the visible command line —
# so the screenshot never shows a password. slot list reads --source from it.
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
Sleep 2500ms
Screenshot shot-slot-wide.png
Sleep 600ms
