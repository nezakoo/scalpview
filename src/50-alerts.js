/* 50-alerts: price alerts, impulses, new listings, funding clock, pre-entry check, notifications */
(function () {
  'use strict';
  const SB = window.SB;
  const LS_ALERTS = 'sb.alerts', LS_FEED = 'sb.alerts.feed';
  const FEED_MAX = 150;
  const FUT = ['BI-F', 'BY-F', 'OK-F'];

  let C;                        // SB.cfg.alerts
  let alerts = [];              // [{id, key, ex, price, side:'above'|'below', created}]
  let feed = [];                // [{t, kind, key, ex, text, cls}]
  const lastImp = new Map();    // key -> ms of last impulse alert
  const fundWarned = new Set(); // `${key}|${ex}|${nextFunding}`
  const lines = new Map();      // ctx -> {series, m: Map(alertId -> {pl, lab, price})}
  const mutedImp = new Set();   // coin keys muted from the impulse card (this session)
  let feedEl, listEl, clockEl, cardEl, fclockEl;

  const $ = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const exTag = id => (SB.ui && SB.ui.exTag) ? SB.ui.exTag(id) : `<span class="sb-al-ex">${esc(id)}</span>`;
  const fmtP = (p, tick) => (SB.util && SB.util.fmtPrice) ? SB.util.fmtPrice(p, tick) : String(+(+p).toPrecision(6));
  const fmtUsd = v => (SB.util && SB.util.fmtUsd) ? SB.util.fmtUsd(v) : String(Math.round(v));
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ } };
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const isFut = id => (SB.ex && SB.ex[id] && SB.ex[id].market) ? SB.ex[id].market === 'futures' : FUT.includes(id);

  function srcPrice(coin, ex) {
    if (!coin) return null;
    if (!ex || ex === coin.ex) return coin.price;
    const s = coin.src && coin.src[ex];
    return s && s.price ? s.price : coin.price;
  }

  /* ---------------- notifications ---------------- */
  let actx;
  function beep(kind) {
    if (!C.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const f = kind === 'down' ? [660, 440] : kind === 'warn' ? [520, 520] : [660, 990];
      f.forEach((hz, i) => {
        const o = actx.createOscillator(), g = actx.createGain(), t0 = actx.currentTime + i * 0.13;
        o.type = 'sine'; o.frequency.value = hz;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, C.volume / 100 * 0.4), t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
        o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + 0.13);
      });
    } catch (e) { /* no audio */ }
  }

  function sendTelegram(text) {
    if (!C.tg || !C.tgToken || !C.tgChat) return Promise.resolve(null);
    // urlencoded body keeps it a CORS "simple request" (no preflight)
    const body = new URLSearchParams({ chat_id: C.tgChat, text, disable_web_page_preview: 'true' });
    const url = 'https://api.telegram.org/bot' + encodeURIComponent(C.tgToken) + '/sendMessage';
    return fetch(url, { method: 'POST', body })
      .then(r => r.json()).catch(() => fetch(url, { method: 'POST', body, mode: 'no-cors' }).then(() => ({ ok: null })))
      .catch(e => ({ ok: false, description: String(e) }));
  }

  // channel: 'price'|'impulse'|'listing'|'funding'
  function notify(text, kind, opts) {
    opts = opts || {};
    if (C.toast && !opts.noToast && SB.ui && SB.ui.toast) SB.ui.toast(text, kind || 'info', { onClick: opts.onClick });
    beep(kind);
    if (C.browser && window.Notification && Notification.permission === 'granted') {
      try {
        const n = new Notification('Scalpview', { body: text, tag: opts.tag, silent: true });
        n.onclick = () => { window.focus(); opts.onClick && opts.onClick(); n.close(); };
      } catch (e) { /* not allowed in this context */ }
    }
    if (C.tg && (C.tgWhat || {})[opts.channel] !== false) sendTelegram(text);
  }

  function pushFeed(item) {
    item.t = item.t || Date.now();
    feed.unshift(item);
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
    save(LS_FEED, feed);
    renderFeed();
  }

  /* ---------------- price alerts ---------------- */
  function persistAlerts() { save(LS_ALERTS, alerts); }

  function addAlert(key, ex, price) {
    const coin = SB.coin(key);
    const cur = srcPrice(coin, ex);
    const a = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), key, ex, price: +(+price).toPrecision(10),
      side: cur != null && cur > price ? 'below' : 'above', created: Date.now() };
    alerts.push(a); persistAlerts(); syncAllLines(); renderList();
    SB.ui && SB.ui.toast && SB.ui.toast(`🔔 ${coin ? coin.base : key} ${ex} ${fmtP(a.price, coin && coin.tick)}`, 'info');
    SB.emit && SB.emit('alert:add', a);
    return a;
  }

  function removeAlert(id) {
    const i = alerts.findIndex(a => a.id === id);
    if (i < 0) return;
    const [a] = alerts.splice(i, 1);
    persistAlerts(); syncAllLines(); renderList();
    SB.emit && SB.emit('alert:remove', a);
  }

  function checkAlerts(key) {
    if (!alerts.length) return;
    const fired = [];
    for (const a of alerts) {
      if (key && a.key !== key) continue;
      const coin = SB.coin(a.key);
      const p = srcPrice(coin, a.ex);
      if (p == null || !isFinite(p)) continue;
      if ((a.side === 'above' && p >= a.price) || (a.side === 'below' && p <= a.price)) fired.push([a, coin, p]);
    }
    for (const [a, coin, p] of fired) {
      alerts.splice(alerts.indexOf(a), 1);
      const name = coin ? coin.base : a.key;
      const txt = `🔔 ${name} ${a.ex} ${a.side === 'above' ? '↑' : '↓'} ${fmtP(a.price, coin && coin.tick)} (now ${fmtP(p, coin && coin.tick)})`;
      pushFeed({ kind: 'price', key: a.key, ex: a.ex, text: `${a.side === 'above' ? '↑' : '↓'} ${fmtP(a.price, coin && coin.tick)}`, cls: a.side === 'above' ? 'up' : 'down' });
      notify(txt, a.side === 'above' ? 'up' : 'down', { channel: 'price', tag: 'pa' + a.id, onClick: () => SB.ui.openFocus(a.key, a.ex) });
      SB.emit && SB.emit('alert:fire', a);
    }
    if (fired.length) { persistAlerts(); syncAllLines(); renderList(); }
  }

  const AL_COLOR = '#7b5cff';
  function syncLines(ctx) {
    if (!ctx || !ctx.series) return;
    let e = lines.get(ctx);
    if (!e || e.series !== ctx.series) { if (e) dropLabels(e); e = { series: ctx.series, m: new Map() }; lines.set(ctx, e); } // series rebuilt
    const m = e.m;
    const want = new Map(alerts.filter(a => a.key === ctx.key).map(a => [a.id, a]));
    for (const [id, x] of m) if (!want.has(id)) { try { ctx.series.removePriceLine(x.pl); } catch (er) { /* series gone */ } x.lab.remove(); m.delete(id); }
    const host = labelHost(ctx);
    for (const [id, a] of want) {
      if (m.has(id)) continue;
      try {
        const pl = ctx.series.createPriceLine({ price: a.price, color: AL_COLOR, lineWidth: 1, lineStyle: 0,
          axisLabelVisible: true, axisLabelColor: AL_COLOR, axisLabelTextColor: '#f2f2f2', title: '' });
        const coin = SB.coin(a.key);
        const lab = $('div', 'sb-al-plabel', esc(fmtP(a.price, coin && coin.tick)) + (a.ex !== ctx.ex ? ` <i>${esc(a.ex)}</i>` : ''));
        lab.title = `Price alert ${a.ex} ${a.side === 'above' ? '↑' : '↓'} · Shift+A on the line to remove`;
        lab.style.display = 'none';
        if (host) host.appendChild(lab);
        m.set(id, { pl, lab, price: a.price, y: null });
      } catch (er) { /* series not ready */ }
    }
    kickLabels();
  }
  function labelHost(ctx) {
    try { const ce = ctx.chart.chartElement(); if (ce && ce.parentElement) return ce.parentElement; } catch (e) { /* old LWC */ }
    return ctx.el;
  }
  function dropLabels(e) { for (const x of e.m.values()) x.lab.remove(); }
  // HTML labels follow the price scale (autoscale, zoom, scroll): reposition every frame while any exist
  let labRaf = 0;
  function kickLabels() { if (!labRaf) labRaf = requestAnimationFrame(posLabels); }
  function posLabels() {
    labRaf = 0;
    let any = false;
    for (const [ctx, e] of lines) {
      if (!e.m.size) continue;
      any = true;
      let w = 0, h = 0;
      try { const ce = ctx.chart.chartElement(); w = ce.clientWidth; h = ce.clientHeight; } catch (er) { /* */ }
      for (const x of e.m.values()) {
        let y = null;
        try { y = ctx.series.priceToCoordinate(x.price); } catch (er) { /* */ }
        const vis = y != null && y >= 0 && y <= h - 26;
        if (!vis) { if (x.lab.style.display !== 'none') x.lab.style.display = 'none'; continue; }
        const top = Math.round(y) + 'px', left = Math.round(w * 0.38) + 'px';
        if (x.lab.style.display === 'none') x.lab.style.display = '';
        if (x.lab.style.top !== top) x.lab.style.top = top;
        if (x.lab.style.left !== left) x.lab.style.left = left;
      }
    }
    if (any) labRaf = requestAnimationFrame(posLabels);
  }
  function syncAllLines() { if (SB.charts) for (const ctx of SB.charts) syncLines(ctx); }

  function nearAlert(ctx, price) {
    let best = null, bestD = Infinity;
    for (const a of alerts) {
      if (a.key !== ctx.key) continue;
      let d;
      if (ctx.yAt) { const y1 = ctx.yAt(a.price), y2 = ctx.yAt(price); d = (y1 == null || y2 == null) ? Infinity : Math.abs(y1 - y2); }
      if (d == null || !isFinite(d)) d = Math.abs(a.price - price) / price * 100 < 0.15 ? 0 : Infinity;
      if (d <= 7 && d < bestD) { best = a; bestD = d; }
    }
    return best;
  }

  function onShiftA(e, ctx) {
    if (!ctx || !ctx.hover || ctx.hover.price == null) {
      SB.ui && SB.ui.toast && SB.ui.toast('Hover a chart to set a price alert', 'warn');
      return;
    }
    e && e.preventDefault && e.preventDefault();
    const near = nearAlert(ctx, ctx.hover.price);
    if (near) { removeAlert(near.id); SB.ui.toast('Alert removed', 'info'); return; }
    const coin = SB.coin(ctx.key);
    const tick = (coin && coin.src && coin.src[ctx.ex] && coin.src[ctx.ex].tick) || ctx.tick || (coin && coin.tick);
    let p = ctx.hover.price;
    if (tick) p = Math.round(p / tick) * tick;
    addAlert(ctx.key, ctx.ex, +p.toPrecision(12));
  }

  /* ---------------- impulses ---------------- */
  function bucket5(m1, endIdx) {
    // 5m candle containing m1[endIdx] and its start index
    const c = m1[endIdx], b0 = c.t - (c.t % 300);
    let i = endIdx, o, h = -Infinity, l = Infinity, v = 0;
    while (i >= 0 && m1[i].t >= b0) { const k = m1[i]; o = k.o; if (k.h > h) h = k.h; if (k.l < l) l = k.l; v += k.v || 0; i--; }
    return { t: b0, o, h, l, c: c.c, v, prev: i };
  }

  function impulseOf(coin, candle) {
    const m1 = coin.m1;
    let k = candle, avgV = null;
    const N = Math.max(1, C.impVolN | 0);
    if (C.impTf === '5m' && m1 && m1.length) {
      k = bucket5(m1, m1.length - 1);
      if (!(k.l > 0)) return null;
      const pct = (k.h - k.l) / k.l * 100;
      if (pct < C.impPct) return null;
      if (C.impVolX > 0) {
        let s = 0, n = 0, i = k.prev;
        while (i >= 0 && n < N) { const b = bucket5(m1, i); s += b.v; n++; i = b.prev; }
        avgV = n ? s / n : null;
      }
      return finish(k, pct, avgV);
    }
    if (!(k.l > 0)) return null;
    const pct = (k.h - k.l) / k.l * 100;
    if (pct < C.impPct) return null;
    if (C.impVolX > 0 && m1 && m1.length > 1) {
      const last = m1[m1.length - 1] && m1[m1.length - 1].t === k.t ? m1.length - 2 : m1.length - 1;
      let s = 0, n = 0;
      for (let i = last; i >= 0 && n < N; i--, n++) s += m1[i].v || 0;
      avgV = n ? s / n : null;
    }
    return finish(k, pct, avgV);
  }

  function finish(k, pct, avgV) {
    const up = k.c >= k.o;
    if (C.impDir === 'up' && !up) return null;
    if (C.impDir === 'down' && up) return null;
    let volX = null;
    if (C.impVolX > 0) {
      if (!avgV) return null;
      volX = (k.v || 0) / avgV;
      if (volX < C.impVolX) return null;
    }
    return { up, pct, volX, t: k.t };
  }

  function onM1(d) {
    const coin = d && d.coin;
    if (!coin) return;
    if (alerts.length) checkAlerts(coin.key);
    if (!C.impOn || !d.candle) return;
    const ex = coin.ex;
    const minV = (C.impMinVol || {})[ex];
    if (minV == null || minV < 0) return;           // exchange disabled for impulses
    if ((coin.vol24 || 0) < minV) return;
    if (mutedImp.has(coin.key)) return;
    const now = Date.now(), last = lastImp.get(coin.key);
    if (last && now - last < C.impCooldown * 60000) return;
    const imp = impulseOf(coin, d.candle);
    if (!imp) return;
    lastImp.set(coin.key, now);
    const sign = imp.up ? '+' : '-', pctTxt = sign + (imp.pct >= 10 ? Math.round(imp.pct) : imp.pct.toFixed(1)) + '%';
    const vx = imp.volX ? ` vol x${imp.volX.toFixed(1)}` : '';
    pushFeed({ kind: 'impulse', key: coin.key, ex, text: pctTxt + ' ' + C.impTf + vx, cls: imp.up ? 'up' : 'down' });
    if (C.impCard) showImpCard(coin, ex, pctTxt, imp.up);
    notify(`⚡ ${coin.base} ${ex} ${pctTxt} (${C.impTf})${vx}`, imp.up ? 'up' : 'down',
      { channel: 'impulse', tag: 'imp' + coin.key, noToast: !!C.impCard, onClick: () => SB.ui.openFocus(coin.key, ex) });
  }

  /* ---------------- new listings ---------------- */
  function onNewCoin(d) {
    if (!C.listOn || !d || !d.coin) return;
    const { coin, ex } = d;
    pushFeed({ kind: 'listing', key: coin.key, ex, text: 'NEW listing', cls: 'new' });
    notify(`🆕 ${coin.base} listed on ${ex}`, 'warn', { channel: 'listing', tag: 'new' + coin.key + ex, onClick: () => SB.ui.openFocus(coin.key, ex) });
  }

  /* ---------------- funding clock ---------------- */
  function fundings() {
    const out = [], thr = C.fundThr / 100, now = Date.now();
    if (!SB.coins) return out;
    for (const coin of SB.coins.values()) {
      for (const ex in (coin.src || {})) {
        const s = coin.src[ex];
        if (!s || s.funding == null || !s.nextFunding || !isFut(ex)) continue;
        if (Math.abs(s.funding) < thr || s.nextFunding < now - 60000) continue;
        out.push({ key: coin.key, base: coin.base, ex, funding: s.funding, next: s.nextFunding });
      }
    }
    out.sort((a, b) => a.next - b.next || Math.abs(b.funding) - Math.abs(a.funding));
    return out;
  }

  function cd(ms) {
    if (ms <= 0) return 'now';
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
  }

  function tickClock() {
    const rows = fundings(), now = Date.now();
    if (C.fundOn) for (const r of rows) {
      const left = r.next - now, id = `${r.key}|${r.ex}|${r.next}`;
      if (left > 0 && left <= C.fundWarn * 60000 && !fundWarned.has(id)) {
        fundWarned.add(id);
        const pct = (r.funding * 100).toFixed(3) + '%';
        pushFeed({ kind: 'funding', key: r.key, ex: r.ex, text: `funding ${pct} in ${Math.ceil(left / 60000)}m`, cls: r.funding > 0 ? 'down' : 'up' });
        notify(`⏰ ${r.base} ${r.ex} funding ${pct} in ${Math.ceil(left / 60000)} min`, 'warn',
          { channel: 'funding', tag: 'f' + id, onClick: () => SB.ui.openFocus(r.key, r.ex) });
      }
    }
    tickFundClock(rows, now);
    if (!clockEl || !clockEl.isConnected || clockEl.offsetParent === null) return;
    if (!rows.length) { clockEl.innerHTML = `<div class="sb-al-empty">No fundings with |rate| ≥ ${C.fundThr}%</div>`; return; }
    clockEl.innerHTML = rows.slice(0, 120).map(r => {
      const left = r.next - now, soon = left <= C.fundWarn * 60000;
      return `<div class="sb-al-row" data-key="${esc(r.key)}" data-ex="${esc(r.ex)}">
        <span class="sb-al-name">${esc(r.base)}</span>${exTag(r.ex)}
        <span class="sb-al-num ${r.funding > 0 ? 'up' : 'down'}">${(r.funding * 100).toFixed(3)}%</span>
        <span class="sb-al-cd ${soon ? 'soon' : ''}">${cd(left)}</span></div>`;
    }).join('');
  }

  /* ---------------- impulse card (bottom right, newest replaces) ---------------- */
  const SVG_BELLOFF = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>';
  const SVG_X = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  let cardTimer = 0;
  function exName(id) { return (SB.ex && SB.ex[id] && SB.ex[id].name) || id; }
  function closeImpCard() {
    if (cardEl) cardEl.remove();
    cardEl = null; clearInterval(cardTimer); cardTimer = 0;
    document.body.classList.remove('sb-al-card-on');
  }
  function showImpCard(coin, ex, pctTxt, up) {
    closeImpCard();
    const t0 = Date.now(), key = coin.key;
    const el = $('div', 'sb-al-card ' + (up ? 'is-up' : 'is-down'), `
      <div class="sb-al-card-top"><span class="sb-al-card-title">Impulse</span>
        <span class="sb-al-card-ic" data-act="mute" title="Mute ${esc(coin.base)} impulses (this session)">${SVG_BELLOFF}</span>
        <span class="sb-al-card-ic" data-act="close" title="Close">${SVG_X}</span></div>
      <div class="sb-al-card-big">${esc(coin.base)} <b>${esc(pctTxt)}</b></div>
      <div class="sb-al-card-bot"><span class="sb-al-card-ex">${esc(exName(ex))}</span><span class="sb-al-card-age">0</span></div>`);
    el.title = 'Click: focus · Right/middle click: terminal (Ctrl = exact exchange)';
    const age = el.querySelector('.sb-al-card-age');
    const term = e => { e.preventDefault(); SB.ui.openTerminal(key, ex, { exact: e.ctrlKey }); };
    el.addEventListener('click', e => {
      const a = e.target.closest('[data-act]');
      if (a && a.dataset.act === 'mute') { mutedImp.add(key); SB.ui.toast && SB.ui.toast(`Impulses muted: ${esc(coin.base)}`, 'info', { ttl: 2000 }); }
      if (a) { closeImpCard(); return; }
      SB.ui.openFocus(key, ex);
    });
    el.addEventListener('contextmenu', term);
    el.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener('auxclick', e => { if (e.button === 1) term(e); });
    document.body.appendChild(el);
    document.body.classList.add('sb-al-card-on');
    cardEl = el;
    cardTimer = setInterval(() => { age.textContent = Math.floor((Date.now() - t0) / 1000); }, 1000);
  }

  /* ---------------- funding clock widget (right toolbar, bottom) ---------------- */
  const p2 = n => String(n).padStart(2, '0');
  function buildFundClock() {
    fclockEl = $('div', 'sb-al-fclock', '<span>--</span><span>--</span><span>--</span>');
    fclockEl.addEventListener('click', () => {
      const b = [...document.querySelectorAll('#rtb .tb-btn')].find(x => x.title === 'Funding clock');
      if (b) b.click();
    });
    document.body.appendChild(fclockEl);
  }
  function tickFundClock(rows, now) {
    if (!fclockEl) return;
    const up = rows.filter(r => r.next > now);
    const sp = fclockEl.children;
    if (!up.length) {
      sp[0].textContent = sp[1].textContent = sp[2].textContent = '--';
      fclockEl.title = `Funding clock: no fundings with |rate| ≥ ${C.fundThr}%`;
      fclockEl.classList.remove('soon');
      return;
    }
    const next = up[0].next, s = Math.floor((next - now) / 1000);
    sp[0].textContent = p2(Math.min(99, Math.floor(s / 3600))); sp[1].textContent = p2(Math.floor(s % 3600 / 60)); sp[2].textContent = p2(s % 60);
    fclockEl.classList.toggle('soon', next - now <= C.fundWarn * 60000);
    const at = up.filter(r => r.next === next);
    const t = `Next large funding ${hhmm(next)} (|rate| ≥ ${C.fundThr}%):\n` +
      at.slice(0, 25).map(r => `${r.base} ${r.ex} ${(r.funding * 100).toFixed(3)}%`).join('\n') +
      (at.length > 25 ? `\n+${at.length - 25} more` : '') + '\nClick: funding panel';
    if (fclockEl.title !== t) fclockEl.title = t;
  }

  /* ---------------- pre-entry check badges ---------------- */
  function checkCoin(coin) {
    const warn = [];
    if (!coin) return warn;
    const thr = C.fundThr / 100;
    for (const ex in (coin.src || {})) {
      const s = coin.src[ex];
      if (s && s.funding != null && isFut(ex) && Math.abs(s.funding) >= thr)
        warn.push(`Funding ${ex} ${(s.funding * 100).toFixed(3)}%` + (s.nextFunding ? ` in ${cd(s.nextFunding - Date.now())}` : ''));
    }
    const ps = [];
    for (const ex in (coin.src || {})) { const p = srcPrice(coin, ex); if (p > 0) ps.push([ex, p]); }
    if (ps.length > 1) {
      let lo = ps[0], hi = ps[0];
      for (const x of ps) { if (x[1] < lo[1]) lo = x; if (x[1] > hi[1]) hi = x; }
      const diff = (hi[1] - lo[1]) / lo[1] * 100;
      if (diff >= C.spreadPct)
        warn.push(`Price diff ${diff.toFixed(2)}%: ${hi[0]} ${fmtP(hi[1], coin.tick)} vs ${lo[0]} ${fmtP(lo[1], coin.tick)}`);
    }
    return warn;
  }

  const SVG_WARN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  function refreshBadges() {
    if (!SB.charts) return;
    for (const ctx of SB.charts) {
      if (!ctx.badges) continue;
      let b = ctx.badges.querySelector('.sb-al-badge');
      const w = C.badgeOn ? checkCoin(SB.coin(ctx.key)) : [];
      if (!w.length) { if (b) b.remove(); continue; }
      if (!b) { b = $('span', 'sb-al-badge', SVG_WARN); ctx.badges.appendChild(b); }
      const t = w.join('\n');
      if (b.title !== t) b.title = t;
    }
  }

  /* ---------------- panels ---------------- */
  function bindCoinClicks(el) {
    const target = e => e.target.closest('[data-key]');
    el.addEventListener('click', e => {
      const x = e.target.closest('[data-del]');
      if (x) { removeAlert(x.dataset.del); return; }
      const r = target(e); if (r) SB.ui.openFocus(r.dataset.key, r.dataset.ex);
    });
    el.addEventListener('contextmenu', e => {
      const r = target(e); if (!r) return;
      e.preventDefault(); SB.ui.openTerminal(r.dataset.key, r.dataset.ex, { exact: e.ctrlKey });
    });
    el.addEventListener('mousedown', e => { if (e.button === 1 && target(e)) e.preventDefault(); });
    el.addEventListener('auxclick', e => {
      if (e.button !== 1) return;
      const r = target(e); if (!r) return;
      e.preventDefault(); SB.ui.openTerminal(r.dataset.key, r.dataset.ex, { exact: e.ctrlKey });
    });
  }

  const ICON = { impulse: '⚡', listing: '🆕', price: '🔔', funding: '⏰' };
  function renderFeed() {
    if (!feedEl) return;
    if (!feed.length) { feedEl.innerHTML = '<div class="sb-al-empty">No impulses yet</div>'; return; }
    feedEl.innerHTML = feed.map(f => {
      const coin = SB.coin(f.key);
      return `<div class="sb-al-row" data-key="${esc(f.key)}" data-ex="${esc(f.ex)}" title="Click: focus · Right/middle click: terminal (Ctrl = exact exchange)">
        <span class="sb-al-ic">${ICON[f.kind] || ''}</span><span class="sb-al-name">${esc(coin ? coin.base : f.key.replace(/USDT$/, ''))}</span>${exTag(f.ex)}
        <span class="sb-al-num ${f.cls || ''}">${esc(f.text)}</span><span class="sb-al-time">${hhmm(f.t)}</span></div>`;
    }).join('');
  }

  function renderList() {
    if (!listEl) return;
    if (!alerts.length) { listEl.innerHTML = '<div class="sb-al-empty">No alerts. Shift+A over a chart to add one.</div>'; return; }
    listEl.innerHTML = alerts.slice().sort((a, b) => a.key.localeCompare(b.key) || a.price - b.price).map(a => {
      const coin = SB.coin(a.key), p = srcPrice(coin, a.ex);
      const dist = p ? ((a.price - p) / p * 100) : null;
      return `<div class="sb-al-row" data-key="${esc(a.key)}" data-ex="${esc(a.ex)}">
        <span class="sb-al-name">${esc(coin ? coin.base : a.key)}</span>${exTag(a.ex)}
        <span class="sb-al-num ${a.side === 'above' ? 'up' : 'down'}">${a.side === 'above' ? '↑' : '↓'} ${fmtP(a.price, coin && coin.tick)}</span>
        <span class="sb-al-time">${dist == null ? '' : (dist > 0 ? '+' : '') + dist.toFixed(2) + '%'}</span>
        <span class="sb-al-x" data-del="${a.id}" title="Remove">✕</span></div>`;
    }).join('');
  }

  function buildPanels() {
    if (!SB.ui || !SB.ui.addPanel) return;
    const fw = $('div', 'sb-al-panel');
    const fh = $('div', 'sb-al-head', `<span>${C.impTf} ≥ ${C.impPct}%</span><button class="sb-al-btn" data-clear>Clear</button>`);
    feedEl = $('div', 'sb-al-list');
    fw.append(fh, feedEl);
    fh.querySelector('[data-clear]').onclick = () => { feed = []; save(LS_FEED, feed); renderFeed(); };
    bindCoinClicks(feedEl);
    SB.ui.addPanel({ id: 'impulses', title: 'Impulses', icon: '⚡', el: fw, width: 280 });

    const aw = $('div', 'sb-al-panel');
    listEl = $('div', 'sb-al-list');
    aw.append($('div', 'sb-al-head', '<span>Price alerts · Shift+A</span>'), listEl);
    bindCoinClicks(listEl);
    SB.ui.addPanel({ id: 'alerts', title: 'Price alerts', icon: '🔔', el: aw, width: 280 });

    const cw = $('div', 'sb-al-panel');
    clockEl = $('div', 'sb-al-list');
    cw.append($('div', 'sb-al-head', `<span>Funding |rate| ≥ ${C.fundThr}%</span>`), clockEl);
    bindCoinClicks(clockEl);
    SB.ui.addPanel({ id: 'funding', title: 'Funding clock', icon: '⏰', el: cw, width: 280 });
    buildPanels.heads = { imp: fh.firstChild, fund: cw.firstChild.firstChild };
    renderFeed(); renderList();
  }
  function refreshHeads() {
    const h = buildPanels.heads; if (!h) return;
    h.imp.textContent = `${C.impTf} ≥ ${C.impPct}% · ${C.impDir}` + (C.impVolX > 0 ? ` · vol x${C.impVolX}` : '');
    h.fund.textContent = `Funding |rate| ≥ ${C.fundThr}% · warn ${C.fundWarn}m`;
  }

  /* ---------------- settings ---------------- */
  function renderSettings(el) {
    const set = (k, v) => { C[k] = v; SB.saveCfg(); refreshHeads(); renderFeed(); };
    const row = (label, input) => { const r = $('label', 'sb-al-set'); r.append($('span', null, esc(label)), input); return r; };
    const num = (k, step, min) => { const i = $('input'); i.type = 'number'; i.step = step || 'any'; if (min != null) i.min = min; i.value = C[k]; i.onchange = () => set(k, +i.value || 0); return i; };
    const chk = k => { const i = $('input'); i.type = 'checkbox'; i.checked = !!C[k]; i.onchange = () => set(k, i.checked); return i; };
    const sel = (k, opts) => { const s = $('select'); opts.forEach(([v, t]) => { const o = $('option', null, esc(t)); o.value = v; s.append(o); }); s.value = C[k]; s.onchange = () => set(k, s.value); return s; };
    const txt = (k, ph) => { const i = $('input'); i.type = 'text'; i.placeholder = ph; i.value = C[k] || ''; i.onchange = () => set(k, i.value.trim()); return i; };
    const h = t => $('div', 'sb-al-sh', esc(t));
    el.innerHTML = '';
    el.classList.add('sb-al-settings');

    el.append(h('Impulses'),
      row('Enabled', chk('impOn')),
      row('Popup card (bottom right)', chk('impCard')),
      row('Timeframe', sel('impTf', [['1m', '1 minute'], ['5m', '5 minutes']])),
      row('Direction', sel('impDir', [['both', 'Up and down'], ['up', 'Up only'], ['down', 'Down only']])),
      row('Impulse, % (low → high)', num('impPct', 0.1, 0)),
      row('Volume spike, x avg (0 = off)', num('impVolX', 0.1, 0)),
      row('Volume avg over N candles', num('impVolN', 1, 1)),
      row('Cooldown per coin, min', num('impCooldown', 1, 0)));
    const exBox = $('div', 'sb-al-exvol');
    exBox.append($('div', 'sb-al-hint', 'Min 24h volume per exchange, $M (empty = exchange off)'));
    for (const id of (SB.EX || Object.keys(C.impMinVol))) {
      const i = $('input'); i.type = 'number'; i.step = 'any'; i.min = 0;
      const v = C.impMinVol[id]; i.value = v == null || v < 0 ? '' : v / 1e6;
      i.onchange = () => { C.impMinVol = { ...C.impMinVol, [id]: i.value === '' ? -1 : +i.value * 1e6 }; SB.saveCfg(); };
      exBox.append(row(id, i));
    }
    el.append(exBox, h('New listings'), row('Notify on new listings', chk('listOn')));

    el.append(h('Funding clock / pre-entry check'),
      row('Funding threshold |rate|, %', num('fundThr', 0.01, 0)),
      row('Warn before funding', chk('fundOn')),
      row('Warn N minutes before', num('fundWarn', 1, 0)),
      row('Chart warning badge', chk('badgeOn')),
      row('Price diff between exchanges, %', num('spreadPct', 0.1, 0)));

    const perm = $('button', 'sb-al-btn', 'Allow browser notifications');
    const permState = $('span', 'sb-al-hint');
    const showPerm = () => { permState.textContent = window.Notification ? ' ' + Notification.permission : ' not supported'; };
    perm.onclick = () => { if (window.Notification) Notification.requestPermission().then(showPerm); };
    showPerm();
    const test = $('button', 'sb-al-btn', 'Test notification');
    test.onclick = () => notify('🔔 Test alert from Scalpview', 'info', { channel: 'test' });
    const tgState = $('span', 'sb-al-hint');
    const tgTest = $('button', 'sb-al-btn', 'Send Telegram test');
    tgTest.onclick = () => {
      if (!C.tgToken || !C.tgChat) { tgState.textContent = ' set token and chat id first'; return; }
      const was = C.tg; C.tg = true; tgState.textContent = ' sending…';
      sendTelegram('Scalpview test alert').then(r => {
        C.tg = was;
        tgState.textContent = !r ? ' off' : r.ok === true ? ' sent ✓' : r.ok === null ? ' sent (response hidden by CORS)' : ' error: ' + (r.description || '?');
      });
    };
    const pw = $('div', 'sb-al-set'); pw.append(perm, permState);
    el.append(h('Delivery'),
      row('Toast on page', chk('toast')),
      row('Sound', chk('sound')),
      row('Sound volume, %', num('volume', 5, 0)),
      row('Browser notifications', chk('browser')), pw,
      row('Telegram', chk('tg')),
      row('Bot token', txt('tgToken', '123456:ABC…')),
      row('Chat id', txt('tgChat', '123456789')));
    const tw = $('div', 'sb-al-set'); tw.append(test, tgTest, tgState);
    el.append(tw, $('div', 'sb-al-hint', 'Create a bot with @BotFather, send it /start, and use your chat id (e.g. from @userinfobot). The token stays in this browser only.'));
  }

  /* ---------------- init ---------------- */
  function init() {
    SB.defaults('alerts', {
      toast: true, sound: true, volume: 50, browser: false,
      tg: false, tgToken: '', tgChat: '', tgWhat: { price: true, impulse: true, listing: true, funding: true },
      impOn: true, impCard: true, impTf: '1m', impDir: 'both', impPct: 5, impVolX: 0, impVolN: 20, impCooldown: 5,
      impMinVol: { 'BI-F': 30e6, 'BI-S': 10e6, 'BY-F': 3e6, 'BY-S': 3e6, 'OK-F': 3e6, 'OK-S': 3e6 },
      listOn: true,
      fundThr: 0.1, fundOn: true, fundWarn: 5, badgeOn: true, spreadPct: 0.5,
    });
    C = SB.cfg.alerts;
    alerts = load(LS_ALERTS, []).filter(a => a && a.key && isFinite(a.price));
    feed = load(LS_FEED, []);

    buildPanels(); refreshHeads(); buildFundClock();
    SB.ui && SB.ui.addSettings && SB.ui.addSettings({ id: 'alerts', title: 'Alerts', render: renderSettings });

    if (SB.hotkey) SB.hotkey('shift+a', onShiftA);
    else console.warn('alerts: SB.hotkey missing, Shift+A disabled');

    SB.on('m1', onM1);
    SB.on('newcoin', onNewCoin);
    SB.on('chart:create', ctx => {
      syncLines(ctx);
      ctx.onDestroy && ctx.onDestroy(() => { const e = lines.get(ctx); if (e) dropLabels(e); lines.delete(ctx); });
    });
    SB.on('chart:data', syncLines);
    SB.on('chart:destroy', ctx => { const e = lines.get(ctx); if (e) dropLabels(e); lines.delete(ctx); });
    SB.on('universe', () => { renderList(); renderFeed(); });

    // non-primary sources only refresh via REST, so poll alerts too
    setInterval(() => { checkAlerts(); }, 2000);
    setInterval(tickClock, 1000);
    setInterval(refreshBadges, 3000);
    setInterval(renderList, 5000);
    // unlock audio on first gesture
    const unlock = () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) { /* */ } };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  // test/debug hooks
  SB.alerts = { add: addAlert, remove: removeAlert, list: () => alerts, feed: () => feed, check: checkAlerts,
    notify, sendTelegram, showImpCard, closeImpCard, fundings, checkCoin, onM1, lineCount: () => [...lines.values()].reduce((s, e) => s + e.m.size, 0) };
  SB.init(init);
})();
