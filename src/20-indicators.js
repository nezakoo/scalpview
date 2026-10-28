// Indicators computed from each coin's 1m buffer, plus filtering and sorting into SB.list.
(function () {
  'use strict';
  const SB = window.SB;

  // type: chg range natr corr trades tspike vol vspike ; tf: 1m 5m 15m 1h 4h 1d today
  SB.IND_TYPES = {
    chg: { name: 'Change', short: 'CHG', unit: '%', signed: true },
    range: { name: 'Range', short: 'RNG', unit: '%' },
    natr: { name: 'NATR', short: 'NATR', unit: '%' },
    corr: { name: 'Corr BTC', short: 'CORR', unit: '' },
    trades: { name: 'Trades', short: 'TRD', unit: 'n' },
    tspike: { name: 'Trades spike', short: 'TRD*', unit: 'x' },
    vol: { name: 'Volume', short: 'VOL', unit: '$' },
    vspike: { name: 'Volume spike', short: 'VOL*', unit: 'x' },
  };
  SB.IND_TFS = ['1m', '5m', '15m', '1h', '4h', '1d', 'today'];
  SB.defaults(null, {
    listInds: [
      { type: 'chg', tf: '1d', p: 1 }, { type: 'range', tf: '1m', p: 5 }, { type: 'natr', tf: '5m', p: 14 },
      { type: 'corr', tf: '5m', p: 24 }, { type: 'vol', tf: '1d', p: 1 },
    ],
    chartInds: [
      { type: 'chg', tf: '1d', p: 1 }, { type: 'range', tf: '1m', p: 5 }, { type: 'natr', tf: '5m', p: 14 }, { type: 'vol', tf: '1d', p: 1 },
    ],
    sort: { id: 'chg_1d_1', dir: -1, abs: false },
    sortInds: [
      { type: 'chg', tf: '1m', p: 1 }, { type: 'chg', tf: '5m', p: 1 }, { type: 'chg', tf: '15m', p: 1 },
      { type: 'chg', tf: '1h', p: 1 }, { type: 'chg', tf: '4h', p: 1 }, { type: 'chg', tf: '1d', p: 1 },
      { type: 'chg', tf: 'today', p: 1 }, { type: 'range', tf: '1m', p: 5 }, { type: 'natr', tf: '5m', p: 14 },
      { type: 'vol', tf: '1d', p: 1 }, { type: 'vspike', tf: '1m', p: 20 }, { type: 'trades', tf: '1d', p: 1 },
      { type: 'tspike', tf: '1m', p: 20 }, { type: 'corr', tf: '5m', p: 24 },
    ],
    mergeGroups: true,
  });

  SB.indId = d => `${d.type}_${d.tf}_${d.p}`;
  // two-line column header for the coin list: "CHG\nDAY", "NATR\n5M/14"
  SB.indHead = d => {
    const t = SB.IND_TYPES[d.type];
    const tf = d.tf === '1d' && d.p === 1 ? '24H' : d.tf === 'today' ? 'DAY' : `${d.tf}/${d.p}`.toUpperCase();
    return t.short + '\n' + tf;
  };
  SB.indLabel = d => {
    const t = SB.IND_TYPES[d.type];
    if (d.tf === '1d' && d.p === 1) return t.short + ' 24h';
    if (d.tf === 'today') return t.short + ' today';
    return `${t.short} ${d.tf}/${d.p}`;
  };
  SB.indParse = id => { const [type, tf, p] = id.split('_'); return { type, tf, p: +p }; };
  // compact ScalpBoard style: percents without the % sign, 1 decimal
  const II = { chg: 'chg', range: 'range', natr: 'natr', corr: 'corr', trades: 'trades', tspike: 'trades', vol: 'vol', vspike: 'vol' };
  SB.IND_ICON = new Proxy({}, { get: (_, k) => (II[k] ? SB.icon(II[k], 11) : '') });
  SB.fmtInd = (d, v) => {
    if (v == null || !isFinite(v)) return '—';
    const t = SB.IND_TYPES[d.type];
    if (t.unit === '%') return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1);
    if (t.unit === '$') return SB.util.fmtUsd(v);
    if (t.unit === 'x') return v.toFixed(1) + 'x';
    if (t.unit === 'n') return v >= 1e4 ? SB.util.fmtUsd(v) : String(Math.round(v));
    return v.toFixed(1);
  };
  SB.indClass = (d, v) => (SB.IND_TYPES[d.type].signed && v ? (v > 0 ? 'up' : 'down') : '');

  // Aggregate 1m candles into tf buckets aligned to UTC boundaries.
  const aggCache = new WeakMap();
  function agg(m1, tf) {
    if (tf === '1m') return m1;
    const sec = SB.TFSEC[tf];
    let cache = aggCache.get(m1);
    const stamp = m1.length + ':' + (m1.length ? m1[m1.length - 1].t + ':' + m1[m1.length - 1].c : '');
    if (cache && cache.stamp === stamp && cache[tf]) return cache[tf];
    if (!cache || cache.stamp !== stamp) { cache = { stamp }; aggCache.set(m1, cache); }
    const out = [];
    let cur = null;
    for (const k of m1) {
      const b = Math.floor(k.t / sec) * sec;
      if (!cur || cur.t !== b) {
        cur = { t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, n: k.n, cnt: 1 };
        out.push(cur);
      } else {
        cur.h = Math.max(cur.h, k.h); cur.l = Math.min(cur.l, k.l); cur.c = k.c; cur.v += k.v;
        cur.n = cur.n == null || k.n == null ? null : cur.n + k.n; cur.cnt++;
      }
    }
    // drop a leading partial bucket (history started mid-bucket)
    if (out.length > 1 && out[0].cnt < sec / 60) out.shift();
    cache[tf] = out;
    return out;
  }
  SB.agg = agg;

  function returns(c, n) {
    const r = [];
    for (let i = c.length - n; i < c.length; i++) r.push(i > 0 ? c[i].c / c[i - 1].c - 1 : 0);
    return r;
  }
  function pearson(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 3) return null;
    a = a.slice(-n); b = b.slice(-n);
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return da && db ? num / Math.sqrt(da * db) : null;
  }

  function compute(c, d, btc) {
    const { type, tf, p } = d;
    if (tf === '1d' && p === 1) {
      if (type === 'chg') return c.chg24;
      if (type === 'vol') return c.vol24;
      if (type === 'trades') return c.trades24;
    }
    if (tf === 'today') {
      if (type === 'chg') return c.dayOpen && c.price ? (c.price / c.dayOpen - 1) * 100 : null;
      return null;
    }
    if (!c.m1 || c.m1.length < 2) return null;
    const k = agg(c.m1, tf);
    const need = type === 'natr' || type === 'corr' || type === 'tspike' || type === 'vspike' ? p + 1 : p;
    if (k.length < need) return null;
    const w = k.slice(-p);
    switch (type) {
      case 'chg': return (w[w.length - 1].c / w[0].o - 1) * 100;
      case 'range': {
        let h = -Infinity, l = Infinity;
        for (const x of w) { if (x.h > h) h = x.h; if (x.l < l) l = x.l; }
        return l > 0 ? (h / l - 1) * 100 : null;
      }
      case 'natr': {
        let s = 0;
        for (let i = k.length - p; i < k.length; i++) {
          const x = k[i], pc = k[i - 1].c;
          s += Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc));
        }
        return (s / p / k[k.length - 1].c) * 100;
      }
      case 'trades': {
        let s = 0;
        for (const x of w) { if (x.n == null) return null; s += x.n; }
        return s;
      }
      case 'vol': { let s = 0; for (const x of w) s += x.v; return s; }
      case 'tspike': case 'vspike': {
        const f = type === 'tspike' ? 'n' : 'v';
        const last = k[k.length - 1][f];
        if (last == null) return null;
        let s = 0;
        for (let i = k.length - 1 - p; i < k.length - 1; i++) { if (k[i][f] == null) return null; s += k[i][f]; }
        return s ? last / (s / p) : null;
      }
      case 'corr': {
        if (!btc || btc === c) return c === btc ? 1 : null;
        const kb = agg(btc.m1, tf);
        if (kb.length < p + 1) return null;
        // align by time
        const bt = new Map(kb.map((x, i) => [x.t, i]));
        const ra = [], rb = [];
        for (let i = k.length - p; i < k.length; i++) {
          const j = bt.get(k[i].t), j0 = bt.get(k[i - 1].t);
          if (j == null || j0 == null) continue;
          ra.push(k[i].c / k[i - 1].c - 1); rb.push(kb[j].c / kb[j0].c - 1);
        }
        return pearson(ra, rb);
      }
    }
    return null;
  }
  SB.computeInd = compute;

  function activeInds() {
    const m = new Map();
    for (const d of [...SB.cfg.listInds, ...SB.cfg.chartInds, ...SB.cfg.sortInds]) m.set(SB.indId(d), d);
    const s = SB.indParse(SB.cfg.sort.id);
    m.set(SB.cfg.sort.id, s);
    return [...m.values()];
  }

  SB.recompute = () => {
    const inds = activeInds();
    const btc = SB.coin('BTCUSDT');
    const out = [];
    for (const c of SB.coins.values()) {
      const pass = SB.passesVol(c);
      if (!pass && !c.group) continue;
      for (const d of inds) c.ind[SB.indId(d)] = compute(c, d, btc);
      if (pass) out.push(c);
    }
    const { id, dir, abs } = SB.cfg.sort;
    const val = c => { const v = c.ind[id]; return v == null || !isFinite(v) ? null : abs ? Math.abs(v) : v; };
    out.sort((a, b) => {
      if (SB.cfg.mergeGroups) {
        const ga = a.group || 9, gb = b.group || 9;
        if (ga !== gb) return ga - gb;
      }
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return (b.vol24 || 0) - (a.vol24 || 0);
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
    SB.list = out;
    SB.emit('list', out);
  };

  SB.init(() => {
    setInterval(() => { if (SB.coins.size) SB.recompute(); }, 1000);
    SB.on('universe', () => SB.recompute());
  });
})();
