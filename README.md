# Scalpview

A free multi-exchange crypto screener for scalpers, in one HTML file. No server, no account, no API keys.
It reads public market data from Binance, Bybit and OKX straight from your browser.

**Use it:** download [`dist/scalpview.html`](dist/scalpview.html) and open it in Chrome.

## What it does
- One coin list across Binance, Bybit and OKX (futures and spot). A coin on several exchanges shows once, from the exchange you rank highest.
- Chart board from 1×1 to 7×7, pages, colour groups 1-5, board freezes for 3 s while the mouse is over it.
- Timeframes 1s / 5s / 15s (from live trades) and 1m to 1W. When one exchange runs out of history, older candles load from another, with a marker.
- Indicators for sorting, the list and chart headers: change, range, NATR, BTC correlation, trades, volume, trade and volume spikes.
- Focus mode: one coin on 1, 2 or 4 timeframes with a synced crosshair.
- Density map: large resting orders across all coins, Large / Medium / Small, plus density lines on charts with size and age.
- Price alerts (Shift+A), impulse alerts, new listings, funding clock, warning badge for odd funding or price gaps between exchanges. Optional Telegram delivery with your own bot.
- Drawings: trend line, line, ray, rectangle, fib, pencil, ruler (middle drag or Shift+drag), magnet (Ctrl).
- Search on any key (any keyboard layout, one typo allowed), Ctrl+V to search the clipboard.
- Right or middle click opens the coin in your terminal (Vataga, MetaScalp, Tiger or a custom URL; set in Settings).

All settings, groups, drawings and alerts stay in your browser (localStorage).

## Hotkeys
Any letter: search · Esc: back · Space / ↓: next page · Shift+Space / ↑: previous page · Shift+R: resort ·
1-5 over a chart: colour group · Shift+A: price alert · Shift+S: trend line · Shift+D: horizontal ray.

## Develop
- `python3 build.py` inlines `vendor/` and `src/*.js|css` into `dist/scalpview.html`.
- `test/smoke.py` opens the page in headless Chromium with live data (needs `pip install playwright`).
- Module layout and the internal API are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Notes
- Rate limits are per IP. The page keeps Binance futures under about 1600 weight per minute and backs off on HTTP 429.
- Binance futures market websockets live under `wss://fstream.binance.com/market/...`. The old `/ws` and `/stream` paths connect but send nothing.
- If an exchange is blocked in your country, its coins will be missing. Turn it off in Settings → Exchanges.

Not financial advice. Inspired by ScalpBoard; not affiliated with it.
