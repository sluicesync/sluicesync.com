# More-demos strip — PII redaction: migrate real customer PII to Postgres with a
# per-column redaction rule; the target gets transformed values (mask presets,
# PCI first-6/last-4, SSN, email). Redaction covers the bulk copy AND live CDC.
# The before/after tables are captured from a REAL migrate (scenarios/redact.sh);
# the tape re-runs that same migrate live into the freshly-reset piidemo target.
Output shot-redact.gif
Output shot-redact.mp4
Output shot-redact.webm

Set Shell bash
Set FontSize 16
Set Width 1500
Set Height 820
Set Theme "Catppuccin Mocha"
Set TypingSpeed 34ms
Set Padding 24

Hide
Type "export PATH=/demo:$PATH"
Enter
Type "chmod +x /demo/sluice"
Enter
# DSNs come from /demo/env.sh (gitignored); see demos/README.md
Type "source /demo/env.sh"
Enter
Type 'export SLUICE_SOURCE="$MYSQL_PIIDEMO"'
Enter
Type 'export SLUICE_TARGET="$PG_PIIDEMO"'
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "# A customers table full of PII, in MySQL:"
Enter
Sleep 500ms
Type "cat /demo/redact-before.txt"
Sleep 300ms
Enter
Sleep 1800ms
Screenshot shot-redact-s1.png
Sleep 1200ms
Type "# Migrate to Postgres, redacting each PII column with its own strategy:"
Enter
Sleep 600ms
Type "sluice migrate --source-driver mysql --target-driver postgres --include-table people --redact people.name=mask:inner:1,1 --redact people.email=mask:email --redact people.ssn=mask:ssn --redact people.card=mask:pan --redact people.phone=mask:inner:4,4"
Sleep 300ms
Enter
Sleep 4s
Screenshot shot-redact-s2.png
Sleep 1200ms
Type "# The target: same rows, every PII field transformed (and the same rules run on live CDC changes):"
Enter
Sleep 500ms
Type "cat /demo/redact-after.txt"
Sleep 300ms
Enter
Sleep 1600ms
Screenshot shot-redact-s3.png
Sleep 800ms
