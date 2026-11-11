# Opening the outputs full screen

Each output is a browser window pointed at one page. Chromium in kiosk mode works well:

```bash
chromium --kiosk --window-position=0,0 --app=http://localhost:8080/floor
chromium --kiosk --window-position=1920,0 --app=http://localhost:8080/scrim-no2
chromium --kiosk --window-position=3840,0 --app=http://localhost:8080/scrim-pm
chromium --kiosk --window-position=5760,0 --app=http://localhost:8080/scrim-o3
```

Add `?q=0.5` to lower the particle count on a weaker machine and `?labels=0` to hide the labels. Use `--autoplay-policy=no-user-gesture-required` on the window that runs `/sound` so audio starts without a click.
