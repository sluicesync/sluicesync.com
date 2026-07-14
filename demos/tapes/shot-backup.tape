# screenshots page — backup full triptych: phases -> chunk progress -> summary panel
Output shot-backup.gif

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
Type 'export SLUICE_SOURCE="$PG_MIGDB"'
Enter
Type "rm -rf /demo/bkup && mkdir -p /demo/bkup"
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "sluice backup full --source-driver postgres --output-dir /demo/bkup --encrypt --encryption-passphrase-env ENC_PASS"
Sleep 300ms
Enter
Sleep 600ms
Screenshot shot-backup-s1.png
Sleep 1400ms
Screenshot shot-backup-s2.png
Sleep 2s
Screenshot shot-backup-s3.png
Sleep 2500ms
Screenshot shot-backup-s4.png
Sleep 3s
Screenshot shot-backup-s5.png
Sleep 2500ms
Screenshot shot-backup-s6.png
Sleep 800ms
