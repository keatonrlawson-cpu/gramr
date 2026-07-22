# Gramr — Learn Grammar as You Type

A Chrome extension that works like a grammar checker but thinks like a tutor.
Instead of silently rewriting your words, Gramr underlines the problem,
explains the rule, gives you a trick to remember it — and then gets out of
your way as you improve.

**All checking happens on your device.** No text is ever sent anywhere, and
your progress is stored locally in your browser.

## Install

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. A welcome page opens with a live playground — click into it and try the underlines

## What it checks

- **Spelling** — a 50,000-word frequency-ranked dictionary flags any word it
  doesn't know and suggests the closest common word (classic edit-distance
  approach), plus a curated list of sounds-right-but-wrong mistakes
- **Grammar** — 40+ rules: its/it's, could of, who/whom, comma splices,
  subject–verb agreement, past participles (*have went*), tense consistency,
  double comparatives, a/an by sound (*an MBA*, *a URL*), and more
- **Style** — wordy phrases, passive voice, redundant acronyms
- **Regional spelling** — pick American, British, Australian, or Canadian
  English; Gramr flags off-dialect spellings (colour/color, organise/organize)

Underlines are pattern-coded for accessibility: errors are **wavy**, warnings
**dashed**, tips **dotted**.

## How it teaches

- **Click an underline** for the what, the why, examples, and a memory trick
- **Apply correction** fixes it in one click (Ctrl+Z still works);
  **Ignore — I meant this** builds your personal dictionary
- **Adaptive tooltips** — a per-rule mastery model tracks your recent error
  rate; the explanations fade as you improve and return if you regress
- **Focus of the week** — your worst recent rule is featured in the popup
  with a short lesson, quoting your own sentence back to you
- **Quick practice** — spaced-repetition quiz questions (1/3/7/21-day
  intervals) for rules you've actually gotten wrong
- **Prove-it mode** (opt-in) — before applying a fix on a rule you're still
  learning, pick the correct form yourself: your text vs. the correction
- **XP, levels & streaks** — corrections, daily writing, quiz answers, and
  mastering rules all earn XP across 10 levels from Novice to Word Master

Everything above is optional — the **Options** panel in the popup lets you
turn off any of it, down to a plain grammar checker.

## Files

| File | Purpose |
|---|---|
| `content.js` | Checking engine, rules, overlays, tooltips, learning model |
| `content.css` | Injected styles for underline tooltips |
| `popup.html/js/css` | Toolbar popup: stats, progress, practice, settings |
| `background.js` | Service worker: stats relay, welcome page on install |
| `dict/words.txt` | 50k-word frequency-ordered dictionary |
| `welcome.html` | Onboarding page with a live playground |
| `test.html` | Developer test page |

## Privacy

- No network requests; the dictionary ships with the extension
- Analysis, history, XP, and examples never leave `chrome.storage` in your browser
- Password fields are never read
- Settings sync via your Chrome profile (`storage.sync`) only
