# Scalpview: architecture

Goal: a multi-exchange crypto screener for scalpers (in the style of ScalpBoard),
shipped as ONE self-contained file `dist/scalpview.html` that runs in a desktop browser and talks
directly to the public exchange APIs (no backend).


## Files
- `src/index.html`: page shell (toolbar, board, list, right panels). Contains `/*@CSS@*/` and `/*@JS@*/`
  placeholders.
- `src/styles.css`: all CSS (modules may append their own `src/<module>.css`; build concatenates `src/*.css`
  in name order).
- `src/00-core.js`: SB global, config, event bus, utils. (owner: main)
- `src/10-exchanges.js`: exchange adapters + universe + live 1m feed. (owner: main)
- `src/20-indicators.js`: indicators, filtering, sorting. (owner: main)
- `src/30-board.js`: chart board, coin list, search, focus mode, hotkeys, settings dialog. (owner: main)
- `src/40-density.js`: density (order book wall) scanner, density map panel, density lines on charts. (worker)
- `src/50-alerts.js`: price alerts, impulses, new listings, funding clock, notifications. (worker)
- `src/60-drawings.js`: drawing tools on charts (trend line, horizontal line, ray, rectangle, fib, pencil, ruler). (worker)
- `vendor/lightweight-charts.js`: TradingView Lightweight Charts v4.2.3 standalone (global `LightweightCharts`).
- `build.py`: inlines vendor + `src/*.js` (name order) + css into `dist/scalpview.html`.
- `test/smoke.py`: playwright headless test. Run with `.venv/bin/python test/smoke.py`.

Every module is a plain script (no ES modules, no bundler), wrapped in an IIFE, and only talks to other
modules through `window.SB`. Modules load in file-name order, then `SB.start()` runs on DOMContentLoaded.
Do not edit other owners' files; if you need a hook that does not exist, add it in your own file
defensively and say so in your final report.

## Colors (taken from scalpboard.io CSS)
bg `#0d0d0d`, panel `#141414`/`#1a1a1a`, borders `#242424`/`#333333`, text `#cccccc`, dim `#999999`/`#4d4d4d`,
bright `#f2f2f2`, up `#43c743` (alt `#4bd24b`, `#00c950`), down `#c74343` (alt `#d24b4b`). Font: Noto Sans / system.
CSS variables with these names exist in styles.css: `--bg --panel --panel2 --border --border2 --text --dim --dim2 --bright --up --down --accent`.

## SB API (implemented by core; available before your module's init runs)
```
SB.cfg                      // settings object, persisted in localStorage 'sb.cfg'
SB.saveCfg()                // persist SB.cfg
SB.defaults(ns, obj)        // merge default settings for your namespace: SB.cfg[ns] = {...obj, ...SB.cfg[ns]}
SB.on(evt, fn) / SB.off(evt, fn) / SB.emit(evt, data)
SB.init(fn)                 // register a module init; called after core is ready, before data loads
SB.util: { fmtPrice(p, tick), fmtUsd(v) -> "1.2M", fmtPct(v), sleep(ms), throttle(fn, ms),
           RateLimiter: new SB.util.RateLimiter(perSec) with .run(asyncFn) }

SB.EX                       // ordered list of exchange ids: ['BI-F','BI-S','BY-F','BY-S','OK-F','OK-S']
SB.ex[id]                   // adapter, see below
SB.coins                    // Map key -> Coin  (key = 'BTCUSDT' style, base+'USDT')
SB.list                     // current filtered + sorted array of Coin (what the board/list shows)
SB.coin(key)                // Coin or undefined
```

