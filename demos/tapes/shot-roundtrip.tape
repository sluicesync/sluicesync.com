# More-demos strip — encrypted backup -> restore roundtrip in one story.
Output shot-roundtrip.gif
Output shot-roundtrip.mp4
Output shot-roundtrip.webm

Set Shell bash
Set FontSize 19
Set Width 1340
Set Height 720
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Padding 24

Hide
Type "export PATH=/demo:$PATH"
Enter
Type "chmod +x /demo/sluice"
Enter
# DSNs come from /demo/env.sh (gitignored); see demos/README.md
Type "source /demo/env.sh"
Enter
Type 'export SRC="$PG_DEMO_SHOP"'
Enter
Type 'export DST="$PG_DEMO_RESTORED"'
Enter
Type "rm -rf /demo/rtbkup && mkdir -p /demo/rtbkup"
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "# 1. Take an encrypted logical backup of the source."
Enter
Sleep 700ms
Type "sluice backup full --source-driver postgres --source $SRC --output-dir /demo/rtbkup --encrypt --encryption-passphrase-env ENC_PASS"
Sleep 300ms
Enter
Sleep 3500ms
Screenshot shot-roundtrip-s1.png
Sleep 1500ms
Type "# 2. Restore that encrypted backup into a fresh target."
Enter
Sleep 700ms
Type "sluice restore --from-dir /demo/rtbkup --encrypt --encryption-passphrase-env ENC_PASS --target-driver postgres --target $DST"
Sleep 300ms
Enter
Sleep 3500ms
Screenshot shot-roundtrip-s2.png
Sleep 1500ms
Screenshot shot-roundtrip-s3.png
Sleep 1000ms
