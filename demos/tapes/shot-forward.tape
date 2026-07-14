# More-demos strip — the reassuring counterpart to "Schema drift, refused":
# a column added to the SOURCE mid-sync is FORWARDED to the target automatically.
# The sync stays online — no drain, no manual ALTER, no recovery. This shows the
# real forward line from a live MySQL->Postgres sync's log (produced by
# demos/scenarios/forward.sh; see scenarios/README.md).
Output shot-forward.gif
Output shot-forward.mp4
Output shot-forward.webm

Set Shell bash
Set FontSize 19
Set Width 1380
Set Height 560
Set Theme "Catppuccin Mocha"
Set TypingSpeed 42ms
Set Padding 26

Hide
Type "export PATH=/demo:$PATH"
Enter
Type "clear"
Enter
Show

Sleep 700ms
Type "# A sync is live, MySQL -> Postgres. Mid-stream, a column is added to the source:"
Enter
Sleep 900ms
Type "#     ALTER TABLE fwd_orders ADD COLUMN loyalty_tier VARCHAR(16)"
Enter
Sleep 1400ms
Type "# sluice forwards it automatically. From the running sync's log:"
Enter
Sleep 700ms
Type "grep -E 'entering CDC mode|column=loyalty_tier|forward-add-column' /demo/fwd-forward.log"
Sleep 300ms
Enter
Sleep 1600ms
Screenshot shot-forward-s1.png
Sleep 1400ms
Type "# The new column and its rows are on the target now; the sync never stopped."
Enter
Sleep 1200ms
Screenshot shot-forward-s2.png
Sleep 800ms
