# More-demos strip — loud-failure story: schema diff catches target drift and
# refuses with a structured diff + copy-paste DDL (the "refuse loudly" discipline).
Output shot-drift.gif
Output shot-drift.mp4
Output shot-drift.webm

Set Shell bash
Set FontSize 20
Set Width 1320
Set Height 680
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
Type 'export SRC="$PG_DRIFT_SRC"'
Enter
Type 'export DST="$PG_DRIFT_DST"'
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "# Someone hand-edited the target. Does it still match the source? Check before syncing."
Enter
Sleep 1000ms
Type "sluice schema diff --source-driver postgres --source $SRC --target-driver postgres --target $DST --include-table accounts"
Sleep 300ms
Enter
Sleep 1800ms
Screenshot shot-drift-s1.png
Sleep 1500ms
Screenshot shot-drift-s2.png
Sleep 1500ms
Type 'echo "exit code: $?  (non-zero: sluice refuses to proceed on drift)"'
Sleep 200ms
Enter
Sleep 1500ms
Screenshot shot-drift-s3.png
Sleep 1200ms
