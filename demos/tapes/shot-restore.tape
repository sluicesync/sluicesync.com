# screenshots page — restore triptych: phases -> applying -> summary panel
Output shot-restore.gif

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
# ENC_PASS is exported by env.sh and read via --encryption-passphrase-env, so the
# passphrase never appears on the visible command line or in shell history.
Type "source /demo/env.sh"
Enter
Type 'export SLUICE_TARGET="$PG_RESTOREDB"'
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "sluice restore --from-dir /demo/bkup --encrypt --encryption-passphrase-env ENC_PASS --target-driver postgres"
Sleep 300ms
Enter
Sleep 600ms
Screenshot shot-restore-s1.png
Sleep 1400ms
Screenshot shot-restore-s2.png
Sleep 2s
Screenshot shot-restore-s3.png
Sleep 2500ms
Screenshot shot-restore-s4.png
Sleep 3s
Screenshot shot-restore-s5.png
Sleep 2500ms
Screenshot shot-restore-s6.png
Sleep 800ms
