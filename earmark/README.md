# Earmark

A quiet podcast made of the things you saved for later.

Paste links to Medium articles (or any blog), build a reading list, and Earmark reads them aloud using your browser's built-in text-to-speech. Your list lives in your browser's localStorage, so it's still there when you come back tomorrow.

---


## How it works

- **Reading list** is stored in your browser's localStorage. It survives refreshes and reboots, but doesn't sync between browsers or devices. (If you want sync, that's a future upgrade — needs a database.)
- **Article fetching** goes through `/api/fetch-article` — a serverless function in this repo that runs on Vercel. It calls [Jina Reader](https://jina.ai/reader/) server-side, which extracts clean article text from any URL. This avoids CORS errors in your browser.
- **Reading aloud** uses the browser's built-in `SpeechSynthesis` API — no API keys, no per-character costs. Voice quality depends on your OS: macOS and iOS have the best ones, Chrome on Windows is decent, Linux is hit-or-miss.

---


## Limits to know

- **Jina Reader rate limit**: about 20 requests per minute for anonymous use. Plenty for personal use; the serverless function caches responses for 24 hours, so re-opening articles is free.
- **localStorage cap**: roughly 5–10 MB depending on browser. That's hundreds of articles. If you hit the limit, the app will warn in the console; remove some heard articles to free space.
- **Paywalled articles**: Jina Reader can read public articles only. For Medium articles behind the paywall, you'll need to paste the text manually.

---

Made with ❤️ and a little patience.
