# End-to-end smoke test

Loads the unpacked extension in Chromium and verifies the full flow:
underlines in textarea and contenteditable, tooltip open/navigate/close,
Apply correction + Ctrl+Z undo, popup rendering, and the welcome playground.

```sh
npm i playwright          # once (browsers must already be installed)
cd e2e
python3 -m http.server 8901 &   # serves page.html
CHROMIUM_PATH=/path/to/chromium node run.js
```

Omit CHROMIUM_PATH to use Playwright's default browser resolution.