Coin:
```
{ key:'BTCUSDT', base:'BTC',
  ex:'BI-F',                         // primary source chosen by priority
  src: { 'BI-F': {sym:'BTCUSDT', tick:0.1, vol24, price, funding, nextFunding}, 'BY-F': {...},
         'OK-F': {sym:'BTC-USDT-SWAP', ctVal:0.01, ...}, 'BI-S': {...} },
         // every exchange the coin trades on (among enabled ones). price/vol24/funding of non-primary
         // sources refresh from REST tickers every ~10 s; primary price is live. funding only on futures.
  price, chg24 (pct), vol24 (USDT, primary source), trades24 (Binance only, else null),
  funding (fraction, e.g. 0.0001), nextFunding (ms epoch), tick,
  m1: [ {t, o, h, l, c, v, n} ... ]  // last ~250 1m candles of primary source, t = open time in SECONDS,
                                     // v = quote volume USDT, n = trade count (null if unknown); last one is live
  ind: { [indicatorId]: number }    // computed indicator values
  group: null | 1..5                 // colour group
}
```

Exchange adapter `SB.ex[id]` (all async, all prices/sizes numbers):
```
id, name, market:'futures'|'spot'
klines(sym, tf, limit, endTimeMs?) -> [{t,o,h,l,c,v,n}]   // tf in '1m','5m','15m','1h','4h','1d'; oldest first
depth(sym, limit)  -> { bids:[[price, qtyBase]...], asks:[[price, qtyBase]...] }  // best first; qty in base coin
trades(sym, cb)    -> unsubscribe fn   // live trades, cb({t:ms, p, q, side:'buy'|'sell'})
termSym(sym)       -> symbol string for terminals (e.g. 'BTCUSDT')
limiter            // SB.util.RateLimiter to wrap your REST calls: adapter.limiter.run(() => fetch(...))
```

Events emitted by core:
- `universe` ()                 coin set changed (initial load or listing refresh)
- `newcoin` ({coin, ex})        a symbol appeared on an exchange after the first load (new listing)
- `m1` ({coin, candle, closed}) every live 1m kline update of a coin's primary source; closed=true when the candle closed
- `list` (SB.list)              filtered/sorted list recomputed
- `chart:create` (ctx)          a chart was created on the board or in focus mode
- `chart:destroy` (ctx)
- `chart:data` (ctx)            chart (re)loaded its candles (tf or coin changed)
- `focus` ({key, ex})           focus mode opened

Chart context `ctx` (passed in chart events, also `SB.charts` = Set of live ctx):
```
{ id, key, ex, sym, tf, el (container div), chart (IChartApi), series (candlestick ISeriesApi),
  volume (histogram ISeriesApi), candles (array of bars currently shown, t in seconds),
  mode:'board'|'focus', onDestroy(fn) /* register cleanup */, priceAt(y) / yAt(price) helpers,
  hover: {price, time} | null  /* last crosshair position */,
  head (header div above the chart), badges (span inside head where modules may append small badges) }
```

UI helpers:
```
SB.ui.toast(text, kind='info'|'up'|'down'|'warn', {onClick})
SB.ui.addPanel({id, title, icon, el, width})   // right-side panel + toggle button in the right toolbar
SB.ui.addSettings({id, title, render(el)})     // adds a tab to the Settings dialog
SB.ui.openFocus(key, ex?)                      // open coin in focus mode
SB.ui.openTerminal(key, ex?, {exact})          // open in Vataga/MetaScalp/Tiger per settings
SB.ui.exTag(id) -> HTML span 'BI-F' styled
```

Hotkeys owned by core: any letter opens search, Esc, Space / Shift+Space / ArrowDown / ArrowUp pagination,
Shift+R resort, 1..5 colour group on hovered chart. Modules register their own with
`SB.hotkey(combo, fn)` where combo like 'shift+a'; fn receives (event, ctxUnderMouse|null).
Drawings default: Shift+A price alert (alerts module), Shift+S trend line, Shift+D horizontal ray (drawings).
Ruler: mouse wheel click or Shift+LMB drag (drawings).

## Dev loop
`python3 build.py && .venv/bin/python test/smoke.py` builds and opens the page headless with live data,
prints console errors and saves `test/shot.png`. Keep screenshots small (<300 KB); never send them to the chat.
Network: the box can reach fapi.binance.com, api.binance.com, api.bybit.com, www.okx.com directly.
