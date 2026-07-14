# screenshots page — fleet dashboard TUI (sync tui): multi-stream live view
# Fleet DSNs live in /demo/fleet.yaml (gitignored; copy from demos/fleet.example.yaml).
Output shot-tui.gif

Set Shell bash
Set FontSize 20
Set Width 1600
Set Height 600
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set Padding 24

Hide
Type "export PATH=/demo:$PATH"
Enter
Type "chmod +x /demo/sluice"
Enter
Type "nohup sluice sync run --config /demo/fleet.yaml --dashboard-listen 127.0.0.1:9300 --log-level error >/tmp/fleet.log 2>&1 & disown"
Enter
Type "sleep 30"
Enter
Sleep 32s
Type "clear"
Enter
Show

Sleep 600ms
Type "sluice sync tui --connect 127.0.0.1:9300"
Sleep 300ms
Enter
Sleep 3s
Screenshot shot-tui-s1.png
Sleep 2s
Down
Sleep 1200ms
Screenshot shot-tui-s2.png
Enter
Sleep 1500ms
Screenshot shot-tui-s3.png
Sleep 2s
Screenshot shot-tui-s4.png
Type "q"
Sleep 800ms
Hide
Type "pkill -f 'sluice sync run' 2>/dev/null; true"
Enter
