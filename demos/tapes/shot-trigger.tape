# screenshots page — trigger setup triptych: install phase -> summary panel
Output shot-trigger.gif

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
# The DSN (with its password) lives in a shell variable, not the visible command
# line — the screenshot shows --dsn "$PG_DSN", exactly what a viewer should type.
Type "source /demo/env.sh"
Enter
Type 'export PG_DSN="$PG_SLOTS"'
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type 'sluice trigger setup --dsn "$PG_DSN" --tables customers'
Sleep 300ms
Enter
Sleep 600ms
Screenshot shot-trigger-s1.png
Sleep 1000ms
Screenshot shot-trigger-s2.png
Sleep 1400ms
Screenshot shot-trigger-s3.png
Sleep 1800ms
Screenshot shot-trigger-s4.png
Sleep 800ms
