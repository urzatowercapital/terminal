/**
 * Urza Tower Capital MTG Terminal - charting engine (v3)
 *
 * TermChart : multi-series daily line chart (left/right axes, log scale,
 *             MA overlays, crosshair with per-series readout, gaps for nulls)
 * TermBars  : small categorical bar chart (aging curve, histograms)
 * TermSpark : sparkline for table cells
 *
 * No dependencies. Everything draws on a 2D canvas at device pixel ratio.
 * Colours follow the terminal palette: black ground, amber primary.
 */

const TERM_FONT = '11px "Courier New", Courier, Menlo, monospace';
const TERM_FONT_BOLD = 'bold 11px "Courier New", Courier, Menlo, monospace';

function niceTicks(min, max, count = 6) {
  if (!(isFinite(min) && isFinite(max))) return [];
  if (max === min) { max = min + 1; min = min - 1; }
  const span = max - min;
  const rough = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function fmtNum(v, dp) {
  if (v === null || v === undefined || isNaN(v)) return 'n/a';
  const a = Math.abs(v);
  if (dp === undefined) dp = a >= 1000 ? 0 : a >= 100 ? 1 : 2;
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtDateShort(iso) {
  if (!iso) return '';
  const m = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const d = iso.split('-');
  return `${d[2]}${m[+d[1] - 1]}${d[0].slice(2)}`;
}

class TermCanvas {
  constructor(canvas) {
    this.canvas = typeof canvas === 'string' ? document.getElementById(canvas) : canvas;
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(this.canvas.parentElement || this.canvas);
  }
  _prepare(defaultH = 300) {
    const dpr = window.devicePixelRatio || 1;
    const host = this.canvas.parentElement || this.canvas;
    const w = Math.max(50, host.clientWidth || 600);
    const h = Math.max(50, host.clientHeight || defaultH);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    return { ctx, w, h };
  }
  message(text) {
    const { ctx, w, h } = this._prepare();
    ctx.fillStyle = '#ff9900';
    ctx.font = TERM_FONT_BOLD;
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2);
  }
  destroy() { if (this._ro) this._ro.disconnect(); }
}

class TermChart extends TermCanvas {
  constructor(canvas, opts = {}) {
    super(canvas);
    if (!this.canvas) return;
    this.opts = Object.assign({ logScale: false, showMA: true, showLegend: true, title: '', yFormat: fmtNum, rightFormat: fmtNum, padTop: 26 }, opts);
    this.series = [];
    this.hidden = new Set();
    this.mouse = null;
    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.render();
    });
    this.canvas.addEventListener('mouseleave', () => { this.mouse = null; this.render(); });
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      for (const box of (this._legendBoxes || [])) {
        if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
          if (this.hidden.has(box.key)) this.hidden.delete(box.key); else this.hidden.add(box.key);
          this.render();
          return;
        }
      }
    });
  }

  /** series: [{key,label,color,axis:'L'|'R',points:[[iso,value]], ma20:[], ma50:[]}] */
  setSeries(series, opts = {}) {
    this.series = (series || []).filter(s => s && s.points && s.points.length);
    Object.assign(this.opts, opts);
    this.render();
  }
  setOption(k, v) { this.opts[k] = v; this.render(); }

  render() {
    if (!this.canvas) return;
    const visible = this.series.filter(s => !this.hidden.has(s.key));
    if (!this.series.length) { this.message('NO OBSERVATIONS FOR THIS SECURITY / RANGE'); return; }
    const { ctx, w, h } = this._prepare();
    const hasRight = visible.some(s => s.axis === 'R');
    const padL = 64, padR = hasRight ? 64 : 16, padT = this.opts.padTop, padB = 30;
    const cw = w - padL - padR, ch = h - padT - padB;

    // Shared date axis across all series (sorted union)
    const dateSet = new Set();
    this.series.forEach(s => s.points.forEach(p => dateSet.add(p[0])));
    const dates = Array.from(dateSet).sort();
    const xIndex = new Map(dates.map((d, i) => [d, i]));
    const xOf = (i) => padL + (dates.length > 1 ? (i / (dates.length - 1)) * cw : cw / 2);

    const scale = (axis) => {
      let lo = Infinity, hi = -Infinity;
      visible.filter(s => (s.axis || 'L') === axis).forEach(s => {
        s.points.forEach(p => { if (p[1] !== null && isFinite(p[1])) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); } });
        if (axis === 'L' && this.opts.showMA) ['ma20', 'ma50'].forEach(k => (s[k] || []).forEach(v => { if (v !== null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
      });
      if (!isFinite(lo)) return null;
      const log = this.opts.logScale && lo > 0;
      if (lo === hi) { lo = lo * 0.98 - (lo === 0 ? 1 : 0); hi = hi * 1.02 + (hi === 0 ? 1 : 0); }
      const pad = (hi - lo) * 0.06;
      lo = log ? lo / 1.03 : Math.max(lo - pad, lo >= 0 ? 0 : lo - pad); hi = log ? hi * 1.03 : hi + pad;
      const t = (v) => log ? Math.log(v) : v;
      const yOf = (v) => padT + ch - ((t(v) - t(lo)) / (t(hi) - t(lo))) * ch;
      const ticks = log ? niceTicks(lo, hi, 5) : niceTicks(lo, hi, 6);
      return { lo, hi, yOf, ticks: ticks.filter(v => v >= lo && v <= hi), log };
    };
    const L = scale('L'), R = hasRight ? scale('R') : null;

    // Grid + left axis
    ctx.font = TERM_FONT;
    ctx.lineWidth = 1;
    if (L) {
      L.ticks.forEach(v => {
        const y = L.yOf(v);
        ctx.strokeStyle = '#1c1c1c'; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
        ctx.fillStyle = '#ff9900'; ctx.textAlign = 'right'; ctx.fillText(this.opts.yFormat(v), padL - 6, y + 4);
      });
    }
    if (R) {
      R.ticks.forEach(v => {
        const y = R.yOf(v);
        ctx.fillStyle = '#8899aa'; ctx.textAlign = 'left'; ctx.fillText(this.opts.rightFormat(v), padL + cw + 6, y + 4);
      });
    }
    // Date axis
    const nLabels = Math.max(2, Math.min(8, Math.floor(cw / 80)));
    const step = Math.max(1, Math.floor((dates.length - 1) / (nLabels - 1)));
    ctx.fillStyle = '#888'; ctx.textAlign = 'center';
    for (let i = 0; i < dates.length; i += step) {
      const x = xOf(i);
      ctx.strokeStyle = '#141414'; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
      ctx.fillText(fmtDateShort(dates[i]), x, padT + ch + 16);
    }
    if ((dates.length - 1) % step !== 0) ctx.fillText(fmtDateShort(dates[dates.length - 1]), xOf(dates.length - 1), padT + ch + 16);

    // Frame
    ctx.strokeStyle = '#333'; ctx.strokeRect(padL, padT, cw, ch);

    const drawLine = (pts, color, width, dash, sc) => {
      if (!sc) return;
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
      let started = false;
      pts.forEach(([d, v]) => {
        if (v === null || !isFinite(v) || (sc.log && v <= 0)) { started = false; return; }
        const x = xOf(xIndex.get(d)), y = sc.yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke(); ctx.setLineDash([]);
    };

    // Area under the primary (first left) series
    const primary = visible.find(s => (s.axis || 'L') === 'L');
    if (primary && L) {
      const grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
      grad.addColorStop(0, 'rgba(255,153,0,0.22)'); grad.addColorStop(1, 'rgba(255,153,0,0.01)');
      ctx.beginPath();
      let first = null, last = null;
      primary.points.forEach(([d, v]) => {
        if (v === null || !isFinite(v)) return;
        const x = xOf(xIndex.get(d)), y = L.yOf(v);
        if (first === null) { ctx.moveTo(x, y); first = x; } else ctx.lineTo(x, y);
        last = x;
      });
      if (first !== null) { ctx.lineTo(last, padT + ch); ctx.lineTo(first, padT + ch); ctx.closePath(); ctx.fillStyle = grad; ctx.fill(); }
    }
    visible.forEach((s, i) => {
      const sc = (s.axis || 'L') === 'R' ? R : L;
      drawLine(s.points, s.color || '#ccc', s === primary ? 2.2 : 1.4, s.axis === 'R' ? [5, 3] : (s.dash || null), sc);
      // Sparse series (a young price lake) get explicit markers so single observations stay visible
      if (sc && s.points.length <= 15) {
        ctx.fillStyle = s.color || '#ccc';
        s.points.forEach(([d, v]) => {
          if (v === null || !isFinite(v) || (sc.log && v <= 0)) return;
          ctx.beginPath(); ctx.arc(xOf(xIndex.get(d)), sc.yOf(v), s === primary ? 4 : 3, 0, Math.PI * 2); ctx.fill();
        });
      }
    });
    if (primary && L && this.opts.showMA) {
      if (primary.ma20) drawLine(primary.points.map((p, i) => [p[0], primary.ma20[i]]), '#ffff00', 1.2, [], L);
      if (primary.ma50) drawLine(primary.points.map((p, i) => [p[0], primary.ma50[i]]), '#ffffff', 1.0, [], L);
    }
    // last value marker
    if (primary && L) {
      const lp = [...primary.points].reverse().find(p => p[1] !== null && isFinite(p[1]));
      if (lp) {
        const x = xOf(xIndex.get(lp[0])), y = L.yOf(lp[1]);
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#000'; ctx.fillRect(padL + cw - 70, y - 8, 66, 15);
        ctx.strokeStyle = '#ff9900'; ctx.strokeRect(padL + cw - 70, y - 8, 66, 15);
        ctx.fillStyle = '#ff9900'; ctx.textAlign = 'right'; ctx.font = TERM_FONT_BOLD; ctx.fillText(this.opts.yFormat(lp[1]), padL + cw - 7, y + 4);
      }
    }

    // Legend (clickable)
    this._legendBoxes = [];
    if (this.opts.showLegend) {
      ctx.font = TERM_FONT; ctx.textAlign = 'left';
      let x = padL;
      const items = this.series.map(s => ({ key: s.key, label: s.label, color: s.color }));
      if (primary && this.opts.showMA && primary.ma20) items.push({ key: '__ma20', label: 'MA20', color: '#ffff00', fixed: true }, { key: '__ma50', label: 'MA50', color: '#ffffff', fixed: true });
      items.forEach(it => {
        const hidden = this.hidden.has(it.key);
        const text = `■ ${it.label}`;
        const tw = ctx.measureText(text).width + 12;
        ctx.fillStyle = hidden ? '#444' : it.color;
        ctx.fillText(text, x, 14);
        if (!it.fixed) this._legendBoxes.push({ key: it.key, x, y: 2, w: tw, h: 16 });
        x += tw;
      });
      if (this.opts.title) {
        ctx.fillStyle = '#aaa'; ctx.textAlign = 'right';
        const tw = ctx.measureText(this.opts.title).width;
        // Keep the title clear of a wide legend: drop to the bottom-right of the plot when they would collide
        if (x + tw + 20 < w - padR) ctx.fillText(this.opts.title, w - padR, 14);
        else ctx.fillText(this.opts.title, padL + cw - 6, padT + ch - 6);
      }
    }

    // Crosshair + readout
    if (this.mouse && this.mouse.x >= padL && this.mouse.x <= padL + cw && dates.length) {
      const i = Math.round(((this.mouse.x - padL) / cw) * (dates.length - 1));
      const d = dates[Math.max(0, Math.min(dates.length - 1, i))];
      const x = xOf(xIndex.get(d));
      ctx.strokeStyle = '#666'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke(); ctx.setLineDash([]);
      const lines = [d];
      visible.forEach(s => {
        const p = s.points.find(q => q[0] === d);
        if (p && p[1] !== null) lines.push({ text: `${s.label}: ${(s.axis === 'R' ? this.opts.rightFormat : this.opts.yFormat)(p[1])}`, color: s.color });
      });
      if (primary && this.opts.showMA && primary.ma20) {
        const idx = primary.points.findIndex(q => q[0] === d);
        if (idx >= 0) {
          if (primary.ma20[idx] !== null) lines.push({ text: `MA20: ${this.opts.yFormat(primary.ma20[idx])}`, color: '#ffff00' });
          if (primary.ma50[idx] !== null) lines.push({ text: `MA50: ${this.opts.yFormat(primary.ma50[idx])}`, color: '#ffffff' });
        }
      }
      ctx.font = TERM_FONT;
      const bw = Math.max(...lines.map(l => ctx.measureText(typeof l === 'string' ? l : l.text).width)) + 16;
      const bh = lines.length * 14 + 8;
      let bx = x + 12; if (bx + bw > w - 4) bx = x - bw - 12;
      const by = padT + 6;
      ctx.fillStyle = 'rgba(0,0,0,0.92)'; ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#ff9900'; ctx.strokeRect(bx, by, bw, bh);
      ctx.textAlign = 'left';
      lines.forEach((l, k) => {
        ctx.fillStyle = typeof l === 'string' ? '#fff' : l.color;
        ctx.font = k === 0 ? TERM_FONT_BOLD : TERM_FONT;
        ctx.fillText(typeof l === 'string' ? l : l.text, bx + 8, by + 15 + k * 14);
      });
    }
  }
}

class TermBars extends TermCanvas {
  constructor(canvas, opts = {}) {
    super(canvas);
    if (!this.canvas) return;
    this.opts = Object.assign({ color: '#00e5ff', logScale: false, valueFormat: fmtNum, highlight: null }, opts);
    this.data = [];
  }
  /** data: [{label, value, sub?, color?}] */
  setData(data, opts = {}) { this.data = data || []; Object.assign(this.opts, opts); this.render(); }
  render() {
    if (!this.canvas) return;
    if (!this.data.length) { this.message('NO DATA'); return; }
    const { ctx, w, h } = this._prepare(200);
    const padL = 56, padR = 12, padT = 18, padB = 34;
    const cw = w - padL - padR, ch = h - padT - padB;
    const vals = this.data.map(d => d.value).filter(v => v !== null && isFinite(v));
    let lo = Math.min(0, ...vals), hi = Math.max(...vals);
    const log = this.opts.logScale && Math.min(...vals) > 0;
    if (log) { lo = Math.min(...vals) / 1.5; }
    if (hi === lo) hi = lo + 1;
    const t = (v) => log ? Math.log(v) : v;
    const yOf = (v) => padT + ch - ((t(v) - t(lo)) / (t(hi) - t(lo))) * ch;
    ctx.font = TERM_FONT;
    niceTicks(lo, hi, 5).forEach(v => {
      if (log && v <= 0) return;
      const y = yOf(v);
      ctx.strokeStyle = '#1c1c1c'; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
      ctx.fillStyle = '#ff9900'; ctx.textAlign = 'right'; ctx.fillText(this.opts.valueFormat(v), padL - 6, y + 4);
    });
    const n = this.data.length;
    const slot = cw / n, bw = Math.max(4, slot * 0.6);
    this.data.forEach((d, i) => {
      const x = padL + slot * i + (slot - bw) / 2;
      const y0 = yOf(log ? lo : 0);
      const y1 = d.value === null ? y0 : yOf(d.value);
      ctx.fillStyle = d.color || (this.opts.highlight === d.label ? '#ffff00' : this.opts.color);
      ctx.fillRect(x, Math.min(y0, y1), bw, Math.abs(y0 - y1));
      ctx.fillStyle = '#ccc'; ctx.textAlign = 'center';
      ctx.fillText(d.label, x + bw / 2, padT + ch + 14);
      if (d.sub) { ctx.fillStyle = '#777'; ctx.fillText(d.sub, x + bw / 2, padT + ch + 26); }
      if (d.value !== null) { ctx.fillStyle = '#fff'; ctx.fillText(this.opts.valueFormat(d.value), x + bw / 2, Math.min(y0, y1) - 4); }
    });
    ctx.strokeStyle = '#333'; ctx.strokeRect(padL, padT, cw, ch);
  }
}

function drawSparkline(canvas, values, color = '#ff9900') {
  if (!canvas || !values || values.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 90, h = canvas.clientHeight || 18;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr);
  const lo = Math.min(...values), hi = Math.max(...values);
  const yOf = (v) => hi === lo ? h / 2 : h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
  ctx.beginPath();
  ctx.strokeStyle = values[values.length - 1] >= values[0] ? '#00ff66' : '#ff3333';
  ctx.lineWidth = 1.2;
  values.forEach((v, i) => { const x = (i / (values.length - 1)) * (w - 2) + 1; if (i === 0) ctx.moveTo(x, yOf(v)); else ctx.lineTo(x, yOf(v)); });
  ctx.stroke();
}

window.TermChart = TermChart;
window.TermBars = TermBars;
window.drawSparkline = drawSparkline;
window.fmtNum = fmtNum;
window.fmtDateShort = fmtDateShort;
