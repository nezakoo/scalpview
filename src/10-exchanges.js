// Exchange adapters, multi-exchange universe with dedup, tickers, live 1m feed for the filtered set.
(function () {
  'use strict';
  const SB = window.SB;
  const U = SB.util;

  SB.EX = ['BI-F', 'BI-S', 'BY-F', 'BY-S', 'OK-F', 'OK-S'];
  SB.defaults(null, {
    exchanges: [
      { id: 'BI-F', on: true, coef: 1 }, { id: 'BY-F', on: true, coef: 1 }, { id: 'OK-F', on: true, coef: 1 },
      { id: 'BI-S', on: false, coef: 1 }, { id: 'BY-S', on: false, coef: 1 }, { id: 'OK-S', on: false, coef: 1 },
    ],
    volMin: 10e6,
  });
  SB.coins = new Map();
  SB.list = [];
  SB.coin = key => SB.coins.get(key);
  SB.enabledEx = () => SB.cfg.exchanges.filter(e => e.on).map(e => e.id);
  SB.exCoef = id => (SB.cfg.exchanges.find(e => e.id === id) || {}).coef || 1;

  // GET JSON through the adapter's limiter; on 429/418 pause the limiter and retry.
  const getJSON = async (limiter, url, opts = {}) => {
    for (let attempt = 0; ; attempt++) {
      const r = await limiter.run(() => fetch(url), opts);
      if ((r.status === 429 || r.status === 418) && attempt < 4) {
        const ra = parseFloat(r.headers.get('Retry-After')) || 0;
        limiter.pause(Math.max(ra * 1000, 5000 * 2 ** attempt));
        continue;
      }
      if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
      return r.json();
    }
  };
  const num = parseFloat;
  const TFSEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
  SB.TFSEC = TFSEC;

  // Simple reconnecting websocket with keepalive.
  class WS {
    constructor(url, { onOpen, onMsg, ping, pingMs = 20000, name }) {
      Object.assign(this, { url, onOpen, onMsg, ping, pingMs, name, alive: false, closed: false, retry: 0 });
      this.connect();
    }
    connect() {
      if (this.closed) return;
      const ws = (this.ws = new WebSocket(this.url));
      ws.onopen = () => { this.alive = true; this.retry = 0; this.onOpen && this.onOpen(this); SB.emit('ws', this); };
      ws.onmessage = ev => {
        if (ev.data === 'pong') return;
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.onMsg(m);
      };
      ws.onclose = () => {
        this.alive = false; clearInterval(this.pt); SB.emit('ws', this);
        if (!this.closed) setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** this.retry++));
      };
      ws.onerror = () => {};
      clearInterval(this.pt);
      if (this.ping) this.pt = setInterval(() => { if (ws.readyState === 1) ws.send(this.ping); }, this.pingMs);
    }
    send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
    close() { this.closed = true; clearInterval(this.pt); try { this.ws.close(); } catch (e) {} }
  }
  SB.WS = WS;

  // ---------------- Binance ----------------
  function binance(id, spot) {
    const rest = spot ? 'https://api.binance.com/api/v3' : 'https://fapi.binance.com/fapi/v1';
    // futures market streams moved under /market (legacy paths connect but stay silent)
    const wsBase = spot ? 'wss://stream.binance.com:9443' : 'wss://fstream.binance.com/market';
    const limiter = new U.RateLimiter(spot ? 15 : 10, spot ? 4000 : 1600);
    const a = { id, name: spot ? 'Binance Spot' : 'Binance Futures', market: spot ? 'spot' : 'futures', limiter };
    const kl = k => ({ t: k[0] / 1000, o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[7]), n: k[8] });
    const klw = l => (spot ? 2 : l < 100 ? 1 : l <= 500 ? 2 : l <= 1000 ? 5 : 10);
    a.klines = async (sym, tf, limit = 300, end, opts = {}) => {
      limit = Math.min(limit, spot ? 1000 : 1500);
      const rows = await getJSON(limiter, `${rest}/klines?symbol=${sym}&interval=${tf}&limit=${limit}${end ? '&endTime=' + end : ''}`, { weight: klw(limit), prio: opts.prio });
      return rows.map(kl);
    };
    a.depth = async (sym, limit = 500, opts = {}) => {
      const w = spot ? (limit <= 100 ? 5 : limit <= 500 ? 25 : 50) : (limit <= 50 ? 2 : limit <= 100 ? 5 : limit <= 500 ? 10 : 20);
      const d = await getJSON(limiter, `${rest}/depth?symbol=${sym}&limit=${limit}`, { weight: w, prio: opts.prio });
      return { bids: d.bids.map(x => [num(x[0]), num(x[1])]), asks: d.asks.map(x => [num(x[0]), num(x[1])]) };
    };
    a.trades = (sym, cb) => {
      const w = new WS(`${wsBase}/ws/${sym.toLowerCase()}@aggTrade`, {
        onMsg: m => cb({ t: m.T, p: num(m.p), q: num(m.q), side: m.m ? 'sell' : 'buy' }),
      });
      return () => w.close();
    };
    a.termSym = s => s;
    a.universe = async () => {
      const info = await getJSON(limiter, spot ? `${rest}/exchangeInfo?permissions=SPOT&symbolStatus=TRADING` : `${rest}/exchangeInfo`, { weight: spot ? 20 : 1, prio: 5 });
      const out = [];
      for (const s of info.symbols) {
        if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING') continue;
        if (!spot && s.contractType !== 'PERPETUAL') continue;
        const pf = s.filters.find(f => f.filterType === 'PRICE_FILTER');
        out.push({ base: s.baseAsset, sym: s.symbol, tick: num(pf.tickSize), listed: s.onboardDate || null });
      }
      return out;
    };
    a.tickers = async () => {
      const rows = await getJSON(limiter, `${rest}/ticker/24hr`, { weight: spot ? 80 : 40, prio: 3 });
      const out = {};
      for (const r of rows) out[r.symbol] = { price: num(r.lastPrice), chg24: num(r.priceChangePercent), vol24: num(r.quoteVolume), trades24: r.count };
      if (!spot && (!a._piAt || Date.now() - a._piAt > 55000)) {
        a._piAt = Date.now();
        const pi = await getJSON(limiter, `${rest}/premiumIndex`, { weight: 10, prio: 3 });
        for (const r of pi) if (out[r.symbol]) { out[r.symbol].funding = num(r.lastFundingRate); out[r.symbol].nextFunding = r.nextFundingTime; }
      }
      return out;
    };
    // live 1m klines for many symbols; cb(sym, candle, closed)
    a.feed1m = (syms, cb) => {
      const conns = [];
      for (let i = 0; i < syms.length; i += 150) {
        const part = syms.slice(i, i + 150);
        conns.push(new WS(`${wsBase}/stream?streams=` + part.map(s => s.toLowerCase() + '@kline_1m').join('/'), {
          name: id,
          onMsg: m => {
            const k = m.data && m.data.k;
            if (!k) return;
            cb(k.s, { t: k.t / 1000, o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), v: num(k.q), n: k.n }, k.x);
          },
        }));
      }
      return conns;
    };
    return a;
  }

  // ---------------- Bybit ----------------
  function bybit(id, spot) {
    const cat = spot ? 'spot' : 'linear';
    const rest = 'https://api.bybit.com/v5';
    const limiter = new U.RateLimiter(15);
    const a = { id, name: spot ? 'Bybit Spot' : 'Bybit Futures', market: spot ? 'spot' : 'futures', limiter };
    const IV = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' };
    a.klines = async (sym, tf, limit = 300, end, opts = {}) => {
      const d = await getJSON(limiter, `${rest}/market/kline?category=${cat}&symbol=${sym}&interval=${IV[tf]}&limit=${Math.min(limit, 1000)}${end ? '&end=' + end : ''}`, opts);
      return (d.result.list || []).map(k => ({ t: k[0] / 1000, o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[6]), n: null })).reverse();
    };
    a.depth = async (sym, limit = 200) => {
      const d = await getJSON(limiter, `${rest}/market/orderbook?category=${cat}&symbol=${sym}&limit=${Math.min(limit, spot ? 200 : 500)}`);
      return { bids: d.result.b.map(x => [num(x[0]), num(x[1])]), asks: d.result.a.map(x => [num(x[0]), num(x[1])]) };
    };
    const wsUrl = `wss://stream.bybit.com/v5/public/${cat}`;
    a.trades = (sym, cb) => {
      const w = new WS(wsUrl, {
        ping: '{"op":"ping"}',
        onOpen: w => w.send({ op: 'subscribe', args: ['publicTrade.' + sym] }),
        onMsg: m => { if (m.data && m.topic) for (const t of m.data) cb({ t: t.T, p: num(t.p), q: num(t.v), side: t.S === 'Buy' ? 'buy' : 'sell' }); },
      });
      return () => w.close();
    };
    a.termSym = s => s;
    a.universe = async () => {
      const out = [];
      let cursor = '';
      do {
        const d = await getJSON(limiter, `${rest}/market/instruments-info?category=${cat}&limit=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
        for (const s of d.result.list) {
          if (s.quoteCoin !== 'USDT' || s.status !== 'Trading') continue;
          if (!spot && s.contractType !== 'LinearPerpetual') continue;
          out.push({ base: s.baseCoin, sym: s.symbol, tick: num(s.priceFilter.tickSize), listed: s.launchTime ? +s.launchTime : null });
        }
        cursor = d.result.nextPageCursor;
      } while (cursor && !spot);
      return out;
    };
    a.tickers = async () => {
      const d = await getJSON(limiter, `${rest}/market/tickers?category=${cat}`);
      const out = {};
      for (const r of d.result.list) {
        out[r.symbol] = { price: num(r.lastPrice), chg24: num(r.price24hPcnt) * 100, vol24: num(r.turnover24h), trades24: null };
        if (!spot) { out[r.symbol].funding = num(r.fundingRate); out[r.symbol].nextFunding = +r.nextFundingTime; }
      }
      return out;
    };
    a.feed1m = (syms, cb) => {
      const conns = [];
      const per = spot ? 10 : 190;
      for (let i = 0; i < syms.length; i += per) {
        const part = syms.slice(i, i + per);
        conns.push(new WS(wsUrl, {
          name: id, ping: '{"op":"ping"}',
          onOpen: w => { for (let j = 0; j < part.length; j += 10) w.send({ op: 'subscribe', args: part.slice(j, j + 10).map(s => 'kline.1.' + s) }); },
          onMsg: m => {
            if (!m.topic || !m.data) return;
            const sym = m.topic.split('.')[2];
            for (const k of m.data) cb(sym, { t: k.start / 1000, o: num(k.open), h: num(k.high), l: num(k.low), c: num(k.close), v: num(k.turnover), n: null }, k.confirm);
          },
        }));
      }
      return conns;
    };
    return a;
  }

  // ---------------- OKX ----------------
  function okx(id, spot) {
    const type = spot ? 'SPOT' : 'SWAP';
    const rest = 'https://www.okx.com/api/v5';
    const limiter = new U.RateLimiter(9);
    const ctVal = {};
    const a = { id, name: spot ? 'OKX Spot' : 'OKX Futures', market: spot ? 'spot' : 'futures', limiter };
    const BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc', '1w': '1Wutc' };
    const kl = k => ({ t: k[0] / 1000, o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[7]), n: null });
    a.klines = async (sym, tf, limit = 300, end, opts = {}) => {
      // /candles serves recent 1440 bars; history-candles goes further back. 100/300 per page.
      const out = [];
      let after = end || '';
      while (out.length < limit) {
        const ep = after ? 'history-candles' : 'candles';
        const lim = ep === 'candles' ? 300 : 100;
        const d = await getJSON(limiter, `${rest}/market/${ep}?instId=${sym}&bar=${BAR[tf]}&limit=${lim}${after ? '&after=' + after : ''}`, opts);
        const rows = d.data || [];
        if (!rows.length) break;
        out.push(...rows);
        after = rows[rows.length - 1][0];
        if (rows.length < lim) break;
      }
      return out.slice(0, limit).map(kl).reverse();
    };
    a.depth = async (sym, limit = 400) => {
      const d = await getJSON(limiter, `${rest}/market/books?instId=${sym}&sz=${Math.min(limit, 400)}`);
      const b = d.data[0], cv = ctVal[sym] || 1;
      return { bids: b.bids.map(x => [num(x[0]), num(x[1]) * cv]), asks: b.asks.map(x => [num(x[0]), num(x[1]) * cv]) };
    };
    a.trades = (sym, cb) => {
      const cv = ctVal[sym] || 1;
      const w = new WS('wss://ws.okx.com:8443/ws/v5/public', {
        ping: 'ping', pingMs: 25000,
        onOpen: w => w.send({ op: 'subscribe', args: [{ channel: 'trades', instId: sym }] }),
        onMsg: m => { if (m.data && m.arg) for (const t of m.data) cb({ t: +t.ts, p: num(t.px), q: num(t.sz) * cv, side: t.side }); },
      });
      return () => w.close();
    };
    a.termSym = s => s.replace('-SWAP', '').replace('-', '');
    a.universe = async () => {
      const d = await getJSON(limiter, `${rest}/public/instruments?instType=${type}`);
      const out = [];
      for (const s of d.data) {
        if (s.state !== 'live') continue;
        if (spot ? s.quoteCcy !== 'USDT' : s.settleCcy !== 'USDT') continue;
        const base = spot ? s.baseCcy : s.ctValCcy;
        ctVal[s.instId] = spot ? 1 : num(s.ctVal);
        out.push({ base, sym: s.instId, tick: num(s.tickSz), ctVal: ctVal[s.instId], listed: s.listTime ? +s.listTime : null });
      }
      return out;
    };
    a.tickers = async () => {
      const d = await getJSON(limiter, `${rest}/market/tickers?instType=${type}`);
      const out = {};
      for (const r of d.data) {
        const last = num(r.last), open = num(r.open24h);
        // SWAP volCcy24h is in base coin; SPOT volCcy24h is in quote
        out[r.instId] = { price: last, chg24: open ? (last / open - 1) * 100 : 0, vol24: spot ? num(r.volCcy24h) : num(r.volCcy24h) * last, trades24: null, sod: num(r.sodUtc0) };
      }
      if (!spot) {
        try {
          const f = await getJSON(limiter, `${rest}/public/funding-rate?instId=ANY`);
          for (const r of f.data) if (out[r.instId]) { out[r.instId].funding = num(r.fundingRate); out[r.instId].nextFunding = +r.fundingTime; }
        } catch (e) { console.warn('okx funding', e.message); }
      }
      return out;
    };
    a.feed1m = (syms, cb) => {
      const conns = [];
      for (let i = 0; i < syms.length; i += 100) {
        const part = syms.slice(i, i + 100);
        conns.push(new WS('wss://ws.okx.com:8443/ws/v5/business', {
          name: id, ping: 'ping', pingMs: 25000,
          onOpen: w => w.send({ op: 'subscribe', args: part.map(s => ({ channel: 'candle1m', instId: s })) }),
          onMsg: m => {
            if (!m.arg || !m.data) return;
            for (const k of m.data) cb(m.arg.instId, kl(k), k[8] === '1');
          },
        }));
      }
      return conns;
    };
    return a;
  }

  SB.ex = {
    'BI-F': binance('BI-F', false), 'BI-S': binance('BI-S', true),
    'BY-F': bybit('BY-F', false), 'BY-S': bybit('BY-S', true),
    'OK-F': okx('OK-F', false), 'OK-S': okx('OK-S', true),
  };

  // ---------------- universe ----------------
  const raw = {};        // id -> [{base,sym,tick,...}]
  const known = {};      // id -> Set(sym) seen at first load (for new listing detection)
  const symIndex = {};   // id -> sym -> coin
  SB.status = {};        // id -> 'ok' | 'err' | 'load'
  const keyOf = base => base.toUpperCase() + 'USDT';

  function rebuild() {
    const order = SB.enabledEx();
    const prev = SB.coins;
    const next = new Map();
    for (const id of order) {
      symIndex[id] = {};
      for (const s of raw[id] || []) {
        const key = keyOf(s.base);
        let c = next.get(key);
        if (!c) {
          const old = prev.get(key);
          c = old || { key, base: s.base.toUpperCase(), m1: [], ind: {}, group: null };
          c._oldSrc = c.src || {};
          c.src = {};
          c.ex = id;
          next.set(key, c);
        }
        const keep = (c._oldSrc && c._oldSrc[id]) || {};
        c.src[id] = Object.assign(keep, { sym: s.sym, tick: s.tick, ctVal: s.ctVal, listed: s.listed });
        symIndex[id][s.sym] = c;
      }
    }
    for (const c of next.values()) {
      delete c._oldSrc;
      const p = c.src[c.ex];
      if (c.primaryWas && c.primaryWas !== c.ex) { c.m1 = []; c.seeded = false; }
      c.primaryWas = c.ex;
      c.tick = p.tick;
      const g = (SB.cfg.groups || {})[c.key];
      c.group = g || null;
    }
    SB.coins = next;
    SB.emit('universe');
  }

  async function loadUniverse(id) {
    SB.status[id] = 'load'; SB.emit('status');
    try {
      const list = await SB.ex[id].universe();
      const syms = new Set(list.map(s => s.sym));
      if (known[id]) {
        for (const s of list) if (!known[id].has(s.sym)) { known[id].add(s.sym); s._new = true; }
      } else known[id] = syms;
      raw[id] = list;
      SB.status[id] = 'ok';
      return list.filter(s => s._new);
    } catch (e) {
      console.warn('universe', id, e.message);
      SB.status[id] = 'err';
      return [];
    } finally { SB.emit('status'); }
  }

  async function refreshTickers(id) {
    try {
      const t = await SB.ex[id].tickers();
      for (const sym in t) {
        const c = symIndex[id] && symIndex[id][sym];
        if (!c) continue;
        const s = c.src[id];
        Object.assign(s, t[sym]);
        if (c.ex === id) {
          if (!c.live || !c.m1.length) c.price = s.price;
          c.vol24 = s.vol24; c.chg24 = s.chg24; c.trades24 = s.trades24;
          if (s.sod) c.dayOpen = s.sod;
          // live price moves chg24 between ticker refreshes
          if (c.price && s.price) c._open24 = s.price / (1 + s.chg24 / 100);
        }
      }
      for (const c of SB.coins.values()) {
        // funding: primary futures source, else any futures source
        const f = c.src[c.ex].funding != null ? c.src[c.ex] : Object.values(c.src).find(s => s.funding != null);
        c.funding = f ? f.funding : null; c.nextFunding = f ? f.nextFunding : null;
      }
      SB.status[id] = 'ok';
    } catch (e) { console.warn('tickers', id, e.message); SB.status[id] = 'err'; }
    SB.emit('status');
  }

  // ---------------- live 1m feed ----------------
  const feeds = {};      // id -> {syms:Set, conns:[]}
  const M1_MAX = 300;

  function onM1(id, sym, k, closed) {
    const c = symIndex[id] && symIndex[id][sym];
    if (!c || c.ex !== id) return;
    const m = c.m1;
    const last = m[m.length - 1];
    if (last && last.t === k.t) m[m.length - 1] = k;
    else if (!last || k.t > last.t) {
      if (last && k.t - last.t > 60 && c.seeded) { c.gap = true; clearTimeout(SB._gapT); SB._gapT = setTimeout(seedAll, 3000); } // missed candles after a reconnect
      m.push(k);
      if (m.length > M1_MAX) m.splice(0, m.length - M1_MAX);
      if (c.dayOpen != null && k.t % 86400 === 0) c.dayOpen = k.o;
    } else return;
    c.price = k.c;
    c.live = true;
    if (c._open24) c.chg24 = (k.c / c._open24 - 1) * 100;
    c.src[id].price = k.c;
    SB.emit('m1', { coin: c, candle: k, closed });
  }

  function syncFeeds() {
    // subscribe the primary source of every coin that passes the volume filter
    const want = {};
    for (const id of SB.EX) want[id] = new Set();
    for (const c of SB.coins.values()) if (SB.passesVol(c) || c.group) want[c.ex].add(c.src[c.ex].sym);
    for (const id of SB.EX) {
      const f = feeds[id];
      const w = want[id];
      const same = f && f.syms.size === w.size && [...w].every(s => f.syms.has(s));
      if (same) continue;
      if (f) f.conns.forEach(x => x.close());
      feeds[id] = { syms: w, conns: w.size ? SB.ex[id].feed1m([...w], (s, k, x) => onM1(id, s, k, x)) : [] };
    }
    seedAll();
  }
  SB.feeds = feeds;
  SB.syncFeeds = syncFeeds;
  SB.passesVol = c => (c.vol24 || 0) >= SB.cfg.volMin * SB.exCoef(c.ex);

  // seed 1m history + day open for subscribed coins, most liquid first
  let seeding = false;
  async function seedAll() {
    if (seeding) return;
    seeding = true;
    try {
      for (;;) {
        const todo = [...SB.coins.values()]
          .filter(c => (!c.seeded || c.gap) && !c.seedFail && (SB.passesVol(c) || c.group))
          .sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0));
        if (!todo.length) break;
        await Promise.all(todo.slice(0, 6).map(seedOne));
      }
    } finally { seeding = false; }
  }
  async function seedOne(c) {
    const id = c.ex, sym = c.src[id].sym;
    try {
      const k = await SB.ex[id].klines(sym, '1m', 250);
      if (c.ex !== id) return;
      // merge: keep live candles newer than history
      const lastHist = k.length ? k[k.length - 1].t : 0;
      const live = c.m1.filter(x => x.t > lastHist);
      c.m1 = k.concat(live).slice(-M1_MAX);
      c.seeded = true; c.gap = false;
      if (c.dayOpen == null) {
        const d = await SB.ex[id].klines(sym, '1d', 1);
        if (d.length) c.dayOpen = d[d.length - 1].o;
      }
      if (!c.live && c.m1.length) c.price = c.m1[c.m1.length - 1].c;
      SB.emit('seeded', c);
    } catch (e) {
      console.warn('seed', id, sym, e.message);
      c.seedFail = (c.seedFail || 0) + 1;
      setTimeout(() => { c.seedFail = 0; seedAll(); }, 30000);
    }
  }
  SB.seedAll = seedAll;

  // ---------------- boot ----------------
  SB.reloadUniverse = async () => {
    const ids = SB.enabledEx();
    await Promise.all(ids.map(id => (raw[id] ? null : loadUniverse(id))));
    rebuild();
    await Promise.all(ids.map(refreshTickers));
    rebuild(); // primary choice is stable; this re-applies funding etc.
    syncFeeds();
    SB.emit('universe');
  };

  SB.loadData = async () => {
    await SB.reloadUniverse();
    // tickers every 10 s (Binance futures ticker costs weight 40, fine)
    setInterval(() => SB.enabledEx().forEach(refreshTickers), 15000);
    // filter set may change as volume changes
    setInterval(syncFeeds, 60000);
    // new listings: re-read instruments every 5 min
    setInterval(async () => {
      for (const id of SB.enabledEx()) {
        const fresh = await loadUniverse(id);
        if (!fresh.length) continue;
        rebuild();
        for (const s of fresh) {
          const c = SB.coin(keyOf(s.base));
          if (c) SB.emit('newcoin', { coin: c, ex: id });
        }
        syncFeeds();
      }
    }, 300000);
  };
})();
