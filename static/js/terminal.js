/**
 * Urza Tower Capital MTG Terminal - client (v3)
 *
 * One function per screen, Bloomberg grammar on the command line:
 *   <FUNCTION> <GO>          <SECURITY> <FUNCTION> <GO>          <number> <GO>
 * Screens are registered in SCREENS; each renders into #screen and may
 * register numbered menu items. Works against the FastAPI backend, or, when
 * no backend answers, against the pre-baked JSON bundle under data/api/.
 */

const STATE = { static: false, history: [], hIdx: -1, current: null, menu: [], security: null,
                chartRange: '3M', status: null, wei: null, tables: {} };

// ------------------------------------------------------------------ transport
function slug(path, params) {
  let s = path.replace(/^\/api\//, '').replace(/\//g, '__');
  const keys = Object.keys(params || {}).filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '').sort();
  for (const k of keys) s += `~${k}=${params[k]}`;
  return s.replace(/[^A-Za-z0-9._~=-]/g, '_');
}

async function apiFetch(path, params = {}, opts = {}) {
  if (!STATE.static) {
    const q = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
    // Encode the path (security names carry spaces and commas) but never re-encode the query
    const url = encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F') + (q ? '?' + q : '');
    const res = await fetch(url, opts);
    if (res.status === 404) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || 'NOT FOUND'); }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || `HTTP ${res.status}`); }
    return await res.json();
  }
  const res = await fetch(`data/api/${slug(path, params)}.json`);
  if (!res.ok) throw new Error('NOT IN STATIC BUNDLE — run the local server for this query');
  return await res.json();
}

// ------------------------------------------------------------------ formatting
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
const isNum = (v) => v !== null && v !== undefined && v !== '' && !isNaN(v);
function px(v, dp) { return isNum(v) ? '$' + fmtNum(v, dp) : '<span class="val-na">n/a</span>'; }
function num(v, dp = 2) { if (typeof dp !== 'number') dp = 2; return isNum(v) ? fmtNum(v, dp) : '<span class="val-na">n/a</span>'; }
function pct(v, dp = 2) {
  if (typeof dp !== 'number') dp = 2;
  if (!isNum(v)) return '<span class="val-na">n/a</span>';
  const cls = v > 0 ? 'val-up' : v < 0 ? 'val-down' : 'val-flat';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${Number(v).toFixed(dp)}%</span>`;
}
function pctPlain(v, dp = 1) { return isNum(v) ? `${Number(v).toFixed(dp)}%` : 'n/a'; }
const d10 = (s) => s ? String(s).slice(0, 10) : '<span class="val-na">n/a</span>';
const yes = (b) => b ? '<span class="val-down" style="font-weight:bold">YES</span>' : '<span class="val-na">no</span>';

function msg(text, err = false) {
  const el = document.getElementById('msgLine');
  el.textContent = text || '';
  el.className = 'bbg-msg-line' + (err ? ' err' : '');
}

// ------------------------------------------------------------------ screen shell
function screenEl() { return document.getElementById('screen'); }

function panel(title, bodyHtml, opts = {}) {
  const asof = opts.asof ? `<span class="asof">AS OF ${esc(opts.asof)}</span>` : '';
  const controls = opts.controls ? `<div class="bbg-panel-controls">${opts.controls}</div>` : '';
  return `<div class="bbg-panel" ${opts.id ? `id="${opts.id}"` : ''}>
    <div class="bbg-panel-header"><div class="bbg-panel-title">${title}${asof}</div>${controls}</div>
    ${bodyHtml}</div>`;
}

function fnTitle(code, name, sec) {
  return `<span class="code">${code}</span> ${esc(name)}${sec ? ` <span class="sec">— ${esc(sec)}</span>` : ''}`;
}

/** Generic table. cols: [{key,label,fmt,left,sort}] rows: [] ; opts: {onRow(row), menu:true, sort:{by,order,onSort}} */
function table(cols, rows, opts = {}) {
  const sort = opts.sort;
  const ths = cols.map(c => {
    const sortable = sort && (c.sort !== false);
    const cls = [c.left ? 'text-left' : '', sortable && sort.by === (c.sortKey || c.key) ? `sorted ${sort.order}` : ''].join(' ');
    return `<th class="${cls}" ${sortable ? `data-sort="${c.sortKey || c.key}"` : ''}>${c.label}</th>`;
  }).join('');
  const startNum = STATE.menu.length;
  const trs = rows.map((r, i) => {
    const tds = cols.map(c => {
      const v = c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key]);
      return `<td class="${c.left ? 'text-left' : ''}">${v}</td>`;
    }).join('');
    const menuCell = opts.menu ? `<td class="text-left"><span class="menu-num">${startNum + i + 1})</span></td>` : '';
    if (opts.onRow) STATE.menu.push({ label: r.name || r.code || '', run: () => { STATE.lastRow = r; opts.onRow(r); } });
    return `<tr data-row="${i}">${menuCell}${tds}</tr>`;
  }).join('');
  const head = (opts.menu ? '<th class="text-left" style="width:34px">#</th>' : '') + ths;
  const html = `<div class="bbg-table-wrapper" style="max-height:${opts.maxHeight || '620px'}"><table class="bbg-table"><thead><tr>${head}</tr></thead><tbody>${trs || `<tr><td colspan="${cols.length + 1}" class="text-left val-na">NO ROWS</td></tr>`}</tbody></table></div>`;
  // bind after insertion
  const id = 'tbl' + Math.random().toString(36).slice(2, 8);
  setTimeout(() => {
    const host = document.getElementById(id);
    if (!host) return;
    if (opts.onRow) host.querySelectorAll('tbody tr[data-row]').forEach(tr => tr.addEventListener('click', () => { STATE.lastRow = rows[+tr.dataset.row]; opts.onRow(rows[+tr.dataset.row]); }));
    if (sort) host.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const order = sort.by === key && sort.order === 'desc' ? 'asc' : 'desc';
      sort.onSort(key, order);
    }));
  }, 0);
  return `<div id="${id}">${html}</div>`;
}

function statBox(label, valueHtml, subHtml = '') {
  return `<div class="stat-box"><div class="stat-label">${label}</div><div class="stat-val">${valueHtml}</div><div class="stat-sub">${subHtml}</div></div>`;
}

function fnLinks(sec, current) {
  const fns = sec.type === 'INDEX' ? ['DES', 'GP', 'HP', 'HVT', 'MEMB', 'COMP'] :
    sec.type === 'SET' ? ['DES', 'GP', 'HP', 'HVT', 'DRSK', 'RV', 'MEMB', 'CN', 'COMP'] :
      sec.type === 'SEALED' ? ['DES', 'GP', 'HP', 'QR', 'ALLQ', 'HVT', 'DRSK', 'RV', 'CN', 'COMP'] :
        ['DES', 'GP', 'HP', 'QR', 'HVT', 'DRSK', 'RV', 'CN', 'COMP'];
  return `<div class="chart-controls" style="padding:4px 8px;border-bottom:1px solid #222">
    <span style="color:#888;font-size:10px;margin-right:6px">RELATED:</span>
    ${fns.map(f => `<button class="bbg-tab-btn ${f === current ? 'on' : ''}" data-go="${f}">${f}</button>`).join('')}
    <button class="bbg-tab-btn" data-alert="1">+ ALRT</button></div>`;
}

function bindFnLinks(sec) {
  screenEl().querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => runFunction(b.dataset.go, secQuery(sec))));
  screenEl().querySelectorAll('[data-alert]').forEach(b => b.addEventListener('click', () => runFunction('ALRT', secQuery(sec))));
}

function secQuery(sec) { return sec.type === 'INDEX' || sec.type === 'SET' ? sec.id : (sec.ticker || sec.id); }
function secLabel(sec) { return sec.ticker ? `${sec.ticker}  ${sec.name}` : sec.code ? `${sec.code}  ${sec.name}` : sec.name; }

// ------------------------------------------------------------------ navigation
async function runFunction(fn, query = '', pushHist = true) {
  fn = (fn || 'WEI').toUpperCase();
  const scr = SCREENS[fn];
  if (!scr) { msg(`UNKNOWN FUNCTION ${fn}. TYPE HELP <GO>.`, true); return; }
  // Security functions never dead-end: with nothing loaded they open on the
  // composite index, and from then on they follow the last security touched,
  // which is how the real terminal feels (DES <GO> always shows something).
  let defaultHint = null;
  if (scr.needsSecurity && !query && !STATE.security) {
    query = 'MTGCOMP';
    defaultHint = `NO SECURITY LOADED — SHOWING MTGCOMP. TYPE A NAME OR TICKER (E.G. MH3 PBX ${fn} <GO>), OR CLICK ANY ROW.`;
  }
  if (scr.needsSecurity && !query) query = secQuery(STATE.security);
  if (pushHist) {
    STATE.history = STATE.history.slice(0, STATE.hIdx + 1);
    STATE.history.push({ fn, query });
    STATE.hIdx = STATE.history.length - 1;
  }
  STATE.current = { fn, query };
  STATE.menu = [];
  document.querySelectorAll('#navBar .bbg-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.fn === fn));
  const host = screenEl();
  host.innerHTML = `<div class="bbg-panel"><div class="bbg-panel-header"><div class="bbg-panel-title"><span class="code">${fn}</span> LOADING…</div></div></div>`;
  msg('');
  try {
    await scr.render(host, query);
    const held = document.getElementById('msgLine').textContent || '';
    if (defaultHint) msg(defaultHint);
    else if (STATE.menu.length && !held.startsWith('STATIC BUNDLE')) msg(`${STATE.menu.length} NUMBERED ITEMS ON SCREEN — TYPE A NUMBER <GO> TO OPEN`);
  } catch (e) {
    console.error(e);
    if (STATE.static && /NOT IN STATIC BUNDLE/i.test(String(e.message || ''))) {
      await renderOffline(host, fn, query);
    } else {
      host.innerHTML = panel(`<span class="code">${fn}</span> ERROR`, `<div class="bbg-note warn">${esc(e.message || e)}</div>`);
      msg(String(e.message || e).toUpperCase(), true);
    }
  }
  window.scrollTo(0, 0);
}

// No dead ends in the offline bundle: when a query was not pre-baked, show a
// proper screen with what IS known (catalog entry) and clickable alternatives,
// never a raw error. Everything suggested here comes from secf_catalog.json,
// whose entries are guaranteed to resolve in this bundle.
async function renderOffline(host, fn, query) {
  await secfCatalog();
  const q = String(query || '').trim();
  const ql = q.toLowerCase();
  const exact = (SECF_CATALOG || []).find(c => c.id === q || String(c.ticker || '').toLowerCase() === ql || String(c.name || '').toLowerCase() === ql);
  // The click that got us here usually carried a data row (movers, members,
  // screeners). Use it: a mini-description beats an empty apology.
  const lr = STATE.lastRow;
  const row = lr && [lr.uuid, lr.ticker, lr.set_code, lr.code].includes(q) ? lr : null;
  const rowPrice = row ? (row.price ?? row.best_price ?? row.tcg_price ?? row.idx_level ?? row.level) : null;
  const rowChg = row ? (row.chg ?? row.chg_1d ?? row.chg_1w ?? row.chg_1m) : null;
  const facts = row ? [row.rarity ? String(row.rarity).toUpperCase() : '', row.is_reserved ? 'RESERVED LIST' : '',
    row.display_category || '', row.era || '', row.release_date ? String(row.release_date).slice(0, 10) : ''].filter(Boolean).join(' · ') : '';
  let info = '';
  if (row) {
    info = `<div class="bbg-sec-summary-grid">
      ${statBox('SECURITY', esc(row.name || row.ticker || q), esc(row.set_code || row.set_name || row.ticker || ''))}
      ${statBox('LAST (FROM THE SCREEN YOU CAME FROM)', row.idx_level != null || row.level != null ? num(rowPrice) : px(rowPrice), 'same nightly build as everything else')}
      ${statBox('CHANGE', isNum(rowChg) ? pct(rowChg) : '<span class="val-na">n/a</span>', esc(facts || ''))}
    </div>`;
  } else if (exact) {
    info = `<div class="bbg-sec-summary-grid">
      ${statBox('SECURITY', esc(exact.name || ''), `${esc(exact.type || '')} · ${esc(exact.ticker || '')}`)}
      ${statBox('CATEGORY', esc(exact.sub || 'n/a'), '')}
      ${statBox('LAST KNOWN', exact.type === 'INDEX' || exact.type === 'SET' ? num(exact.price) : px(exact.price), 'from the offline catalog')}
    </div>`;
  }
  const nearKey = (row && row.name) || (exact && exact.name) || q;
  const near = nearKey ? (await secfLocal(nearKey, 8)).results.filter(c => (!exact || c.id !== exact.id) && c.id !== q) : [];
  const nearRows = near.length ? table([
    { key: 'type', label: 'Type', left: true, fmt: v => `<span class="secf-type">${esc(v)}</span>` },
    { key: 'ticker', label: 'Ticker / Id', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` },
    { key: 'name', label: 'Name', left: true }, { key: 'sub', label: 'Category', left: true },
    { key: 'price', label: 'Last', fmt: v => num(v) }],
    near, { menu: true, onRow: (row) => runFunction('DES', row.type === 'CARD' ? row.id : (row.ticker || row.id)) }) : '';
  host.innerHTML = panel(`<span class="code">${fn}</span> OFFLINE COPY — PAGE NOT PRE-BAKED`, `
    ${info}
    <div class="bbg-note">This is the static bundle: it pre-bakes the default views plus the top securities, and
    <b>${esc(fn)}${q ? ' ' + esc(q) : ''}</b> was not among them. Nothing is wrong with the security; the page simply
    is not in this offline copy. On the MacBook (live server, or the next nightly export) it resolves normally.</div>
    ${near.length ? `<div class="top-section-head">Available in this bundle ${exact ? '— related to ' + esc(exact.name || q) : '— closest matches'}</div>${nearRows}` : ''}
    <div class="chart-controls" style="padding:6px 8px">
      <button class="bbg-tab-btn" data-off="WEI">WEI INDICES</button>
      <button class="bbg-tab-btn" data-off="MOV">MOV MOVERS</button>
      <button class="bbg-tab-btn" data-off="SECF">SECF FINDER</button>
      <button class="bbg-tab-btn" data-off="HELP">HELP</button>
    </div>`);
  host.querySelectorAll('[data-off]').forEach(b => b.addEventListener('click', () => runFunction(b.dataset.off, b.dataset.off === 'SECF' ? q : '')));
  msg(`NOT PRE-BAKED IN THE OFFLINE BUNDLE — ${STATE.menu.length ? STATE.menu.length + ' ALTERNATIVES ON SCREEN' : 'USE SECF OR THE LIVE SERVER'}`);
}

function navHistory(delta) {
  const i = STATE.hIdx + delta;
  if (i < 0 || i >= STATE.history.length) { msg('NO PAGE IN THAT DIRECTION'); return; }
  STATE.hIdx = i;
  const h = STATE.history[i];
  runFunction(h.fn, h.query, false);
}

async function executeCommand(raw) {
  const text = (raw || '').trim();
  if (!text) return;
  hideSecf();
  document.getElementById('cmdInput').value = '';
  let parsed;
  if (!STATE.static) {
    try { parsed = await apiFetch('/api/command', {}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: text }) }); }
    catch (e) { parsed = null; }
  }
  if (!parsed) parsed = parseCommandLocal(text);
  if (parsed.action === 'MENU_ITEM') {
    const it = STATE.menu[parsed.index - 1];
    if (it) it.run(); else msg(`NO ITEM ${parsed.index} ON THIS SCREEN`, true);
    return;
  }
  if (parsed.action === 'FUNCTION') runFunction(parsed.function, parsed.query);
}

const FN_ALIASES = { LEAD: 'MOV', LAGG: 'MOV', MOVERS: 'MOV', BOARD: 'COMMOD', CAL: 'ECO', CALENDAR: 'ECO', SEALED: 'EQS', SCREEN: 'EQS',
  SINGLES: 'CARDS', RL: 'CARDS', GIP: 'GP', CHART: 'GP', GPO: 'GP', BQ: 'QR', Q: 'QR', QUOTE: 'QR', GPC: 'COMP', HVG: 'HVT', RISK: 'DRSK',
  NEWS: 'TOP', N: 'TOP', PRTU: 'PORT', NAV: 'PORT', ALERT: 'ALRT', ALERTS: 'ALRT', SEARCH: 'SECF', FIND: 'SECF', '?': 'HELP', MENU: 'HELP',
  LAUNCH: 'LP', PAD: 'LP', GRID: 'LP', DEPTH: 'ALLQ', MBO: 'ALLQ', ASKS: 'ALLQ', BOOK: 'ALLQ',
  FLAVOR: 'FLAV', FT: 'FLAV', QOTD: 'FLAV', DECKLIST: 'DECK', PRICEDECK: 'DECK', CORREL: 'CORR', BETA: 'CORR', QUILT: 'GRR' };
function parseCommandLocal(text) {
  const t = text.replace(/<\s*GO\s*>/gi, ' ').replace(/\s+GO$/i, '').trim();
  const tokens = t.split(/\s+/);
  const up = tokens.map(x => x.toUpperCase());
  const isFn = (x) => SCREENS[x] || FN_ALIASES[x];
  const norm = (x) => SCREENS[x] ? x : FN_ALIASES[x];
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) return { action: 'MENU_ITEM', index: +tokens[0] };
  if (tokens.length === 1 && isFn(up[0])) return { action: 'FUNCTION', function: norm(up[0]), query: '' };
  if (isFn(up[0]) && !(SCREENS[norm(up[0])] || {}).needsSecurity) return { action: 'FUNCTION', function: norm(up[0]), query: tokens.slice(1).join(' ') };
  if (isFn(up[up.length - 1])) return { action: 'FUNCTION', function: norm(up[up.length - 1]), query: tokens.slice(0, -1).join(' ') };
  if (isFn(up[0])) return { action: 'FUNCTION', function: norm(up[0]), query: tokens.slice(1).join(' ') };
  return { action: 'FUNCTION', function: 'DES', query: t };
}

// ------------------------------------------------------------------ finder (SECF autocomplete)
// In static mode the finder runs client-side over data/api/secf_catalog.json,
// baked by the exporter, so search works on GitHub Pages without a backend.
let SECF_CATALOG = null;
async function secfCatalog() {
  if (SECF_CATALOG) return SECF_CATALOG;
  // no-store: the catalog is rebuilt by the nightly export and F5 is the DECK
  // key (browser refresh is Ctrl+F5), so never let a stale copy be cached
  try { const r = await fetch('data/api/secf_catalog.json', { cache: 'no-store' }); SECF_CATALOG = r.ok ? await r.json() : []; }
  catch (e) { SECF_CATALOG = []; }
  return SECF_CATALOG;
}
async function secfLocal(q, limit) {
  await secfCatalog();
  const needle = q.toLowerCase().trim();
  const terms = needle.split(/\s+/);
  const scored = [];
  for (const it of (SECF_CATALOG || [])) {
    const hay = `${it.ticker || ''} ${it.name || ''} ${it.sub || ''}`.toLowerCase();
    let sc = -1;
    if (hay.startsWith(needle)) sc = 0;
    else { const i = hay.indexOf(needle); if (i >= 0) sc = 1 + i / 1000; else if (terms.every(t => hay.includes(t))) sc = 5; }
    if (sc >= 0) scored.push([sc, it]);
  }
  scored.sort((a, b) => a[0] - b[0] || (b[1].price || 0) - (a[1].price || 0));
  return { results: scored.slice(0, limit).map(x => x[1]) };
}
let secfTimer = null, secfItems = [], secfIdx = -1;
function hideSecf() { document.getElementById('secfDrop').hidden = true; secfIdx = -1; }
async function showSecf(q) {
  const drop = document.getElementById('secfDrop');
  if (!q || q.length < 2) { hideSecf(); return; }
  try {
    const r = STATE.static ? await secfLocal(q, 10) : await apiFetch('/api/secf', { q, limit: 10 });
    secfItems = r.results || [];
    if (!secfItems.length) { hideSecf(); return; }
    drop.innerHTML = secfItems.map((it, i) => `<div class="secf-row" data-i="${i}">
      <span class="secf-type">${it.type}</span><span class="secf-ticker">${esc(it.ticker)}</span>
      <span class="secf-name">${esc(it.name)}</span><span class="secf-sub">${esc(it.sub || '')}</span>
      <span class="secf-px">${isNum(it.price) ? fmtNum(it.price) : ''}</span></div>`).join('');
    drop.hidden = false;
    drop.querySelectorAll('.secf-row').forEach(row => row.addEventListener('mousedown', (e) => { e.preventDefault(); pickSecf(+row.dataset.i); }));
  } catch (e) { hideSecf(); }
}
function pickSecf(i) {
  const it = secfItems[i];
  if (!it) return;
  hideSecf();
  const input = document.getElementById('cmdInput');
  const trailing = (input.value.trim().split(/\s+/).pop() || '').toUpperCase();
  const fn = SCREENS[trailing] && SCREENS[trailing].needsSecurity ? trailing : 'DES';
  input.value = '';
  runFunction(fn, it.type === 'CARD' ? it.id : (it.ticker || it.id));
}

// ------------------------------------------------------------------ screens
const SCREENS = {};

SCREENS.HELP = { name: 'Function Directory', render: async (host) => {
  const h = await apiFetch('/api/help');
  const groups = {};
  h.functions.forEach(f => (groups[f.group] = groups[f.group] || []).push(f));
  let n = 0;
  const html = Object.entries(groups).map(([g, fns]) => `<div class="help-group"><h4>${g}</h4>${fns.map(f => {
    n += 1; STATE.menu.push({ label: f.code, run: () => runFunction(f.code, f.security ? (STATE.security ? secQuery(STATE.security) : '') : '') });
    return `<div class="help-fn" data-fn="${f.code}"><span class="menu-num">${n})</span><span class="code">${f.code}</span><span class="desc">${esc(f.name)} — ${esc(f.desc)}${f.aliases ? ` <span class="val-na">(${f.aliases.join(', ')})</span>` : ''}</span></div>`;
  }).join('')}</div>`).join('');
  host.innerHTML = panel(fnTitle('HELP', 'FUNCTION DIRECTORY'), `<div class="help-grid">${html}</div>
    <div class="bbg-note">GRAMMAR: ${h.grammar.map(esc).join(' &nbsp;|&nbsp; ')}</div>
    <div class="bbg-note">${esc(h.provenance)}</div>`);
  host.querySelectorAll('.help-fn').forEach(el => el.addEventListener('click', () => runFunction(el.dataset.fn, STATE.security ? secQuery(STATE.security) : '')));
} };

SCREENS.SECF = { name: 'Security Finder', render: async (host, q) => {
  const r = q ? (STATE.static ? await secfLocal(q, 30) : await apiFetch('/api/secf', { q, limit: 30 })) : { results: [] };
  const cols = [
    { key: 'type', label: 'Type', left: true, fmt: v => `<span class="secf-type">${v}</span>` },
    { key: 'ticker', label: 'Ticker / Id', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` },
    { key: 'name', label: 'Name', left: true }, { key: 'sub', label: 'Category', left: true },
    { key: 'price', label: 'Last', fmt: v => num(v) }];
  host.innerHTML = panel(fnTitle('SECF', 'SECURITY FINDER', q), `
    <div class="bbg-filters"><label>QUERY</label><input id="secfQ" class="bbg-filter-input wide" value="${esc(q)}" placeholder="set code, ticker, card name…"><button class="bbg-mini" id="secfGo">FIND</button>
    <label style="margin-left:12px">EXAMPLES: MH3 · MH3 PBX · LTR CBX · BLACK LOTUS · MTGRL · FOUNDATIONS</label></div>
    ${table(cols, r.results || [], { menu: true, onRow: (row) => runFunction('DES', row.type === 'CARD' ? row.id : (row.ticker || row.id)) })}`);
  const go = () => runFunction('SECF', host.querySelector('#secfQ').value);
  host.querySelector('#secfGo').addEventListener('click', go);
  host.querySelector('#secfQ').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  host.querySelector('#secfQ').focus();
} };

// Fill horizons the baked analytics left null by recomputing from the full
// daily series (same data the GP charts draw), symmetric +/-5d tolerance.
// This cannot invent data: a horizon older than the history stays n/a.
async function weiFillHorizons(w) {
  if (w._filled) return w;
  // Archival estimates (Wayback Scryfall snapshot): fills 1Y where the daily
  // lake is too young. Flagged per-row (est_1y) and rendered as ~x% in amber.
  try {
    const ar = await fetch('data/api/wei_archival.json').then(r => r.ok ? r.json() : null);
    if (ar && ar.horizons) {
      const anchors = [];
      for (const [hz, block] of Object.entries(ar.horizons)) {
        let used = false;
        for (const idx of w.indices) {
          const e = (block.indices || {})[idx.code];
          if (e && !isNum(idx[hz]) && isNum(e.est)) {
            idx[hz] = e.est;
            idx[`est_${hz.slice(4)}`] = true;
            idx[`est_cov_${hz.slice(4)}`] = e.coverage;
            idx[`est_info_${hz.slice(4)}`] = `${e.n} members matched, ${e.coverage}% of basket value, anchor ${block.anchor}`;
            used = true;
          }
        }
        if (used) anchors.push(`${hz.slice(4).toUpperCase()} vs ${block.anchor}`);
      }
      if (anchors.length) w._archival_note = `Values marked ~ are archival estimates from tcgcsv.com daily TCGplayer archives (${anchors.join(', ')}): current top members repriced per matched product, value-weighted, 10% cap, outliers dropped. Amber = matched members carry at least half the basket's value; dimmed with a %cov tag = thinner match, read with care. The exact daily splice arrives with the MacBook backfill.`;
    } else if (ar && ar.indices) {
      for (const idx of w.indices) {
        const e = ar.indices[idx.code];
        if (e && !isNum(idx.chg_1y) && isNum(e.est)) { idx.chg_1y = e.est; idx.est_1y = true; idx.est_info_1y = `${e.n} members matched, ${e.coverage}% of basket value, anchor ${ar.anchor}`; }
      }
      w._archival_note = `1Y values marked ~ are archival estimates anchored ${ar.anchor}.`;
    }
  } catch (e) { /* no archival file: nothing to fill */ }
  const spans = { chg_3m: 91, chg_6m: 182, chg_1y: 365 };
  await Promise.all(w.indices.map(async (idx) => {
    const missing = Object.keys(spans).filter(k => !isNum(idx[k]));
    const needYtd = !isNum(idx.chg_ytd);
    if (!missing.length && !needYtd) return;
    let pts;
    try {
      const ch = await apiFetch(`/api/chart/${idx.code}`, { range: 'ALL' });
      const s = (ch.series || []).find(x => x.axis !== 'R') || ch.series[0];
      pts = (s.points || []).map(p => [String(p.d || p.date || p[0]).slice(0, 10), p.v ?? p.value ?? p[1]]).filter(p => isNum(p[1]));
    } catch (e) { return; }
    if (pts.length < 2) return;
    const last = pts[pts.length - 1];
    const lastMs = Date.parse(last[0]);
    const at = (targetMs, tolDays) => {
      let before = null, after = null;
      for (const [d, v] of pts) {
        const ms = Date.parse(d);
        if (ms <= targetMs && ms >= targetMs - tolDays * 86400000) before = v;
        else if (ms > targetMs && ms <= targetMs + tolDays * 86400000 && ms < lastMs && after === null) after = v;
      }
      return before ?? after;
    };
    for (const k of missing) {
      const ref = at(lastMs - spans[k] * 86400000, 5);
      if (isNum(ref) && ref > 0) idx[k] = Math.round((last[1] / ref - 1) * 10000) / 100;
    }
    if (needYtd) {
      const jan1 = Date.parse(`${last[0].slice(0, 4)}-01-01`);
      const ref = at(jan1, 5);
      if (isNum(ref) && ref > 0 && pts[0] && Date.parse(pts[0][0]) <= jan1 + 5 * 86400000) {
        idx.chg_ytd = Math.round((last[1] / ref - 1) * 10000) / 100;
      }
    }
  }));
  w._filled = true;
  return w;
}
function estPct(v, row, hz) {
  if (row[`est_${hz}`] && isNum(v)) {
    const cov = row[`est_cov_${hz}`];
    const cls = v > 0 ? 'val-up' : v < 0 ? 'val-down' : 'val-flat';
    const val = `<span class="${cls}" style="font-style:italic">~${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%</span>`;
    const tip = esc(row[`est_info_${hz}`] || 'archival estimate');
    // sign colouring like every other % cell; the ~ marks it as an estimate.
    // Coverage lives in the hover tooltip only, by decision 2026-09-02.
    return `<span title="${tip}">${val}</span>`;
  }
  return pct(v);
}
SCREENS.WEI = { name: 'World MTG Indices', render: async (host) => {
  const w = await weiFillHorizons(await apiFetch('/api/wei'));
  STATE.wei = w;
  const fam = (f) => w.indices.filter(i => i.family === f);
  const cols = [
    { key: 'code', label: 'Code', left: true, fmt: v => `<span class="sec-code">${v}</span>` },
    { key: 'name', label: 'Index', left: true },
    { key: 'level', label: 'Level', fmt: v => `<span class="sec-price">${fmtNum(v, 2)}</span>` },
    { key: 'chg_1d', label: '1D', fmt: pct }, { key: 'chg_1w', label: '1W', fmt: pct }, { key: 'chg_1m', label: '1M', fmt: pct },
    { key: 'chg_3m', label: '3M', fmt: pct }, { key: 'chg_6m', label: '6M', fmt: (v, row) => estPct(v, row, '6m') }, { key: 'chg_ytd', label: 'YTD', fmt: (v, row) => estPct(v, row, 'ytd') }, { key: 'chg_1y', label: '1Y', fmt: (v, row) => estPct(v, row, '1y') },
    { key: 'hi_since', label: 'Hi', fmt: v => num(v) }, { key: 'lo_since', label: 'Lo', fmt: v => num(v) },
    { key: 'n', label: 'Members', fmt: v => num(v, 0) }, { key: 'history_start', label: 'Since', left: true },
    { key: 'sparkline', label: '30D', fmt: (v, r) => `<canvas class="spark" data-code="${r.code}" width="90" height="16" style="width:90px;height:16px"></canvas>` }];
  const onRow = (r) => runFunction('DES', r.code);
  host.innerHTML = panel(fnTitle('WEI', 'WORLD MTG INDICES'), `
    <div style="padding:3px 8px;color:#888;font-size:10px">SINGLES INDICES (TCGPLAYER MARKET, VALUE-WEIGHTED, BASE 1000 = ${esc(fam('SINGLES')[0]?.history_start || '')})</div>
    ${table(cols, fam('SINGLES'), { menu: true, onRow })}
    <div style="padding:3px 8px;color:#888;font-size:10px;border-top:1px solid #222">SEALED INDICES (PRICE LAKE, BASE 1000 = ${esc(fam('SEALED')[0]?.history_start || '')})</div>
    ${table(cols, fam('SEALED'), { menu: true, onRow })}
    <div class="bbg-note">${esc(w.note)}</div>${w._archival_note ? `<div class="bbg-note" style="color:var(--amber)">${esc(w._archival_note)}</div>` : ''}`, { asof: w.indices[0]?.as_of });
  setTimeout(() => host.querySelectorAll('canvas.spark').forEach(c => { const i = w.indices.find(x => x.code === c.dataset.code); drawSparkline(c, i?.sparkline); }), 0);
} };

SCREENS.MOV = { name: 'Movers', render: async (host, q) => {
  const p = STATE.tables.mov || { horizon: '1w', universe: 'singles', min_price: 5 };
  if (q) { const t = q.toLowerCase().split(/\s+/); t.forEach(x => { if (/^(1d|1w|1m|3m|6m|1y)$/.test(x)) p.horizon = x; if (/^(singles|sealed|sets)$/.test(x)) p.universe = x; }); }
  STATE.tables.mov = p;
  let r;
  try { r = await apiFetch('/api/movers', p); }
  catch (e) {
    if (!STATE.static) throw e;
    p.min_price = 5;
    r = await apiFetch('/api/movers', { horizon: p.horizon, universe: p.universe, min_price: 5 });
    msg('STATIC BUNDLE: ONLY MIN $5 VIEWS ARE PRE-BAKED — SHOWING THE DEFAULT');
  }
  const isSets = p.universe === 'sets', isSealed = p.universe === 'sealed';
  const cols = [
    { key: 'ticker', label: isSets ? 'Set' : isSealed ? 'Ticker' : 'Card', left: true, fmt: (v, row) => `<span class="sec-code">${esc(isSets ? row.set_code : isSealed ? v : row.name)}</span>` },
    { key: 'name', label: isSets ? 'Name' : isSealed ? 'Product' : 'Set', left: true, fmt: (v, row) => esc(isSealed || isSets ? v : row.set_code) },
    { key: 'price', label: isSets ? 'Level' : 'Price', fmt: v => isSets ? num(v) : px(v) },
    { key: 'chg', label: `${p.horizon.toUpperCase()} %`, fmt: pct }];
  if (!isSets && !isSealed) cols.push({ key: 'rarity', label: 'Rarity', left: true }, { key: 'is_reserved', label: 'RL', fmt: yes });
  if (isSealed) cols.push({ key: 'display_category', label: 'Category', left: true });
  const onRow = (row) => runFunction('DES', isSets ? row.set_code : row.uuid);
  const ctl = `<select id="movH" class="bbg-select">${['1d', '1w', '1m', '3m', '6m', '1y'].map(h => `<option value="${h}" ${h === p.horizon ? 'selected' : ''}>${h.toUpperCase()}</option>`).join('')}</select>
    <select id="movU" class="bbg-select">${['singles', 'sealed', 'sets'].map(u => `<option value="${u}" ${u === p.universe ? 'selected' : ''}>${u.toUpperCase()}</option>`).join('')}</select>
    <label style="color:#888;font-size:10px">MIN $</label><input id="movP" class="bbg-filter-input" style="width:60px" value="${p.min_price}">`;
  host.innerHTML = panel(fnTitle('MOV', `MOVERS — ${p.universe.toUpperCase()} ${p.horizon.toUpperCase()}`), `
    ${r.proxy ? `<div class="bbg-note proxy">${esc(r.note)}</div>` : `<div class="bbg-note">${esc(r.note)}</div>`}
    <div class="grid-2" style="padding:6px">
      <div class="bbg-panel" style="border-color:#00ff66"><div class="bbg-panel-header" style="background:#001a0a"><span style="color:#00ff66;font-weight:bold">▲ LEADERS</span></div>${table(cols, r.leaders, { menu: true, onRow })}</div>
      <div class="bbg-panel" style="border-color:#ff3333"><div class="bbg-panel-header" style="background:#1a0000"><span style="color:#ff3333;font-weight:bold">▼ LAGGARDS</span></div>${table(cols, r.laggards, { menu: true, onRow })}</div>
    </div>`, { controls: ctl });
  const rerun = () => { p.horizon = host.querySelector('#movH').value; p.universe = host.querySelector('#movU').value; p.min_price = +host.querySelector('#movP').value || 0; runFunction('MOV', '', false); };
  host.querySelector('#movH').addEventListener('change', rerun); host.querySelector('#movU').addEventListener('change', rerun);
  host.querySelector('#movP').addEventListener('change', rerun);
} };

let commodMini = null;
SCREENS.COMMOD = { name: 'Sealed Commodity Board', render: async (host) => {
  const c = await apiFetch('/api/commod');
  const today = new Date().toISOString().slice(0, 10);
  const spotCols = [
    { key: 'ticker', label: 'Ticker', left: true, fmt: (v, r) => `<span class="sec-code">${esc(v)}</span>${r.release_date > today ? '<span class="pill">PRE-ORDER</span>' : ''}` },
    { key: 'name', label: 'Product', left: true }, { key: 'best_price', label: 'Last', fmt: v => px(v) },
    { key: 'chg_1d', label: '1D', fmt: pct }, { key: 'set_idx_chg_1w', label: 'SetIdx 1W', fmt: pct }, { key: 'set_idx_chg_1m', label: 'SetIdx 1M', fmt: pct }];
  const evCols = [
    { key: 'ticker', label: 'Ticker', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` },
    { key: 'best_price', label: 'Box', fmt: v => px(v) }, { key: 'box_ev', label: 'EV', fmt: v => `<span class="sec-ev">${px(v)}</span>` },
    { key: 'ev_ratio', label: 'P/EV', fmt: v => isNum(v) ? v.toFixed(2) + 'x' : 'n/a' }, { key: 'sealed_premium_pct', label: 'Prem', fmt: pct },
    { key: 'rating', label: 'Rating', left: true, fmt: v => `<span style="color:${v === 'BELOW EV' ? '#00ff66' : v === 'FAIR' ? '#ffff00' : v === 'RICH' ? '#ff9900' : '#cc66ff'};font-weight:bold">${v}</span>` }];
  const fxCols = [
    { key: 'set_code', label: 'Set', left: true, fmt: v => `<span class="sec-code">${v}</span>` }, { key: 'set_name', label: 'Name', left: true },
    { key: 'n_cards', label: 'N', fmt: v => num(v, 0) }, { key: 'median_premium_pct', label: 'EU Prem (med)', fmt: pct }, { key: 'p25', label: 'P25', fmt: pct }, { key: 'p75', label: 'P75', fmt: pct }];
  const statCols = [{ key: 'metric', label: 'Metric', left: true }, { key: 'value', label: 'Value', fmt: v => `<span class="sec-price">${esc(v)}</span>` }, { key: 'detail', label: 'Detail', left: true, fmt: v => `<span class="val-na">${esc(v)}</span>` }];
  host.innerHTML = panel(fnTitle('COMMOD', 'SEALED COMMODITY BOARD'), `
    <div class="grid-3" style="padding:6px">
      ${panel('<span class="code">1)</span> SPOT BENCHMARKS', table(spotCols, c.contracts, { onRow: (r) => { selectMini(r); }, maxHeight: '300px' }))}
      ${panel('<span class="code">2)</span> <span id="miniTitle">PRICE HISTORY (GP)</span>', '<div class="chart-box mini"><canvas id="miniGP"></canvas></div><div class="bbg-note" id="miniNote">Click a benchmark row.</div>')}
      ${panel('<span class="code">3)</span> AGING CURVE — MEDIAN BOX PRICE BY AGE (LOG)', '<div class="chart-box mini"><canvas id="agingChart"></canvas></div><div class="bbg-note">Cross-section of priced draft/set/play booster boxes today, not a time series. Bars = median, label = n.</div>')}
      ${panel('<span class="code">4)</span> BOX EV ARBITRAGE (OMON)', table(evCols, c.ev_arbitrage, { onRow: (r) => runFunction('DES', r.ticker), maxHeight: '300px' }) + '<div class="bbg-note">EV from the collation model at live Scryfall prices (draft/set/play boxes only).</div>')}
      ${panel(`<span class="code">5)</span> CROSS-MARKET (FXIP) — EURUSD ${c.fx.eurusd} ${esc(c.fx.eurusd_date || '')}`, table(fxCols, c.fx.by_set, { onRow: (r) => runFunction('DES', r.set_code), maxHeight: '300px' }) + `<div class="bbg-note">Median Cardmarket premium over TCGplayer across ${num(c.fx.n_cards, 0)} cards: ${pctPlain(c.fx.overall_median_premium_pct)}. Full table: FXIP &lt;GO&gt;</div>`)}
      ${panel('<span class="code">6)</span> MARKET STATS', table(statCols, c.market_stats, { maxHeight: '300px' }))}
    </div>`);
  const aging = new TermBars('agingChart', { logScale: true, valueFormat: v => '$' + fmtNum(v, 0) });
  aging.setData(c.aging_curve.map(b => ({ label: b.bucket, value: b.median_price, sub: `n=${b.n}` })));
  commodMini = new TermChart('miniGP', { showMA: false, padTop: 22 });
  async function selectMini(r) {
    host.querySelector('#miniTitle').textContent = `PRICE HISTORY (GP) — ${r.ticker}`;
    let ch;
    try { ch = await apiFetch(`/api/chart/${r.ticker}`, { range: 'ALL' }); }
    catch (e) { host.querySelector('#miniNote').textContent = `${r.ticker}: chart not pre-baked in this offline copy.`; return; }
    commodMini.setSeries(ch.series.filter(s => s.axis !== 'R'));
    host.querySelector('#miniNote').innerHTML = `${esc(r.name)}: ${ch.stats.points || 0} observation(s) ${esc(ch.stats.from || '')} → ${esc(ch.stats.to || '')}. Open GP &lt;GO&gt; for the set-index overlay.`;
    STATE.security = ch.security;
  }
  if (c.contracts.length) selectMini(c.contracts[0]);
} };

function screenerFilters(defs, p) {
  return `<div class="bbg-filters">${defs.map(d => {
    if (d.type === 'select') return `<label>${d.label}</label><select class="bbg-select" data-f="${d.key}">${d.options.map(o => `<option value="${o[0]}" ${String(p[d.key] ?? '') === String(o[0]) ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>`;
    if (d.type === 'check') return `<label><input type="checkbox" data-f="${d.key}" ${p[d.key] ? 'checked' : ''}> ${d.label}</label>`;
    return `<label>${d.label}</label><input class="bbg-filter-input ${d.wide ? 'wide' : ''}" data-f="${d.key}" value="${esc(p[d.key] ?? '')}" placeholder="${d.ph || ''}">`;
  }).join('')}<button class="bbg-mini" data-apply="1">APPLY</button><button class="bbg-mini" data-reset="1">RESET</button></div>`;
}
function bindScreener(host, p, fn, defaults) {
  const apply = () => {
    host.querySelectorAll('[data-f]').forEach(el => { p[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; });
    p.offset = 0; runFunction(fn, '', false);
  };
  host.querySelector('[data-apply]').addEventListener('click', apply);
  host.querySelector('[data-reset]').addEventListener('click', () => { Object.assign(p, defaults, { offset: 0 }); runFunction(fn, '', false); });
  host.querySelectorAll('input[data-f]').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); }));
  host.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => { p.offset = Math.max(0, (p.offset || 0) + (+b.dataset.page) * p.limit); runFunction(fn, '', false); }));
}
function pager(r, p) {
  const from = (p.offset || 0) + 1, to = (p.offset || 0) + r.returned;
  return `<div class="bbg-pager"><button data-page="-1">◀ PREV</button><span>${from}–${to} OF ${fmtNum(r.total, 0)}</span><button data-page="1">NEXT ▶</button>${STATE.static ? '<span class="val-na">STATIC BUNDLE: filters and sorting limited to the pre-baked default view</span>' : ''}</div>`;
}

const EQS_DEFAULTS = { category: 'ALL', era: 'ALL', search: '', min_price: '', max_price: '', has_ev: false, priced_only: true, sort_by: 'best_price', order: 'desc', limit: 100, offset: 0 };
SCREENS.EQS = { name: 'Sealed Screener', render: async (host, q) => {
  const p = STATE.tables.eqs || (STATE.tables.eqs = { ...EQS_DEFAULTS });
  if (q) { p.search = q; p.offset = 0; }
  let r;
  try { r = await apiFetch('/api/sealed', p); }
  catch (e) {
    if (!STATE.static) throw e;
    Object.assign(p, EQS_DEFAULTS);
    r = await apiFetch('/api/sealed', p);
    msg('STATIC BUNDLE: FREE-TEXT FILTERS NEED THE LIVE SERVER — DEFAULT VIEW SHOWN');
  }
  const eras = [['ALL', 'ALL ERAS'], ['VINTAGE_ERA', 'VINTAGE 1993-2002'], ['CLASSIC_MODERN', 'CLASSIC MODERN 2003-11'], ['PIONEER_ERA', 'PIONEER 2012-18'], ['COLLECTOR_ERA', 'COLLECTOR 2019-22'], ['CURRENT_EXPANSION', 'CURRENT 2023+'], ['UNIVERSES_BEYOND', 'UNIVERSES BEYOND']];
  const filters = screenerFilters([
    { key: 'category', label: 'CATEGORY', type: 'select', options: [['ALL', 'ALL CATEGORIES'], ...(r.categories || []).map(c => [c, c.toUpperCase()])] },
    { key: 'era', label: 'ERA', type: 'select', options: eras },
    { key: 'search', label: 'SEARCH', wide: true, ph: 'set, name, ticker' },
    { key: 'min_price', label: 'MIN $', ph: '0' }, { key: 'max_price', label: 'MAX $', ph: '' },
    { key: 'has_ev', label: 'HAS EV', type: 'check' }, { key: 'priced_only', label: 'PRICED ONLY', type: 'check' }], p);
  const cols = [
    { key: 'ticker', label: 'Ticker', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` },
    { key: 'name', label: 'Product', left: true, fmt: v => `<span class="sec-name">${esc(v)}</span>` },
    { key: 'display_category', label: 'Category', left: true, fmt: v => `<span class="sec-cat">${esc(v)}</span>` },
    { key: 'release_date', label: 'Release', left: true, fmt: d10 },
    { key: 'best_price', label: 'Last', fmt: (v, r) => `<span class="sec-price">${px(v)}</span>` },
    { key: 'price_source', label: 'Src', left: true, sort: false, fmt: v => `<span class="val-na">${v === 'tcgplayer_market' ? 'TCG' : v === 'cardkingdom_retail' ? 'CK' : ''}</span>` },
    { key: 'ck_retail', label: 'CK Ret', fmt: v => px(v) }, { key: 'ck_buylist', label: 'CK Buy', fmt: v => px(v) },
    { key: 'ck_spread_pct', label: 'Spread', fmt: v => isNum(v) ? pctPlain(v) : '<span class="val-na">n/a</span>' },
    { key: 'ask_premium_pct', label: 'Ask Prem', fmt: pct },
    { key: 'chg_1d', label: '1D', fmt: pct }, { key: 'chg_1w', label: '1W', fmt: pct }, { key: 'chg_1m', label: '1M', fmt: pct },
    { key: 'set_idx_chg_1m', label: 'SetIdx 1M', fmt: pct },
    { key: 'box_ev', label: 'Box EV', fmt: v => `<span class="sec-ev">${px(v)}</span>` }, { key: 'ev_ratio', label: 'P/EV', fmt: v => isNum(v) ? v.toFixed(2) + 'x' : '<span class="val-na">n/a</span>' },
    { key: 'age_months', label: 'Age (m)', fmt: v => num(v, 0) }];
  host.innerHTML = panel(fnTitle('EQS', 'SEALED SCREENER'), filters +
    table(cols, r.data, { menu: true, onRow: (row) => runFunction('DES', row.uuid), sort: { by: p.sort_by, order: p.order, onSort: (k, o) => { p.sort_by = k; p.order = o; p.offset = 0; runFunction('EQS', '', false); } } }) +
    pager(r, p) + '<div class="bbg-note">1D/1W/1M are the product\'s own lake returns (n/a until the lake has that horizon). SetIdx = the set\'s singles index. Spread = Card Kingdom retail vs buylist. Ask Prem = TCG listed median vs market.</div>');
  bindScreener(host, p, 'EQS', EQS_DEFAULTS);
} };

const CARDS_DEFAULTS = { reserved: '', rarity: 'ALL', era: 'ALL', search: '', min_price: '', max_printings: '', sort_by: 'tcg_price', order: 'desc', limit: 100, offset: 0 };
SCREENS.CARDS = { name: 'Singles Screener', render: async (host, q) => {
  const p = STATE.tables.cards || (STATE.tables.cards = { ...CARDS_DEFAULTS });
  if (q) { if (q.toUpperCase() === 'RL') p.reserved = 'true'; else p.search = q; p.offset = 0; }
  let r;
  try { r = await apiFetch('/api/singles', p); }
  catch (e) {
    if (!STATE.static) throw e;
    Object.assign(p, CARDS_DEFAULTS);
    r = await apiFetch('/api/singles', p);
    msg('STATIC BUNDLE: FREE-TEXT FILTERS NEED THE LIVE SERVER — DEFAULT VIEW SHOWN');
  }
  const filters = screenerFilters([
    { key: 'reserved', label: 'RESERVED LIST', type: 'select', options: [['', 'ALL CARDS'], ['true', 'RL ONLY'], ['false', 'NON-RL']] },
    { key: 'rarity', label: 'RARITY', type: 'select', options: [['ALL', 'ALL'], ['mythic', 'MYTHIC'], ['rare', 'RARE'], ['uncommon', 'UNCOMMON'], ['common', 'COMMON'], ['special', 'SPECIAL']] },
    { key: 'era', label: 'ERA', type: 'select', options: [['ALL', 'ALL ERAS'], ['VINTAGE_ERA', 'VINTAGE'], ['CLASSIC_MODERN', 'CLASSIC MODERN'], ['PIONEER_ERA', 'PIONEER'], ['COLLECTOR_ERA', 'COLLECTOR'], ['CURRENT_EXPANSION', 'CURRENT'], ['UNIVERSES_BEYOND', 'UNIVERSES BEYOND']] },
    { key: 'search', label: 'SEARCH', wide: true, ph: 'card or set' }, { key: 'min_price', label: 'MIN $', ph: '0' }, { key: 'max_printings', label: 'MAX PRINTINGS', ph: '' }], p);
  const cols = [
    { key: 'name', label: 'Card', left: true, fmt: v => `<span class="sec-name">${esc(v)}</span>` },
    { key: 'set_code', label: 'Set', left: true, fmt: v => `<span class="sec-code">${v}</span>` },
    { key: 'rarity', label: 'Rarity', left: true, fmt: v => `<span style="color:#ff9900">${(v || '').toUpperCase()}</span>` },
    { key: 'is_reserved', label: 'RL', fmt: yes },
    { key: 'tcg_price', label: 'TCG Mkt', fmt: v => `<span class="sec-price">${px(v)}</span>` }, { key: 'tcg_foil', label: 'Foil', fmt: v => px(v) },
    { key: 'ck_retail', label: 'CK Ret', fmt: v => px(v) }, { key: 'ck_buylist', label: 'CK Buy', fmt: v => px(v) },
    { key: 'cm_usd', label: 'CM (USD)', fmt: v => px(v) }, { key: 'cm_premium_pct', label: 'EU Prem', fmt: pct },
    { key: 'chg_1d', label: '1D', fmt: pct }, { key: 'chg_1w', label: '1W', fmt: pct }, { key: 'chg_1m', label: '1M', fmt: pct }, { key: 'chg_3m', label: '3M', fmt: pct },
    { key: 'vol_20d', label: 'Vol20', fmt: v => isNum(v) ? pctPlain(v, 0) : '<span class="val-na">n/a</span>' },
    { key: 'printings_count', label: 'Prints', fmt: v => num(v, 0) }, { key: 'last_printing_date', label: 'Last Print', left: true, fmt: d10 }];
  host.innerHTML = panel(fnTitle('CARDS', 'SINGLES SCREENER'), filters +
    table(cols, r.data, { menu: true, onRow: (row) => runFunction('DES', row.uuid), sort: { by: p.sort_by, order: p.order, onSort: (k, o) => { p.sort_by = k; p.order = o; p.offset = 0; runFunction('CARDS', '', false); } } }) +
    pager(r, p) + '<div class="bbg-note">TCGplayer market price (non-foil, foil where foil-only). Changes use the observation within five days of the horizon. Vol20 = annualised 20-day realised volatility.</div>');
  bindScreener(host, p, 'CARDS', CARDS_DEFAULTS);
} };

// ---- security screens
async function loadSecurity(q) {
  const d = await apiFetch(`/api/security/${q}`);
  STATE.security = d.security;
  return d;
}

SCREENS.DES = { name: 'Description', needsSecurity: true, render: async (host, q) => {
  const r = await loadSecurity(q);
  const s = r.security, d = r.details || {};
  let stats = '', body = '';
  const set = r.set || {};
  if (s.type === 'SEALED') {
    stats = statBox('LAST', px(d.best_price), `${d.price_source === 'tcgplayer_market' ? 'TCGplayer market' : 'Card Kingdom retail'} ${esc(d10(d.price_date))}`) +
      statBox('1D / 1W / 1M (OWN)', `${pct(d.chg_1d)} / ${pct(d.chg_1w)}`, `1M ${pct(d.chg_1m)} · vs ${esc(d.prev_date ? d10(d.prev_date) : 'n/a')}`) +
      statBox('CK RETAIL / BUYLIST', `${px(d.ck_retail)} / ${px(d.ck_buylist)}`, `spread ${pctPlain(d.ck_spread_pct)} · exit haircut ${pctPlain(d.exit_haircut_pct)}`) +
      statBox('TCG ASK PREMIUM', pct(d.ask_premium_pct), `listed median ${px(d.tcg_listed_median)}`) +
      statBox('BOX EV / P-EV', `${px(d.box_ev)} / ${isNum(d.ev_ratio) ? d.ev_ratio.toFixed(2) + 'x' : 'n/a'}`, `sealed premium ${pct(d.sealed_premium_pct)}`) +
      statBox('SET SINGLES INDEX', num(d.set_idx_level), `1W ${pct(d.set_idx_chg_1w)} · 1M ${pct(d.set_idx_chg_1m)}`);
    const kv = [['Ticker', d.ticker], ['Name', d.name], ['Set', `${d.set_code} — ${d.set_name}`], ['Category', `${d.display_category} (${d.category}/${d.subtype})`], ['Release', d10(d.release_date)],
      ['Age', `${num(d.age_months, 1)} months`], ['Era', d.era], ['Packs per box', d.booster_count || 'n/a'], ['Card count', d.card_count || 'n/a'],
      ['TCGplayer id', d.tcgplayer_id || 'n/a'], ['Card Kingdom id', d.cardkingdom_id || 'n/a'], ['MTGJSON uuid', d.uuid],
      ['Lake history', `${d.n_obs || 0} obs since ${esc(d10(d.history_start))} · hi ${px(d.hi_since)} lo ${px(d.lo_since)}`],
      ['Chase card', d.chase_card ? `${esc(d.chase_card)} ${px(d.chase_price)}` : 'n/a'], ['RL value share', pctPlain(d.rl_value_share_pct)], ['EV top singles', d.ev_top_singles || 'n/a']];
    const chaseCols = [{ key: 'name', label: 'Card', left: true }, { key: 'rarity', label: 'Rarity', left: true }, { key: 'is_reserved', label: 'RL', fmt: yes }, { key: 'printings_count', label: 'Prints', fmt: v => num(v, 0) }, { key: 'tcg_price', label: 'TCG', fmt: v => px(v) }, { key: 'chg_1w', label: '1W', fmt: pct }, { key: 'chg_1m', label: '1M', fmt: pct }];
    const sibCols = [{ key: 'ticker', label: 'Ticker', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` }, { key: 'name', label: 'Product', left: true }, { key: 'display_category', label: 'Category', left: true }, { key: 'best_price', label: 'Last', fmt: v => px(v) }, { key: 'ck_spread_pct', label: 'Spread', fmt: v => pctPlain(v) }];
    body = `<div class="grid-23" style="padding:6px">
      ${panel('<span class="code">1)</span> CATALOG', `<table class="bbg-table kv-table"><tbody>${kv.map(([k, v]) => `<tr><td>${k}</td><td>${v ?? 'n/a'}</td></tr>`).join('')}</tbody></table>`)}
      <div>${panel('<span class="code">2)</span> PRICE (GP)', '<div class="chart-box short"><canvas id="desChart"></canvas></div>')}
      ${panel('<span class="code">3)</span> SET CHASE CARDS', table(chaseCols, r.chase_cards, { menu: true, onRow: (row) => runFunction('DES', row.uuid), maxHeight: '260px' }))}
      ${panel('<span class="code">4)</span> OTHER SEALED IN SET', table(sibCols, r.siblings, { menu: true, onRow: (row) => runFunction('DES', row.uuid), maxHeight: '240px' }))}</div></div>`;
  } else if (s.type === 'CARD') {
    stats = statBox('TCG MARKET', px(d.tcg_price), `${esc(d10(d.price_date))} · foil ${px(d.tcg_foil)}`) +
      statBox('1D / 1W / 1M / 3M', `${pct(d.chg_1d)} / ${pct(d.chg_1w)}`, `${pct(d.chg_1m)} / ${pct(d.chg_3m)}`) +
      statBox('CK RETAIL / BUYLIST', `${px(d.ck_retail)} / ${px(d.ck_buylist)}`, `spread ${pctPlain(d.ck_spread_pct)}`) +
      statBox('CARDMARKET', `${isNum(d.cm_eur) ? '€' + fmtNum(d.cm_eur) : 'n/a'} → ${px(d.cm_usd)}`, `EU premium ${pct(d.cm_premium_pct)}`) +
      statBox('RANGE SINCE ' + esc(d10(d.history_start)), `${px(d.lo_since)} – ${px(d.hi_since)}`, `vol20 ${pctPlain(d.vol_20d, 0)} · ${d.n_obs} obs`) +
      statBox('REPRINT FACTS', `${d.printings_count} printing(s)`, `last ${esc(d10(d.last_printing_date))} · RL ${d.is_reserved ? 'YES' : 'no'}`);
    const kv = [['Name', d.name], ['Set', `${d.set_code} — ${d.set_name}`], ['Rarity', d.rarity], ['Type', d.type_line], ['Reserved List', d.is_reserved ? 'YES' : 'no'], ['Promo', d.is_promo ? 'yes' : 'no'],
      ['Era', d.era], ['Release', d10(d.release_date)], ['First / last printing', `${esc(d10(d.first_printing_date))} / ${esc(d10(d.last_printing_date))}`], ['TCGplayer id', d.tcgplayer_id || 'n/a'], ['Scryfall id', d.scryfall_id || 'n/a'], ['MTGJSON uuid', d.uuid],
      ['Set singles index', `${num(set.idx_level)} (1W ${pctPlain(set.idx_chg_1w)}, 1M ${pctPlain(set.idx_chg_1m)})`]];
    const prCols = [{ key: 'set_code', label: 'Set', left: true, fmt: v => `<span class="sec-code">${v}</span>` }, { key: 'set_name', label: 'Name', left: true }, { key: 'release_date', label: 'Release', left: true, fmt: d10 }, { key: 'rarity', label: 'Rarity', left: true }, { key: 'tcg_price', label: 'TCG', fmt: v => px(v) }, { key: 'ck_retail', label: 'CK', fmt: v => px(v) }, { key: 'chg_1m', label: '1M', fmt: pct }];
    const sealedCols = [{ key: 'ticker', label: 'Ticker', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` }, { key: 'name', label: 'Product', left: true }, { key: 'best_price', label: 'Last', fmt: v => px(v) }, { key: 'box_ev', label: 'EV', fmt: v => px(v) }, { key: 'ev_ratio', label: 'P/EV', fmt: v => isNum(v) ? v.toFixed(2) + 'x' : 'n/a' }];
    body = `<div class="grid-23" style="padding:6px">
      ${panel('<span class="code">1)</span> CATALOG', `<table class="bbg-table kv-table"><tbody>${kv.map(([k, v]) => `<tr><td>${k}</td><td>${v ?? 'n/a'}</td></tr>`).join('')}</tbody></table>`)}
      <div>${panel('<span class="code">2)</span> PRICE (GP)', '<div class="chart-box short"><canvas id="desChart"></canvas></div>')}
      ${panel('<span class="code">3)</span> ALL PRINTINGS', table(prCols, r.printings, { menu: true, onRow: (row) => runFunction('DES', row.uuid), maxHeight: '240px' }))}
      ${panel('<span class="code">4)</span> SEALED PRODUCTS OF THE SET', table(sealedCols, r.sealed_in_set, { menu: true, onRow: (row) => runFunction('DES', row.uuid), maxHeight: '200px' }))}</div></div>`;
  } else if (s.type === 'SET') {
    stats = statBox('SET SINGLES INDEX', num(d.idx_level), `${d.idx_n} constituents · ${esc(d10(d.idx_date))}`) +
      statBox('1D / 1W / 1M', `${pct(d.idx_chg_1d)} / ${pct(d.idx_chg_1w)}`, `1M ${pct(d.idx_chg_1m)} · 3M ${pct(d.idx_chg_3m)}`) +
      statBox('RANGE', `${num(d.idx_lo)} – ${num(d.idx_hi)}`, 'since first observation') +
      statBox('RARE+ VALUE', px(d.rare_plus_value, 0), `${d.n_priced} priced cards`) +
      statBox('RL VALUE SHARE', pctPlain(d.rl_value_share_pct), `single-print share ${pctPlain(d.single_print_value_share_pct)}`) +
      statBox('CHASE CARD', esc(d.chase_card || 'n/a'), px(d.chase_price));
    const kv = [['Code', d.code], ['Name', d.name], ['Type', d.type], ['Release', d10(d.release_date)], ['Era', d.era], ['Cards (total / base)', `${d.total_cards} / ${d.base_cards}`], ['Avg printings of rare+ cards', num(d.avg_printings, 2)]];
    const chaseCols = [{ key: 'name', label: 'Card', left: true }, { key: 'rarity', label: 'Rarity', left: true }, { key: 'is_reserved', label: 'RL', fmt: yes }, { key: 'printings_count', label: 'Prints', fmt: v => num(v, 0) }, { key: 'tcg_price', label: 'TCG', fmt: v => px(v) }, { key: 'chg_1w', label: '1W', fmt: pct }, { key: 'chg_1m', label: '1M', fmt: pct }];
    const sealedCols = [{ key: 'ticker', label: 'Ticker', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` }, { key: 'name', label: 'Product', left: true }, { key: 'display_category', label: 'Category', left: true }, { key: 'best_price', label: 'Last', fmt: v => px(v) }, { key: 'ck_spread_pct', label: 'Spread', fmt: v => pctPlain(v) }, { key: 'box_ev', label: 'EV', fmt: v => px(v) }, { key: 'ev_ratio', label: 'P/EV', fmt: v => isNum(v) ? v.toFixed(2) + 'x' : 'n/a' }];
    body = `<div class="grid-23" style="padding:6px">
      <div>${panel('<span class="code">1)</span> SET', `<table class="bbg-table kv-table"><tbody>${kv.map(([k, v]) => `<tr><td>${k}</td><td>${v ?? 'n/a'}</td></tr>`).join('')}</tbody></table>`)}
      ${panel('<span class="code">2)</span> SEALED PRODUCTS', table(sealedCols, r.sealed_in_set, { menu: true, onRow: (row) => runFunction('DES', row.uuid), maxHeight: '340px' }))}</div>
      <div>${panel('<span class="code">3)</span> SINGLES INDEX (GP)', '<div class="chart-box short"><canvas id="desChart"></canvas></div>')}
      ${panel('<span class="code">4)</span> CHASE CARDS', table(chaseCols, r.chase_cards, { menu: true, onRow: (row) => runFunction('DES', row.uuid), maxHeight: '300px' }))}</div></div>`;
  } else {
    stats = statBox('LEVEL', num(d.level), `${d.n} members · ${esc(d.as_of)}`) + statBox('1D / 1W', `${pct(d.chg_1d)} / ${pct(d.chg_1w)}`, `1M ${pct(d.chg_1m)} · 3M ${pct(d.chg_3m)}`) +
      statBox('RANGE', `${num(d.lo_since)} – ${num(d.hi_since)}`, `since ${esc(d.history_start)}`);
    body = `<div style="padding:6px">${panel('<span class="code">1)</span> LEVEL (GP)', '<div class="chart-box"><canvas id="desChart"></canvas></div>')}</div>`;
  }
  host.innerHTML = panel(fnTitle('DES', 'DESCRIPTION', secLabel(s)), fnLinks(s, 'DES') + `<div class="bbg-sec-summary-grid">${stats}</div>` + body + `<div class="bbg-note">${esc(r.provenance)}</div>`, { asof: d.price_date || d.idx_date || d.as_of || '' });
  bindFnLinks(s);
  const ch = await apiFetch(`/api/chart/${secQuery(s)}`, { range: 'ALL' });
  new TermChart('desChart', { showMA: false }).setSeries(ch.series);
} };

let gpChart = null;
SCREENS.GP = { name: 'Price Graph', needsSecurity: true, render: async (host, q) => {
  const ch = await apiFetch(`/api/chart/${q}`, { range: STATE.chartRange });
  STATE.security = ch.security;
  const s = ch.security;
  const ranges = ['1W', '1M', '3M', '6M', '1Y', 'ALL'];
  const ctl = `<div class="chart-controls">
    <button class="bbg-tab-btn" id="gpMA">MA20/50</button><button class="bbg-tab-btn" id="gpLog">LOG</button>
    ${ranges.map(r => `<button class="bbg-tab-btn ${r === STATE.chartRange ? 'on' : ''}" data-range="${r}">${r}</button>`).join('')}</div>`;
  const st = ch.stats || {};
  host.innerHTML = panel(fnTitle('GP', 'PRICE GRAPH', secLabel(s)), fnLinks(s, 'GP') + `
    <div class="bbg-sec-summary-grid">
      ${statBox('LAST', s.type === 'INDEX' || s.type === 'SET' ? num(st.last) : px(st.last), `${esc(st.to || '')}`)}
      ${statBox('RANGE CHANGE', pct(st.chg_pct), `${esc(st.from || '')} → ${esc(st.to || '')}`)}
      ${statBox('HIGH / LOW', `${s.type === 'INDEX' || s.type === 'SET' ? num(st.hi) : px(st.hi)} / ${s.type === 'INDEX' || s.type === 'SET' ? num(st.lo) : px(st.lo)}`, `${st.points || 0} observations`)}
      ${statBox('SERIES', String(ch.series.length), 'click legend entries to toggle')}
    </div>
    <div class="chart-box"><canvas id="gpChart"></canvas></div>
    ${ch.notes.map(n => `<div class="bbg-note warn">${esc(n)}</div>`).join('')}<div class="bbg-note">${esc(ch.provenance)}</div>`, { controls: ctl, asof: st.to });
  bindFnLinks(s);
  gpChart = new TermChart('gpChart', { showMA: true, title: `${secLabel(s)} · ${ch.range}` });
  let gpSeries = ch.series;
  // Archival overlay: estimated weekly pre-history for indices (tcgcsv archives,
  // fixed current basket). Dashed dark amber, ALL range only, always labeled EST.
  if (s.type === 'INDEX' && ch.range === 'ALL') {
    try {
      const ar = await fetch('data/api/wei_archival_series.json').then(r => r.ok ? r.json() : null);
      const pts = ar && ar.series && ar.series[s.id];
      if (pts && pts.length > 1) {
        gpSeries = [...ch.series, { key: 'archival', label: 'ARCHIVAL EST (WEEKLY, FIXED CURRENT BASKET)', color: '#cc7a00', axis: 'L', dash: [6, 4], points: pts }];
        const noteHost = host.querySelector('.bbg-note');
        if (noteHost) noteHost.insertAdjacentHTML('beforebegin', `<div class="bbg-note warn">${esc(ar.note || 'Dashed series is an archival estimate, not observed daily history.')}</div>`);
      }
    } catch (e) { /* overlay is optional */ }
  }
  gpChart.setSeries(gpSeries);
  host.querySelector('#gpMA').classList.add('on');
  host.querySelector('#gpMA').addEventListener('click', (e) => { gpChart.setOption('showMA', !gpChart.opts.showMA); e.target.classList.toggle('on'); });
  host.querySelector('#gpLog').addEventListener('click', (e) => { gpChart.setOption('logScale', !gpChart.opts.logScale); e.target.classList.toggle('on'); });
  host.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => { STATE.chartRange = b.dataset.range; runFunction('GP', q, false); }));
} };

SCREENS.HP = { name: 'Historical Prices', needsSecurity: true, render: async (host, q) => {
  const r = await apiFetch(`/api/hp/${q}`, { range: STATE.chartRange === '1W' ? '1M' : STATE.chartRange, limit: 200 });
  STATE.security = r.security;
  const isIdx = r.security.type === 'INDEX' || r.security.type === 'SET';
  const cols = [{ key: 'date', label: 'Date', left: true }, ...r.columns.map(c => ({ key: c.key, label: c.label, fmt: v => isIdx || c.key === 'set_index' ? num(v) : px(v) })), { key: 'chg_pct', label: `${(r.primary || '').toUpperCase()} %CHG`, fmt: pct }];
  host.innerHTML = panel(fnTitle('HP', 'HISTORICAL PRICES', secLabel(r.security)), fnLinks(r.security, 'HP') + table(cols, r.rows, { maxHeight: '700px' }) + r.notes.map(n => `<div class="bbg-note warn">${esc(n)}</div>`).join(''));
  bindFnLinks(r.security);
} };

SCREENS.QR = { name: 'Quote Recap', needsSecurity: true, render: async (host, q) => {
  const r = await loadSecurity(q);
  const s = r.security, d = r.details || {};
  let rows;
  if (s.type === 'SEALED') rows = [
    ['TCGplayer market (last sold)', d.tcg_market, d.tcg_date, 'reference'], ['TCGplayer listed median (ASK)', d.tcg_listed_median, d.tcg_date, `ask premium ${pctPlain(d.ask_premium_pct)}`],
    ['Card Kingdom retail (dealer ASK)', d.ck_retail, d.ck_date, `vs TCG ${pctPlain(d.ck_vs_tcg_pct)}`], ['Card Kingdom buylist (dealer BID)', d.ck_buylist, d.ck_date, `dealer spread ${pctPlain(d.ck_spread_pct)} · exit haircut vs TCG ${pctPlain(d.exit_haircut_pct)}`]];
  else if (s.type === 'CARD') rows = [
    ['TCGplayer market', d.tcg_price, d.price_date, 'reference'], ['TCGplayer foil', d.tcg_foil, d.price_date, ''],
    ['Card Kingdom retail (ASK)', d.ck_retail, d.ck_date, ''], ['Card Kingdom buylist (BID)', d.ck_buylist, d.ck_date, `dealer spread ${pctPlain(d.ck_spread_pct)}`],
    ['Cardmarket EU (USD eq.)', d.cm_usd, d.cm_date, `€${isNum(d.cm_eur) ? fmtNum(d.cm_eur) : 'n/a'} · EU premium ${pctPlain(d.cm_premium_pct)}`]];
  else rows = [['Level', d.idx_level ?? d.level, d.idx_date ?? d.as_of, '']];
  const tbl = `<table class="bbg-table"><thead><tr><th class="text-left">Quote</th><th>Price</th><th class="text-left">Date</th><th class="text-left">Note</th></tr></thead><tbody>${rows.map(([k, v, dt, n]) => `<tr><td class="text-left">${k}</td><td class="sec-price">${s.type === 'SET' || s.type === 'INDEX' ? num(v) : px(v)}</td><td class="text-left">${esc(d10(dt))}</td><td class="text-left val-na">${n}</td></tr>`).join('')}</tbody></table>`;
  host.innerHTML = panel(fnTitle('QR', 'QUOTE RECAP', secLabel(s)), fnLinks(s, 'QR') + tbl + `<div class="bbg-note">Dealer buylist is the bid a forced seller receives today; TCGplayer listed median is the ask a buyer pays today. Market price is the last-sold reference. EUR at ${r.eurusd}.</div>`);
  bindFnLinks(s);
} };

SCREENS.COMP = { name: 'Comparative Returns', needsSecurity: false, render: async (host, q) => {
  const ids = q || STATE.tables.comp || 'MTGCOMP,MTGRL,MTGUB,MTGCUR';
  STATE.tables.comp = ids;
  let r;
  const compRange = STATE.chartRange === '1W' ? '1M' : STATE.chartRange;
  try { r = await apiFetch('/api/comp', { ids, range: compRange }); }
  catch (e) {
    if (!STATE.static || ids === 'MTGCOMP,MTGRL,MTGUB,MTGCUR') throw e;
    STATE.tables.comp = 'MTGCOMP,MTGRL,MTGUB,MTGCUR';
    r = await apiFetch('/api/comp', { ids: 'MTGCOMP,MTGRL,MTGUB,MTGCUR', range: compRange });
    msg('STATIC BUNDLE: ONLY THE DEFAULT COMP COMBO IS PRE-BAKED — CUSTOM BASKETS NEED THE LIVE SERVER');
  }
  const palette = ['#ff9900', '#00e5ff', '#00ff66', '#ff66cc', '#ffff00', '#cc66ff'];
  const series = r.series.filter(s => s.points).map((s, i) => ({ key: s.label, label: s.label, color: palette[i % palette.length], axis: 'L', points: s.points }));
  const rows = r.series.map(s => ({ label: s.label || s.query, name: s.security ? s.security.name : s.error, ret: s.total_return_pct, n: s.n, err: s.error }));
  const cols = [{ key: 'label', label: 'Series', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` }, { key: 'name', label: 'Security', left: true }, { key: 'ret', label: `${r.range} RETURN`, fmt: pct }, { key: 'n', label: 'Obs', fmt: v => num(v, 0) }];
  const ranges = ['1M', '3M', '6M', '1Y', 'ALL'];
  host.innerHTML = panel(fnTitle('COMP', 'COMPARATIVE RETURNS (REBASED 100)'), `
    <div class="bbg-filters"><label>SECURITIES (comma-separated, max 6)</label><input id="compIds" class="bbg-filter-input wide" style="width:420px" value="${esc(ids)}"><button class="bbg-mini" id="compGo">RUN</button>
    <div class="chart-controls" style="margin-left:10px">${ranges.map(x => `<button class="bbg-tab-btn ${x === STATE.chartRange ? 'on' : ''}" data-range="${x}">${x}</button>`).join('')}</div></div>
    <div class="chart-box"><canvas id="compChart"></canvas></div>${table(cols, rows, {})}<div class="bbg-note">${esc(r.note)}</div>`);
  new TermChart('compChart', { showMA: false, yFormat: v => fmtNum(v, 1), title: `REBASED 100 · ${r.range}` }).setSeries(series);
  const go = () => runFunction('COMP', host.querySelector('#compIds').value);
  host.querySelector('#compGo').addEventListener('click', go);
  host.querySelector('#compIds').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  host.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => { STATE.chartRange = b.dataset.range; runFunction('COMP', ids, false); }));
} };

SCREENS.HVT = { name: 'Historical Volatility', needsSecurity: true, render: async (host, q) => {
  const r = await apiFetch(`/api/hvt/${q}`);
  STATE.security = r.security;
  if (!r.available) { host.innerHTML = panel(fnTitle('HVT', 'HISTORICAL VOLATILITY', secLabel(r.security)), fnLinks(r.security, 'HVT') + `<div class="bbg-note warn">${esc(r.reason)}</div>`); bindFnLinks(r.security); return; }
  host.innerHTML = panel(fnTitle('HVT', 'HISTORICAL VOLATILITY', secLabel(r.security)), fnLinks(r.security, 'HVT') + `
    <div class="bbg-sec-summary-grid">
      ${statBox('VOL 10D / 20D', `${pctPlain(r.vol_10d)} / ${pctPlain(r.vol_20d)}`, 'annualised')}${statBox('VOL 60D / ALL', `${pctPlain(r.vol_60d)} / ${pctPlain(r.vol_all)}`, `${r.observations} obs`)}
      ${statBox('MAX DRAWDOWN', pct(r.max_drawdown_pct), `trough ${esc(r.max_drawdown_date)}`)}${statBox('UP / DOWN / FLAT DAYS', `${r.up_days} / ${r.down_days} / ${r.flat_days}`, `${esc(r.from)} → ${esc(r.to)}`)}
      ${statBox('BEST / WORST DAY', `${pct(r.best_day_pct)} / ${pct(r.worst_day_pct)}`, `series: ${esc(r.primary)}`)}
    </div><div class="chart-box short"><canvas id="hvtChart"></canvas></div><div class="bbg-note">${esc(r.note)}</div>`);
  bindFnLinks(r.security);
  new TermChart('hvtChart', { showMA: false, yFormat: v => fmtNum(v, 1) + '%', title: 'ROLLING 20D REALISED VOL' }).setSeries([{ key: 'vol', label: 'ROLLING VOL 20D (ANN. %)', color: '#00e5ff', axis: 'L', points: r.rolling_vol_20d }]);
} };

SCREENS.RV = { name: 'Relative Value', needsSecurity: true, render: async (host, q) => {
  const r = await apiFetch(`/api/rv/${q}`);
  STATE.security = r.security;
  if (r.available === false) { host.innerHTML = panel(fnTitle('RV', 'RELATIVE VALUE', secLabel(r.security)), fnLinks(r.security, 'RV') + `<div class="bbg-note warn">${esc(r.reason)}</div>`); bindFnLinks(r.security); return; }
  const labels = { best_price: 'Price / level', ck_spread_pct: 'CK dealer spread %', ask_premium_pct: 'TCG ask premium %', exit_haircut_pct: 'Exit haircut %', set_idx_chg_1m: 'Set index 1M %', ev_ratio: 'Price / EV', age_months: 'Age (months)',
    cm_premium_pct: 'EU premium %', chg_1w: '1W %', chg_1m: '1M %', vol_20d: 'Vol 20D %', printings_count: 'Printings', idx_chg_1w: 'Index 1W %', idx_chg_1m: 'Index 1M %', rare_plus_value: 'Rare+ value $', rl_value_share_pct: 'RL value share %', avg_printings: 'Avg printings', chase_price: 'Chase card $' };
  const ranks = Object.entries(r.ranks).map(([k, v]) => `<div class="rank-row"><div class="rank-label">${labels[k] || k}</div>
    <div class="rank-track"><div class="rank-iqr" style="left:25%;width:50%"></div><div class="rank-dot median" style="left:50%"></div><div class="rank-dot target" style="left:${v.percentile}%" title="${v.percentile}th pct"></div></div>
    <div class="rank-vals">${fmtNum(v.value)} · <span style="color:#00e5ff">${v.percentile}th</span> · med ${fmtNum(v.median)} (n=${v.n})</div></div>`).join('');
  const peers = r.peers || [];
  const keys = peers.length ? Object.keys(peers[0]).filter(k => !['uuid'].includes(k)) : [];
  const cols = keys.map(k => ({ key: k, label: (labels[k] || k).replace(/_/g, ' ').toUpperCase().slice(0, 16), left: typeof peers[0][k] === 'string' || typeof peers[0][k] === 'boolean',
    fmt: (v) => typeof v === 'boolean' ? yes(v) : typeof v === 'number' ? (/pct|chg|premium|vol/.test(k) ? pct(v) : /price|value|chase/.test(k) ? px(v) : num(v)) : esc(v) }));
  host.innerHTML = panel(fnTitle('RV', `RELATIVE VALUE — PEER GROUP: ${esc(String(r.peer_group).toUpperCase())} (${r.n_peers})`, secLabel(r.security)), fnLinks(r.security, 'RV') + `
    <div class="grid-2" style="padding:6px"><div>${panel('<span class="code">1)</span> PERCENTILE RANKS', `<div style="padding:4px 0">${ranks || '<div class="bbg-note">no comparable metrics</div>'}</div><div class="bbg-note"><span style="color:#00e5ff">●</span> this security &nbsp; <span style="color:#ff9900">●</span> peer median &nbsp; grey band = interquartile range (positions are percentile ranks, not values)</div>`)}</div>
    <div>${panel('<span class="code">2)</span> PEERS', table(cols, peers, { menu: true, onRow: (row) => runFunction('DES', row.uuid), maxHeight: '520px' }))}</div></div>`);
  bindFnLinks(r.security);
} };

SCREENS.DRSK = { name: 'Reprint Risk', needsSecurity: true, render: async (host, q) => {
  const r = await apiFetch(`/api/drsk/${q}`);
  STATE.security = r.security;
  if (!r.available) { host.innerHTML = panel(fnTitle('DRSK', 'REPRINT RISK', secLabel(r.security)), fnLinks(r.security, 'DRSK') + `<div class="bbg-note warn">${esc(r.reason)}</div>`); bindFnLinks(r.security); return; }
  const gcls = r.grade.startsWith('IG') ? 'grade-ig' : r.score >= 65 ? 'grade-hy' : 'grade-mid';
  const comps = Object.entries(r.components).map(([k, c]) => `<div class="bar-row"><div style="color:#ddd">${k.replace(/_/g, ' ').toUpperCase()} <span class="val-na">(${Math.round(c.weight * 100)}%)</span></div><div class="bar-track"><div class="bar-fill" style="width:${c.score}%;background:${c.score >= 65 ? '#ff3333' : c.score >= 35 ? '#ff9900' : '#00ff66'}"></div></div><div style="text-align:right;color:#fff">${c.score}</div></div><div class="bbg-note" style="padding:0 8px 4px 8px;border:0">${esc(c.detail)}</div>`).join('');
  const inputs = Object.entries(r.inputs).map(([k, v]) => `<tr><td>${k.replace(/_/g, ' ')}</td><td>${v === null || v === undefined ? '<span class="val-na">n/a</span>' : typeof v === 'number' ? fmtNum(v) : esc(String(v)).slice(0, 10) === String(v).slice(0, 10) && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : esc(String(v))}</td></tr>`).join('');
  const topCols = [{ key: 'name', label: 'Card', left: true }, { key: 'rarity', label: 'Rarity', left: true }, { key: 'is_reserved', label: 'RL', fmt: yes }, { key: 'printings_count', label: 'Prints', fmt: v => num(v, 0) }, { key: 'last_printing_date', label: 'Last print', left: true, fmt: d10 }, { key: 'tcg_price', label: 'TCG', fmt: v => px(v) }, { key: 'value_share_pct', label: 'Value share', fmt: v => pctPlain(v) }];
  host.innerHTML = panel(fnTitle('DRSK', 'REPRINT RISK SCORECARD', secLabel(r.security)), fnLinks(r.security, 'DRSK') + `
    <div class="grid-2" style="padding:6px"><div>
      ${panel('<span class="code">1)</span> SCORE', `<div class="score-box"><div class="score-big">${r.score}</div><div><div class="score-grade ${gcls}">${r.grade}</div><div class="val-na">0 = insulated · 100 = fully exposed to a reprint</div></div></div>${comps}`)}
      ${panel('<span class="code">2)</span> INPUTS', `<table class="bbg-table kv-table"><tbody>${inputs}</tbody></table>`)}</div>
    <div>${panel('<span class="code">3)</span> RARE+ VALUE BY PRINTING COUNT', '<div class="chart-box mini"><canvas id="drskBars"></canvas></div>')}
      ${panel('<span class="code">4)</span> TOP VALUE CARDS OF THE SET', table(topCols, r.top_value_cards, { maxHeight: '300px' }))}
      ${panel('<span class="code">5)</span> DETECTED EVENTS', r.events.length ? `<div class="news-feed">${r.events.map(e => `<div class="news-item"><span class="news-time">${esc(e.date)}</span><span class="news-source">${esc(e.type).toUpperCase()}</span><span class="news-title">${esc(e.title)}</span></div>`).join('')}</div>` : '<div class="bbg-note">No reprint or ban event tagged to this set in the event registry.</div>')}</div></div>
    <div class="bbg-note">${esc(r.method)}</div>`);
  bindFnLinks(r.security);
  new TermBars('drskBars', { valueFormat: v => '$' + fmtNum(v, 0) }).setData(r.value_by_printings.map(b => ({ label: b.bucket, value: b.value, sub: `n=${b.n}`, color: b.bucket === 'RESERVED LIST' ? '#00ff66' : b.bucket === '1 PRINTING' ? '#ff3333' : '#ff9900' })));
} };

SCREENS.MEMB = { name: 'Members', needsSecurity: true, render: async (host, q) => {
  const con = await loadSecurity(q);
  const s = con.security;
  let r, cols, title;
  if (s.type === 'INDEX') {
    r = await apiFetch(`/api/index/${s.id}/members`, { limit: 100 });
    cols = r.kind === 'CARD' ? [{ key: 'name', label: 'Card', left: true }, { key: 'set_code', label: 'Set', left: true, fmt: v => `<span class="sec-code">${v}</span>` }, { key: 'rarity', label: 'Rarity', left: true }, { key: 'is_reserved', label: 'RL', fmt: yes }, { key: 'tcg_price', label: 'TCG', fmt: v => px(v) }, { key: 'weight_pct', label: 'Weight', fmt: v => pctPlain(v, 3) }, { key: 'chg_1d', label: '1D', fmt: pct }, { key: 'chg_1w', label: '1W', fmt: pct }, { key: 'chg_1m', label: '1M', fmt: pct }]
      : [{ key: 'ticker', label: 'Ticker', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` }, { key: 'name', label: 'Product', left: true }, { key: 'display_category', label: 'Category', left: true }, { key: 'best_price', label: 'Last', fmt: v => px(v) }, { key: 'chg_1d', label: '1D', fmt: pct }, { key: 'chg_1w', label: '1W', fmt: pct }];
    title = `${r.code} — ${r.name} · ${fmtNum(r.n_members, 0)} MEMBERS · VALUE $${fmtNum(r.total_value, 0)}`;
    r.members = r.members || [];
  } else {
    const code = s.set_code || s.id;
    const sr = await apiFetch('/api/singles', { set_code: code, limit: 150, sort_by: 'tcg_price', order: 'desc' });
    const total = sr.data.reduce((a, b) => a + (b.tcg_price || 0), 0) || 1;
    r = { members: sr.data.map(x => ({ ...x, weight_pct: x.tcg_price / total * 100 })), n_members: sr.total };
    cols = [{ key: 'name', label: 'Card', left: true }, { key: 'rarity', label: 'Rarity', left: true }, { key: 'is_reserved', label: 'RL', fmt: yes }, { key: 'printings_count', label: 'Prints', fmt: v => num(v, 0) }, { key: 'tcg_price', label: 'TCG', fmt: v => px(v) }, { key: 'weight_pct', label: 'Weight (top 150)', fmt: v => pctPlain(v, 2) }, { key: 'chg_1w', label: '1W', fmt: pct }, { key: 'chg_1m', label: '1M', fmt: pct }];
    title = `${code} — ${fmtNum(sr.total, 0)} PRICED CARDS`;
  }
  host.innerHTML = panel(fnTitle('MEMB', 'MEMBERS', title), fnLinks(s, 'MEMB') + table(cols, r.members, { menu: true, onRow: (row) => runFunction('DES', row.uuid), maxHeight: '700px' }) + (r.note ? `<div class="bbg-note">${esc(r.note)}</div>` : ''));
  bindFnLinks(s);
} };

SCREENS.FXIP = { name: 'Cross-Market Premium', render: async (host) => {
  const r = await apiFetch('/api/fxip', { limit: 40 });
  const setCols = [{ key: 'set_code', label: 'Set', left: true, fmt: v => `<span class="sec-code">${v}</span>` }, { key: 'set_name', label: 'Name', left: true }, { key: 'era', label: 'Era', left: true }, { key: 'n_cards', label: 'N', fmt: v => num(v, 0) }, { key: 'median_premium_pct', label: 'EU Prem (med)', fmt: pct }, { key: 'p25', label: 'P25', fmt: pct }, { key: 'p75', label: 'P75', fmt: pct }, { key: 'value_usd', label: 'US value', fmt: v => px(v, 0) }, { key: 'value_eu_usd', label: 'EU value', fmt: v => px(v, 0) }];
  const eraCols = [{ key: 'era', label: 'Era', left: true }, { key: 'n_cards', label: 'N', fmt: v => num(v, 0) }, { key: 'median_premium_pct', label: 'EU Prem (med)', fmt: pct }, { key: 'value_usd', label: 'US value', fmt: v => px(v, 0) }];
  const cardCols = [{ key: 'name', label: 'Card', left: true }, { key: 'set_code', label: 'Set', left: true, fmt: v => `<span class="sec-code">${v}</span>` }, { key: 'tcg_price', label: 'TCG', fmt: v => px(v) }, { key: 'cm_eur', label: 'CM €', fmt: v => isNum(v) ? '€' + fmtNum(v) : 'n/a' }, { key: 'cm_usd', label: 'CM $', fmt: v => px(v) }, { key: 'cm_premium_pct', label: 'EU Prem', fmt: pct }];
  host.innerHTML = panel(fnTitle('FXIP', `CROSS-MARKET PREMIUM — EURUSD ${r.eurusd} (${esc(r.source)}, ${esc(r.eurusd_date)})`), `
    <div class="grid-32" style="padding:6px"><div>${panel('<span class="code">1)</span> BY SET (VALUE-RANKED)', table(setCols, r.by_set, { menu: true, onRow: (row) => runFunction('DES', row.set_code), maxHeight: '620px' }))}</div>
    <div>${panel('<span class="code">2)</span> BY ERA', table(eraCols, r.by_era, {}))}
    ${panel('<span class="code">3)</span> CHEAPEST IN EUROPE (≥ $20)', table(cardCols, r.cheapest_in_eu, { menu: true, onRow: (row) => runFunction('DES', row.uuid), maxHeight: '260px' }))}
    ${panel('<span class="code">4)</span> RICHEST IN EUROPE (≥ $20)', table(cardCols, r.richest_in_eu, { menu: true, onRow: (row) => runFunction('DES', row.uuid), maxHeight: '260px' }))}</div></div>
    <div class="bbg-note">${esc(r.note)}</div>`);
} };

// ---- ECO: bbg Economic Calendars-style agenda. One chronological grid, the
// next release highlighted like the alarm row, releases/events/jobs views.
SCREENS.ECO = { name: 'Calendar', render: async (host, q) => {
  const r = await apiFetch('/api/eco');
  const view = (STATE.tables.eco || (q || '').toLowerCase() || 'releases');
  STATE.tables.eco = ['releases', 'events', 'jobs'].includes(view) ? view : 'releases';
  const v = STATE.tables.eco;
  const today = r.today || new Date().toISOString().slice(0, 10);
  const dayMs = 86400000;
  const days = (dt) => Math.round((Date.parse(String(dt).slice(0, 10)) - Date.parse(today)) / dayMs);
  const tmin = (dt) => {
    const d = days(dt);
    if (isNaN(d)) return '<span class="val-na">n/a</span>';
    if (d === 0) return '<span class="eco-days">TODAY</span>';
    return d > 0 ? `<span class="eco-days">T-${d}d</span>` : `<span class="eco-days past">${-d}d ago</span>`;
  };
  const upcoming = (r.upcoming_releases || []).slice().sort((a, b) => String(a.release_date).localeCompare(String(b.release_date)));
  const recent = (r.recent_releases || []).slice().sort((a, b) => String(b.release_date).localeCompare(String(a.release_date)));
  const nextDate = upcoming.length ? String(upcoming[0].release_date).slice(0, 10) : null;
  const agenda = upcoming.map(x => ({ ...x, _up: true })).concat(recent.map(x => ({ ...x, _up: false })));
  const cols = [
    { key: 'release_date', label: 'Date', left: true, fmt: (val, row) => `${row._up && String(val).slice(0, 10) === nextDate ? '<span class="eco-bell">◉ </span>' : ''}${d10(val)}` },
    { key: '_days', label: 'T-', left: true, sort: false, fmt: (_, row) => tmin(row.release_date) },
    { key: 'code', label: 'Set', left: true, fmt: val => `<span class="sec-code">${esc(val)}</span>` },
    { key: 'name', label: 'Event', left: true, fmt: val => `<span class="sec-name">${esc(val)}</span>` },
    { key: 'type', label: 'Type', left: true },
    { key: 'idx_level', label: 'SetIdx', fmt: (val, row) => row._up ? '<span class="val-na">--</span>' : num(val) },
    { key: 'idx_chg_1w', label: '1W', fmt: (val, row) => row._up ? '<span class="val-na">--</span>' : pct(val) },
    { key: 'idx_chg_1m', label: '1M', fmt: (val, row) => row._up ? '<span class="val-na">--</span>' : pct(val) },
    { key: 'idx_n', label: 'N', fmt: (val, row) => row._up ? '<span class="val-na">--</span>' : num(val, 0) }];
  const evCols = [
    { key: 'date', label: 'Date', left: true }, { key: '_days', label: 'T-', left: true, sort: false, fmt: (_, row) => tmin(row.date) },
    { key: 'type', label: 'Type', left: true, fmt: val => `<span style="color:#ff9900">${esc(val).toUpperCase()}</span>` },
    { key: 'title', label: 'Event', left: true },
    { key: 'affected_set_codes', label: 'Sets', left: true, fmt: val => esc((val || []).join(', ')) || '<span class="val-na">untagged</span>' }];
  const jobCols = [{ key: 'job', label: 'Job', left: true }, { key: 'schedule', label: 'Schedule', left: true }, { key: 'last', label: 'Last', left: true }];
  const tb = (id, label) => `<button class="eco-tb-item ${v === id ? 'on' : ''}" data-eco="${id}">${label}</button>`;
  const toolbar = `<div class="eco-toolbar">${tb('releases', '1) Calendars — Releases')}${tb('events', '2) Alerts — Detected Events')}${tb('jobs', '3) Settings — Data Jobs')}
    <span class="eco-range">MTG RELEASES · ${esc(today)} ${nextDate ? `— NEXT ◉ ${esc(nextDate)} (T-${days(nextDate)}d)` : ''}</span></div>`;
  let body;
  if (v === 'events') body = table(evCols, r.detected_events || [], { maxHeight: '640px' });
  else if (v === 'jobs') body = table(jobCols, r.data_jobs || [], { maxHeight: '640px' });
  else body = `<div class="eco-agenda">${table(cols, agenda, { menu: true, onRow: (row) => runFunction('DES', row.code), maxHeight: '640px' })}</div>`;
  host.innerHTML = panel(fnTitle('ECO', `RELEASE CALENDAR — ${esc(today)}`), toolbar + body + `<div class="bbg-note">${esc(r.note || '')} Upcoming rows show -- in the index columns because a set has no singles index before its cards trade.</div>`);
  host.querySelectorAll('[data-eco]').forEach(b => b.addEventListener('click', () => { STATE.tables.eco = b.dataset.eco; runFunction('ECO', '', false); }));
  // Row highlight for the next release and any release today (bbg alarm-row look)
  setTimeout(() => {
    host.querySelectorAll('.eco-agenda tbody tr').forEach((tr, i) => {
      const row = agenda[i];
      if (!row) return;
      const d = String(row.release_date).slice(0, 10);
      if (row._up && d === nextDate) tr.classList.add('eco-next');
      else if (d === today) tr.classList.add('eco-today');
    });
  }, 0);
} };

SCREENS.PORT = { name: 'Portfolio', render: async (host) => {
  const r = await apiFetch('/api/port');
  const cols = [
    { key: 'ticker', label: 'Ticker', left: true, fmt: (v, row) => v ? `<span class="sec-code">${esc(v)}</span>` : '<span class="val-na">—</span>' },
    { key: 'name', label: 'Position', left: true, fmt: (v, row) => `${esc(v)}<span class="pill ${row.price_source.startsWith('STORED') ? 'est' : 'lake'}">${row.price_source.startsWith('STORED') ? 'EST' : 'LAKE'}</span>` },
    { key: 'bucket', label: 'Bucket', left: true }, { key: 'quantity', label: 'Qty', fmt: v => num(v, 0) }, { key: 'avg_cost', label: 'Avg cost', fmt: v => px(v) },
    { key: 'price', label: 'Mark', fmt: v => px(v) }, { key: 'price_date', label: 'Mark date', left: true, fmt: d10 }, { key: 'market_value', label: 'Value', fmt: v => px(v) },
    { key: 'pnl', label: 'P&L $', fmt: v => isNum(v) ? `<span class="${v >= 0 ? 'val-up' : 'val-down'}">${v >= 0 ? '+' : ''}${fmtNum(v)}</span>` : 'n/a' }, { key: 'pnl_pct', label: 'P&L %', fmt: pct },
    { key: 'weight_pct', label: 'Wt', fmt: v => pctPlain(v, 1) }, { key: 'chg_1d', label: '1D', fmt: pct }, { key: 'set_idx_chg_1m', label: 'SetIdx 1M', fmt: pct }];
  const bCols = [{ key: 'bucket', label: 'Bucket', left: true }, { key: 'n', label: 'N', fmt: v => num(v, 0) }, { key: 'cost', label: 'Cost', fmt: v => px(v) }, { key: 'market_value', label: 'Value', fmt: v => px(v) }, { key: 'pnl_pct', label: 'P&L %', fmt: pct }, { key: 'weight_pct', label: 'Wt', fmt: v => pctPlain(v, 1) }];
  host.innerHTML = panel(fnTitle('PORT', `PORTFOLIO — ${esc(r.fund_name)}`), `
    <div class="bbg-sec-summary-grid">
      ${statBox('NAV', px(r.nav), `initial ${px(r.initial_aum)} · since ${esc(r.inception)}`)}${statBox('TOTAL RETURN', pct(r.total_return_pct), 'vs initial AUM')}
      ${statBox('HOLDINGS', px(r.holdings_value), `cost ${px(r.holdings_cost)}`)}${statBox('UNREALISED P&L', `${isNum(r.unrealized_pnl) ? (r.unrealized_pnl >= 0 ? '+' : '') + '$' + fmtNum(r.unrealized_pnl) : 'n/a'}`, pct(r.unrealized_pnl_pct))}
      ${statBox('CASH', px(r.cash), `${pctPlain(r.cash_weight_pct, 1)} of NAV`)}${statBox('MARKED FROM LAKE', `${r.n_priced_from_lake} / ${r.n_positions}`, 'positions with a real quote')}
    </div>
    <div class="grid-32" style="padding:6px"><div>${panel('<span class="code">1)</span> POSITIONS', table(cols, r.positions, { menu: true, onRow: (row) => row.ticker ? runFunction('DES', row.uuid) : msg('NO MTGJSON UUID FOR THIS ITEM'), maxHeight: '640px' }))}</div>
    <div>${panel('<span class="code">2)</span> BY STRATEGY BUCKET', table(bCols, r.buckets, {}))}</div></div><div class="bbg-note">${esc(r.note)} Ledger as of ${esc(r.as_of)}.</div>`, { asof: r.as_of });
} };

// ---- TOP front page: sections assigned by rule from source/url, recap auto-generated from the index table
function newsSection(n) {
  const src = `${n.source || ''} ${n.url || ''}`.toLowerCase();
  if (src.includes('wizards') || src.includes('dailymtg')) return 'FEATURED';
  if (src.includes('goldfish') || src.includes('commandersherald') || src.includes('starcitygames') || src.includes('edhrec')) return 'EDITORIALS';
  return 'TOPNEWS';
}
function autoRecapItems(w, status) {
  // Templated sentences from the live index table. Every item carries a GEN flag: generated, not harvested.
  const out = [];
  if (!w || !w.indices || !w.indices.length) return out;
  const by = (c) => w.indices.find(i => i.code === c);
  const singles = w.indices.filter(i => i.family === 'SINGLES' && isNum(i.chg_1d));
  const comp = by('MTGCOMP'), sld = by('SLDCOMP');
  const word = (v) => v > 0.3 ? 'RALLY' : v < -0.3 ? 'SLIP' : 'STEADY';
  if (comp && isNum(comp.chg_1d)) {
    const lead = singles.slice().sort((a, b) => b.chg_1d - a.chg_1d)[0];
    const lag = singles.slice().sort((a, b) => a.chg_1d - b.chg_1d)[0];
    out.push({ title: `MTG SINGLES ${word(comp.chg_1d)}: MTGCOMP ${comp.chg_1d >= 0 ? '+' : ''}${comp.chg_1d.toFixed(2)}% 1D` +
      (lead && lead.code !== 'MTGCOMP' ? `, ${lead.code} LEADS (${lead.chg_1d >= 0 ? '+' : ''}${lead.chg_1d.toFixed(2)}%)` : '') +
      (lag && lag !== lead && lag.code !== 'MTGCOMP' ? `, ${lag.code} LAGS (${lag.chg_1d.toFixed(2)}%)` : ''),
      run: () => runFunction('WEI'), sub: `LEVEL ${fmtNum(comp.level, 2)} · AS OF ${comp.as_of || ''}` });
  }
  if (comp && isNum(comp.chg_1w)) {
    const wk = singles.filter(i => isNum(i.chg_1w)).sort((a, b) => b.chg_1w - a.chg_1w)[0];
    out.push({ title: `THE WEEK: MTGCOMP ${comp.chg_1w >= 0 ? '+' : ''}${comp.chg_1w.toFixed(2)}% 1W` +
      (wk ? `, BEST INDEX ${wk.code} ${wk.chg_1w >= 0 ? '+' : ''}${wk.chg_1w.toFixed(2)}%` : ''),
      run: () => runFunction('MOV', '1w singles'), sub: 'MOV 1W SINGLES <GO> FOR THE TAPE' });
  }
  if (sld && isNum(sld.chg_1w)) {
    out.push({ title: `SEALED: COMPOSITE ${sld.chg_1w >= 0 ? '+' : ''}${sld.chg_1w.toFixed(2)}% 1W AT ${fmtNum(sld.level, 2)}`,
      run: () => runFunction('DES', 'SLDCOMP'), sub: `${sld.n} MEMBERS · LAKE SINCE ${sld.history_start || ''}` });
  }
  if (status && status.eurusd) out.push({ title: `FX: EURUSD ${status.eurusd} — EUROPE PRICED VIA CARDMARKET AT THE ECB REFERENCE RATE`,
    run: () => runFunction('FXIP'), sub: 'FXIP <GO> FOR THE CROSS-MARKET PREMIUM TABLE' });
  return out;
}
SCREENS.TOP = { name: 'Top News', render: async (host) => {
  const r = await apiFetch('/api/news', { limit: 60 });
  let eco = null;
  try { eco = await apiFetch('/api/eco'); } catch (e) { /* rail degrades */ }
  if (!STATE.wei) { try { STATE.wei = await apiFetch('/api/wei'); } catch (e) { } }
  const secs = { TOPNEWS: [], FEATURED: [], EDITORIALS: [] };
  (r.news || []).forEach(n => secs[newsSection(n)].push(n));
  const item = (n) => {
    const i = STATE.menu.push({ label: n.title, run: () => window.open(n.url, '_blank') });
    return `<div class="top-item"><span class="menu-num">${i})</span>
      <span class="news-title"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></span>
      <span class="t-src">${esc((n.subreddit || n.source || '').replace('REAL SCRAPED (Reddit RSS)', 'RDT').slice(0, 14))}</span>
      <span class="t-time">${esc((n.posted || '').slice(5))}</span></div>`;
  };
  const genItem = (g) => {
    const i = STATE.menu.push({ label: g.title, run: g.run });
    return `<div class="top-item gen"><span class="menu-num">${i})</span>
      <span class="news-title"><a>${esc(g.title)}</a><span class="gen-flag">GEN</span></span>
      <span class="t-time">${esc(g.sub || '')}</span></div>`;
  };
  const section = (label, html, more) => html ? `<div class="top-section-head">${label} ${more ? `<span class="more">| ${more}</span>` : ''}</div>${html}` : '';
  const gen = autoRecapItems(STATE.wei, STATE.status);
  const events = (eco && eco.detected_events || []).slice(0, 8);
  const evItem = (e) => {
    const setc = (e.affected_set_codes || [])[0];
    const i = STATE.menu.push({ label: e.title, run: () => setc ? runFunction('DES', setc) : runFunction('ECO') });
    return `<div class="top-item"><span class="menu-num">${i})</span>
      <span class="news-title"><a>${esc(e.title)}</a></span>
      <span class="t-src">${esc(String(e.type || '').toUpperCase().slice(0, 10))}</span><span class="t-time">${esc((e.date || '').slice(5))}</span></div>`;
  };
  const spot = secs.FEATURED[0] || secs.TOPNEWS[0];
  const railIdx = (STATE.wei ? STATE.wei.indices.filter(i => ['MTGCOMP', 'MTGRL', 'MTGVINT', 'MTGUB', 'MTGCUR', 'SLDCOMP', 'SLDCOLL'].includes(i.code)) : []);
  host.innerHTML = panel(fnTitle('TOP', `URZA TOWER FRONT PAGE — ${r.total} HARVESTED ITEMS`), `<div class="top-page">
    <div class="top-main">
      ${section('Top News', secs.TOPNEWS.slice(0, 14).map(item).join(''), 'Reddit harvest, newest first')}
      ${section('Featured Stories', secs.FEATURED.slice(0, 8).map(item).join(''), 'official Wizards / DailyMTG')}
      ${section('Editorials', secs.EDITORIALS.slice(0, 8).map(item).join(''), 'finance and strategy press')}
      ${section('Newsletters', gen.map(genItem).join(''), 'auto-generated from the index table')}
      ${section('Deals — Detected Events', events.map(evItem).join(''), 'reprint / ban detector')}
    </div>
    <div class="top-rail">
      ${spot ? `<div class="rail-box"><div class="rail-head">Spotlight</div><div class="rail-body">
        <div class="spotlight-title"><a href="${esc(spot.url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${esc(spot.title)}</a></div>
        <div class="spotlight-body">${esc((spot.snippet || '').slice(0, 320))}</div>
        <div class="r-src" style="color:var(--cyan);font-size:9px;margin-top:4px">${esc(spot.subreddit || spot.source || '')} · ${esc(spot.posted || '')}</div></div></div>` : ''}
      <div class="rail-box"><div class="rail-head">Markets</div><div class="rail-body">
        ${railIdx.map(i => `<div class="rail-item" data-idx="${i.code}" style="cursor:pointer;display:flex;justify-content:space-between">
          <span class="sec-code">${i.code}</span><span>${fmtNum(i.level, 2)}</span><span>${isNum(i.chg_1d) ? pct(i.chg_1d) : '<span class="val-na">n/a</span>'}</span></div>`).join('') || '<div class="val-na">indices unavailable</div>'}
      </div></div>
      <div class="rail-box"><div class="rail-head">Top Research</div><div class="rail-body">
        ${(secs.EDITORIALS.slice(8, 14).concat(secs.FEATURED.slice(8, 12))).map(n => `<div class="rail-item"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a><span class="r-src">${esc(n.subreddit || n.source || '')}</span></div>`).join('') || '<div class="val-na">no further items today</div>'}
      </div></div>
    </div></div>
    <div class="bbg-note">Sections are assigned by rule (source and URL), never by hand. GEN items are templated sentences computed from the index table on load. ${esc(r.note || '')}</div>`);
  host.querySelectorAll('[data-idx]').forEach(el => el.addEventListener('click', () => runFunction('DES', el.dataset.idx)));
} };

// ---- DECK: price a decklist as a portfolio. Two entries: the META LIBRARY
// (top archetypes per format harvested nightly from mtgtop8) and the BUILDER
// (paste your own). Lines like "4 Lightning Bolt", "4x ..." or bare names.
// Resolution: live server by name; offline via the finder catalog.
function parseDecklist(text) {
  const out = [];
  for (let line of String(text || '').split(/\n+/)) {
    line = line.trim();
    if (!line || /^(deck|sideboard|commander|companion|maybeboard)\b/i.test(line) || line.startsWith('//')) continue;
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    const qty = m ? parseInt(m[1], 10) : 1;
    const name = (m ? m[2] : line).replace(/\s*[([].*$/, '').trim();
    if (name) out.push({ qty, name });
  }
  return out;
}
async function resolveDeckCard(name) {
  if (!STATE.static) {
    try {
      const r = await apiFetch(`/api/security/${name}`);
      if (r.security && r.security.type === 'CARD') {
        const d = r.details || {};
        let cheap = null;
        for (const pr of (r.printings || [])) {
          if (isNum(pr.tcg_price) && (!cheap || pr.tcg_price < cheap.tcg_price)) cheap = pr;
        }
        return { found: true, uuid: r.security.id, set_code: d.set_code, price: d.tcg_price,
                 cheapest: cheap && isNum(d.tcg_price) && cheap.tcg_price < d.tcg_price ? cheap : null };
      }
    } catch (e) { /* fall through */ }
    return { found: false };
  }
  await secfCatalog();
  const nl = name.toLowerCase();
  const hits = (SECF_CATALOG || []).filter(c => c.type === 'CARD' && String(c.name || '').toLowerCase() === nl && isNum(c.price));
  if (!hits.length) {
    // second offline tier: the Scryfall price map baked alongside the meta deck
    // library (real prices, no history, no budget substitution)
    if (DECK_PRICES === null) {
      try { const r = await fetch('data/api/deck_prices.json'); DECK_PRICES = r.ok ? await r.json() : { prices: {} }; }
      catch (e) { DECK_PRICES = { prices: {} }; }
    }
    const hit = (DECK_PRICES.prices || {})[nl];
    if (hit) return { found: true, uuid: null, set_code: hit.set, price: hit.usd, cheapest: null, offlineSnap: true };
    return { found: false };
  }
  hits.sort((a, b) => (a.price || 0) - (b.price || 0));
  const best = hits[hits.length - 1], cheap = hits[0];
  return { found: true, uuid: best.id, set_code: best.ticker, price: best.price,
           cheapest: hits.length > 1 && cheap.price < best.price ? { set_code: cheap.ticker, tcg_price: cheap.price, uuid: cheap.id } : null };
}

// Deck value history: sum the constituents' daily prices. A date only counts
// when cards covering at least 70% of the deck's priced value have an
// observation that day, and the coverage is always printed, so a thin offline
// bundle cannot silently draw a fake series.
async function deckHistory(rows) {
  const found = rows.filter(r => r.found && r.uuid && isNum(r.price)).slice(0, 80);
  const totalValue = found.reduce((a, r) => a + r.price * r.qty, 0);
  if (!found.length || totalValue <= 0) return null;
  const byDate = {};
  let chartedValue = 0;
  await Promise.all(found.map(async r => {
    try {
      const ch = await apiFetch(`/api/chart/${r.uuid}`, { range: 'ALL' });
      const s = (ch.series || []).find(x => x.axis !== 'R') || ch.series[0];
      const pts = (s.points || []).map(p => [p.d || p.date || p[0], p.v ?? p.value ?? p[1]]).filter(p => isNum(p[1]));
      if (!pts.length) return;
      chartedValue += r.price * r.qty;
      for (const [d, v] of pts) {
        const cell = byDate[d] || (byDate[d] = { sum: 0, covered: 0 });
        cell.sum += v * r.qty;
        cell.covered += r.price * r.qty;
      }
    } catch (e) { /* card without baked history: excluded, reflected in coverage */ }
  }));
  const dates = Object.keys(byDate).sort();
  const points = dates.filter(d => byDate[d].covered >= 0.7 * totalValue).map(d => [d, Math.round(byDate[d].sum * 100) / 100]);
  return { points, coveragePct: Math.round(100 * chartedValue / totalValue), nCharted: found.length, totalValue };
}

let DECK_PRICES = null;
let META_DECKS = null;
// One name->price map for valuing whole decks offline: finder catalog first
// (nightly build prices), Scryfall snapshot second. The live server sends
// deck values computed from the nightly build instead (deck.value).
async function offlinePriceMap() {
  await secfCatalog();
  if (DECK_PRICES === null) {
    try { const r = await fetch('data/api/deck_prices.json'); DECK_PRICES = r.ok ? await r.json() : { prices: {} }; }
    catch (e) { DECK_PRICES = { prices: {} }; }
  }
  // Deck valuation = cost to BUY the deck. Snapshot only: the finder catalog
  // holds the top-priced securities (collector printings), so any catalog
  // fill can only inflate a deck (a serialized Watery Grave once priced a
  // Standard deck at $8k). Unpriced names count against the coverage figure.
  const map = {};
  for (const [k, v] of Object.entries(DECK_PRICES.prices || {})) map[k] = v.usd;
  return map;
}
function valueDeck(deck, priceMap) {
  let value = 0, pricedQty = 0, totalQty = 0;
  for (const c of (deck.cards || [])) {
    totalQty += c.qty;
    const pv = priceMap[String(c.name || '').toLowerCase()];
    if (isNum(pv)) { value += pv * c.qty; pricedQty += c.qty; }
  }
  return { value, coverage: totalQty ? Math.round(100 * pricedQty / totalQty) : 0 };
}
async function metaDecks() {
  if (META_DECKS) return META_DECKS;
  try { META_DECKS = await apiFetch('/api/metadecks'); }
  catch (e) { META_DECKS = { decks: [], as_of: null, note: 'Meta deck library not harvested yet: run  python 09_Automations/mtg_cli.py metadecks' }; }
  return META_DECKS;
}

SCREENS.DECK = { name: 'Deck Pricer', render: async (host, q) => {
  const st = STATE.tables.deckState || (STATE.tables.deckState = { view: 'META', fmt: 'ALL', text: '', label: '' });
  if (q && q.length > 3) { st.text = q; st.label = ''; st.view = 'BUILD'; }
  const tb = (id, label) => `<button class="eco-tb-item ${st.view === id ? 'on' : ''}" data-dview="${id}">${label}</button>`;

  // ---------- META LIBRARY ----------
  if (st.view === 'META') {
    const md = await metaDecks();
    const decks = md.decks || [];
    if (decks.length && !decks[0]._valued) {
      const pm = (!STATE.static && isNum(decks[0].value)) ? null : await offlinePriceMap();
      for (const d of decks) {
        if (isNum(d.value)) { d._cov = d.coverage ?? 100; }
        else if (pm) { const v = valueDeck(d, pm); d.value = v.value; d._cov = v.coverage; }
        d._valued = true;
      }
    }
    const formats = ['ALL', ...new Set(decks.map(d => d.format))];
    const shown = decks.filter(d => st.fmt === 'ALL' || d.format === st.fmt);
    const cols = [
      { key: 'format', label: 'Format', left: true, fmt: v => `<span class="secf-type">${esc(v)}</span>` },
      { key: 'archetype', label: 'Archetype', left: true, fmt: v => `<span class="sec-name">${esc(v)}</span>` },
      { key: 'cards', label: 'Main', fmt: v => num((v || []).reduce((a, c) => a + c.qty, 0), 0) },
      { key: 'sideboard', label: 'SB', fmt: v => num((v || []).reduce((a, c) => a + c.qty, 0), 0) },
      { key: 'value', label: 'Full price', fmt: (v, row) => isNum(v) && v > 0 ? `<span class="sec-price">${px(v, 0)}</span>` : '<span class="val-na">n/a</span>' },
      { key: '_cov', label: 'Priced', fmt: v => isNum(v) ? (v >= 95 ? `<span class="val-up">${v}%</span>` : v >= 60 ? `<span style="color:var(--yellow)">${v}%</span>` : `<span class="val-down">${v}%</span>`) : '' },
      { key: 'url', label: 'Source', left: true, sort: false, fmt: v => v ? `<a href="${esc(v)}" target="_blank" rel="noopener" style="color:var(--cyan)">mtgtop8</a>` : '' }];
    host.innerHTML = panel(fnTitle('DECK', 'DECK PRICER — META LIBRARY'), `
      <div class="eco-toolbar">${tb('META', '1) Meta Decks')}${tb('BUILD', '2) Deck Builder')}
        <span class="eco-range">${decks.length ? `${decks.length} DECKS · AS OF ${esc(md.as_of || '')} · ${esc(md.source || '')}` : ''}</span></div>
      <div class="chart-controls" style="padding:4px 8px">${formats.map(f => `<button class="bbg-tab-btn ${f === st.fmt ? 'on' : ''}" data-fmt="${esc(f)}">${esc(f.toUpperCase())}</button>`).join('')}</div>
      ${decks.length ? table(cols, shown, { menu: true, onRow: (row) => {
        st.text = row.cards.map(c => `${c.qty} ${c.name}`).join('\n');
        st.label = `${row.format} — ${row.archetype}`;
        st.view = 'BUILD';
        runFunction('DECK', '', false);
      } }) : `<div class="bbg-note warn">${esc(md.note || 'No meta decks harvested yet.')}</div>`}
      <div class="bbg-note">Click an archetype for the card-by-card pricing. Full price = cost to buy the mainboard at the cheapest printing per card; Priced = share of cards with a quote. ${esc(md.note || '')}</div>`);
    host.querySelectorAll('[data-fmt]').forEach(b => b.addEventListener('click', () => { st.fmt = b.dataset.fmt; runFunction('DECK', '', false); }));
    host.querySelectorAll('[data-dview]').forEach(b => b.addEventListener('click', () => { st.view = b.dataset.dview; runFunction('DECK', '', false); }));
    return;
  }

  // ---------- BUILDER / PRICED DECK ----------
  const text = st.text || '';
  const items = parseDecklist(text);
  let rows = [], totLow = 0, totMkt = 0, nFound = 0, nMiss = 0;
  if (items.length) {
    host.innerHTML = panel(fnTitle('DECK', 'DECK PRICER'), `<div class="bbg-note">PRICING ${items.length} LINES…</div>`);
    const resolved = await Promise.all(items.map(it => resolveDeckCard(it.name)));
    rows = items.map((it, i) => {
      const r = resolved[i];
      if (r.found) nFound++; else nMiss++;
      const mkt = r.found && isNum(r.price) ? r.price * it.qty : null;
      const low = r.found ? (r.cheapest ? r.cheapest.tcg_price : r.price) : null;
      const lowTot = isNum(low) ? low * it.qty : null;
      if (isNum(mkt)) totMkt += mkt;
      if (isNum(lowTot)) totLow += lowTot;
      return { qty: it.qty, name: it.name, found: r.found, uuid: r.uuid, set_code: r.set_code,
               price: r.price, line_total: mkt, cheapest: r.cheapest, line_low: lowTot };
    });
  }
  const cols = [
    { key: 'qty', label: 'Qty', fmt: v => num(v, 0) },
    { key: 'name', label: 'Card', left: true, fmt: (v, row) => row.found ? `<span class="sec-name">${esc(v)}</span>` : `<span class="val-na">${esc(v)}</span>` },
    { key: 'set_code', label: 'Set', left: true, fmt: v => v ? `<span class="sec-code">${esc(v)}</span>` : '<span class="val-na">not found</span>' },
    { key: 'price', label: 'Unit (mkt)', fmt: v => px(v) },
    { key: 'line_total', label: 'Line total', fmt: v => px(v) },
    { key: 'cheapest', label: 'Budget printing', left: true, sort: false,
      fmt: (v, row) => v ? `<span class="sec-code">${esc(v.set_code)}</span> ${px(v.tcg_price)} <span class="val-up">(-${(100 * (1 - v.tcg_price / row.price)).toFixed(0)}%)</span>` : row.found ? '<span class="val-na">already cheapest</span>' : '' },
    { key: 'line_low', label: 'Line (budget)', fmt: v => px(v) }];
  const summary = items.length ? `<div class="bbg-sec-summary-grid">
      ${statBox(st.label ? esc(st.label.toUpperCase()) : 'DECK AT MARKET', px(totMkt), st.label ? `at market · ${nFound} priced / ${nMiss} not found` : `${nFound} priced / ${nMiss} not found`)}
      ${statBox('DECK AT BUDGET PRINTINGS', px(totLow), isNum(totMkt) && totMkt > 0 ? `saves ${pctPlain(100 * (1 - totLow / totMkt))}` : '')}
      ${statBox('LINES', String(items.length), STATE.static ? 'offline: only catalog cards price' : 'priced from the nightly build')}
    </div>` : '';
  host.innerHTML = panel(fnTitle('DECK', `DECK PRICER${st.label ? ' — ' + esc(st.label.toUpperCase()) : ' — PORTFOLIO VIEW OF A DECKLIST'}`), `
    <div class="eco-toolbar">${tb('META', '1) Meta Decks')}${tb('BUILD', '2) Deck Builder')}</div>
    <div style="padding:8px"><textarea id="deckText" class="bbg-filter-input" style="width:100%;height:96px;resize:vertical;font-family:var(--font-terminal)"
      placeholder="4 Lightning Bolt&#10;4x Ragavan, Nimble Pilferer&#10;1 Black Lotus&#10;(one card per line; MTGA / Moxfield exports paste straight in)">${esc(text)}</textarea>
      <button class="bbg-mini" id="deckGo" style="margin-top:4px">PRICE DECK</button>
      <button class="bbg-mini" id="deckClr">CLEAR</button>
      ${items.length ? '<button class="bbg-mini" id="deckHist">CHART DECK VALUE</button>' : ''}</div>
    ${summary}
    <div id="deckHistBox" hidden>${panel('DECK VALUE HISTORY', '<div class="chart-box short"><canvas id="deckChart"></canvas></div><div class="bbg-note" id="deckHistNote"></div>')}</div>
    ${items.length ? table(cols, rows, { menu: true, onRow: (row) => row.found && row.uuid ? runFunction('DES', row.uuid) : msg(row.found ? 'OFFLINE SNAPSHOT PRICE — FULL PAGE NEEDS THE LIVE SERVER' : 'CARD NOT RESOLVED — CHECK THE SPELLING OR USE SECF', !row.found) }) : ''}
    <div class="bbg-note">Market = the printing a bare name resolves to (highest-priced). Budget = cheapest priced printing of the same card. ${STATE.static ? 'OFFLINE: resolution is limited to the finder catalog; the live server resolves the full card database.' : ''}</div>`);
  host.querySelectorAll('[data-dview]').forEach(b => b.addEventListener('click', () => { st.view = b.dataset.dview; runFunction('DECK', '', false); }));
  host.querySelector('#deckGo').addEventListener('click', () => { st.text = host.querySelector('#deckText').value; st.label = ''; runFunction('DECK', '', false); });
  host.querySelector('#deckClr').addEventListener('click', () => { st.text = ''; st.label = ''; runFunction('DECK', '', false); });
  const hb = host.querySelector('#deckHist');
  if (hb) hb.addEventListener('click', async () => {
    hb.disabled = true; hb.textContent = 'LOADING HISTORY…';
    const h = await deckHistory(rows);
    const box = host.querySelector('#deckHistBox');
    box.hidden = false;
    if (!h || h.points.length < 2) {
      host.querySelector('#deckHistNote').textContent = h
        ? `Not enough history: only ${h.coveragePct}% of the deck's value has price history ${STATE.static ? 'in this offline bundle' : 'in the lake'}, below the 70% coverage bar.`
        : 'No priced cards to chart.';
      hb.textContent = 'CHART DECK VALUE';
      hb.disabled = false;
      return;
    }
    new TermChart('deckChart', { showMA: false, title: `DECK VALUE (SUM OF CONSTITUENTS) · ${st.label || 'CUSTOM'}` })
      .setSeries([{ key: 'deck', label: 'DECK VALUE $', color: '#ff9900', axis: 'L', points: h.points.map(p => ({ d: p[0], v: p[1] })) }]);
    host.querySelector('#deckHistNote').textContent =
      `Sum of ${h.nCharted} constituents' daily prices, quantity-weighted. History covers ${h.coveragePct}% of the deck's current value; dates below 70% coverage are dropped rather than interpolated.`;
    hb.textContent = 'CHART DECK VALUE';
    hb.disabled = false;
  });
} };

// ---- CORR: correlation matrix + beta to MTGCOMP across the indices, computed
// client-side from the same chart series both live and offline. Daily CHANGES,
// not levels: two trending series always show high level-correlation.
async function indexReturns(code) {
  const ch = await apiFetch(`/api/chart/${code}`, { range: 'ALL' });
  const s = (ch.series || []).find(x => x.axis !== 'R') || ch.series[0];
  const byDate = {};
  for (const p of (s.points || [])) byDate[p.d || p.date || p[0]] = p.v ?? p.value ?? p[1];
  const dates = Object.keys(byDate).sort();
  const rets = {};
  for (let i = 1; i < dates.length; i++) {
    const a = byDate[dates[i - 1]], b = byDate[dates[i]];
    if (isNum(a) && isNum(b) && a > 0) rets[dates[i]] = b / a - 1;
  }
  return rets;
}
function corrOf(r1, r2) {
  const ds = Object.keys(r1).filter(d => d in r2);
  if (ds.length < 10) return { corr: null, n: ds.length, beta: null };
  const x = ds.map(d => r1[d]), y = ds.map(d => r2[d]);
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
  const beta = syy > 0 ? sxy / syy : null; // beta of series1 to series2
  return { corr, beta, n: ds.length };
}
SCREENS.CORR = { name: 'Correlation Matrix', render: async (host, q) => {
  const w = STATE.wei || await apiFetch('/api/wei');
  STATE.wei = w;
  const codes = (q ? q.toUpperCase().replace(/\s+/g, '').split(',') : w.indices.map(i => i.code)).slice(0, 14);
  host.innerHTML = panel(fnTitle('CORR', 'CORRELATION MATRIX'), `<div class="bbg-note">LOADING ${codes.length} INDEX SERIES…</div>`);
  const rets = {};
  await Promise.all(codes.map(async c => { try { rets[c] = await indexReturns(c); } catch (e) { rets[c] = null; } }));
  const ok = codes.filter(c => rets[c] && Object.keys(rets[c]).length >= 10);
  const cell = (v) => {
    if (!isNum(v)) return '<td class="val-na">--</td>';
    const a = Math.abs(v);
    const col = v >= 0 ? `rgba(0,255,102,${(0.08 + 0.5 * a).toFixed(2)})` : `rgba(255,51,51,${(0.08 + 0.5 * a).toFixed(2)})`;
    return `<td style="background:${col};color:#fff;text-align:center">${v.toFixed(2)}</td>`;
  };
  let matrix = `<div class="bbg-table-wrapper" style="max-height:560px"><table class="bbg-table"><thead><tr><th class="text-left">vs</th>${ok.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
  for (const r of ok) {
    matrix += `<tr><td class="text-left"><span class="sec-code">${r}</span></td>`;
    for (const c of ok) matrix += r === c ? '<td style="text-align:center;color:#666">1.00</td>' : cell(corrOf(rets[r], rets[c]).corr);
    matrix += '</tr>';
  }
  matrix += '</tbody></table></div>';
  const betaRows = ok.filter(c => c !== 'MTGCOMP').map(c => {
    const b = corrOf(rets[c], rets['MTGCOMP'] || {});
    return { code: c, name: (w.indices.find(i => i.code === c) || {}).name, beta: b.beta, corr: b.corr, n: b.n };
  });
  const bCols = [
    { key: 'code', label: 'Index', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` },
    { key: 'name', label: 'Name', left: true },
    { key: 'beta', label: 'Beta to MTGCOMP', fmt: v => isNum(v) ? `<span class="sec-price">${v.toFixed(2)}</span>` : '<span class="val-na">n/a</span>' },
    { key: 'corr', label: 'Corr', fmt: v => isNum(v) ? v.toFixed(2) : '<span class="val-na">n/a</span>' },
    { key: 'n', label: 'Obs', fmt: v => num(v, 0) }];
  host.innerHTML = panel(fnTitle('CORR', `CORRELATION MATRIX — ${ok.length} INDICES, DAILY CHANGES`), `
    <div class="grid-32" style="padding:6px">
      <div>${panel('<span class="code">1)</span> PAIRWISE CORRELATION (PEARSON, DAILY RETURNS)', matrix)}</div>
      <div>${panel('<span class="code">2)</span> BETA TO MTGCOMP', table(bCols, betaRows, { menu: true, onRow: (row) => runFunction('DES', row.code) }))}</div></div>
    <div class="bbg-note">Computed on daily index CHANGES over the full common history (levels would overstate co-movement between trending series). Green = positive, red = negative, intensity = strength. CORR MTGCOMP,MTGRL,SLDCOMP &lt;GO&gt; restricts the set.</div>`);
} };

// ---- GRR: periodic-table return quilt, monthly returns per index ranked per column.
SCREENS.GRR = { name: 'Return Quilt', render: async (host) => {
  const w = STATE.wei || await apiFetch('/api/wei');
  STATE.wei = w;
  const codes = w.indices.map(i => i.code);
  host.innerHTML = panel(fnTitle('GRR', 'RETURN QUILT'), `<div class="bbg-note">LOADING ${codes.length} INDEX SERIES…</div>`);
  const levels = {};
  await Promise.all(codes.map(async c => {
    try {
      const ch = await apiFetch(`/api/chart/${c}`, { range: 'ALL' });
      const s = (ch.series || []).find(x => x.axis !== 'R') || ch.series[0];
      levels[c] = (s.points || []).map(p => ({ d: p.d || p.date || p[0], v: p.v ?? p.value ?? p[1] })).filter(p => isNum(p.v));
    } catch (e) { levels[c] = []; }
  }));
  const months = new Set();
  for (const c of codes) for (const p of levels[c]) months.add(String(p.d).slice(0, 7));
  const mlist = [...months].sort();
  const monthRet = (c, m) => {
    const pts = levels[c].filter(p => String(p.d).slice(0, 7) === m);
    const prevPts = levels[c].filter(p => String(p.d).slice(0, 7) < m);
    if (!pts.length) return null;
    const start = prevPts.length ? prevPts[prevPts.length - 1].v : pts[0].v;
    const end = pts[pts.length - 1].v;
    return start > 0 ? (end / start - 1) * 100 : null;
  };
  const palette = ['#00ff66', '#7fff9f', '#c9ffdd', '#ffff99', '#ffd280', '#ffab66', '#ff8080', '#ff4d4d'];
  let cols = '';
  for (const m of mlist) {
    const ranked = codes.map(c => ({ c, r: monthRet(c, m) })).filter(x => isNum(x.r)).sort((a, b) => b.r - a.r);
    if (!ranked.length) continue;
    cols += `<div class="grr-col"><div class="grr-head">${m}</div>` + ranked.map((x, i) => {
      const col = palette[Math.min(palette.length - 1, Math.floor(i / Math.max(1, ranked.length - 1) * (palette.length - 1)))];
      return `<div class="grr-cell" data-code="${x.c}" style="background:${col}"><span>${x.c}</span><span>${x.r >= 0 ? '+' : ''}${x.r.toFixed(1)}%</span></div>`;
    }).join('') + '</div>';
  }
  host.innerHTML = panel(fnTitle('GRR', 'RETURN QUILT — MONTHLY INDEX RETURNS, RANKED'), `
    <div class="grr-grid">${cols || '<div class="bbg-note">not enough history yet</div>'}</div>
    <div class="bbg-note">Each column ranks all indices by that month's return (first and last month are partial). The quilt gains meaning as the lake accrues; singles history starts 2026-06, sealed 2026-08. Click a cell for DES.</div>`);
  host.querySelectorAll('.grr-cell').forEach(el => el.addEventListener('click', () => runFunction('DES', el.dataset.code)));
} };

// ---- FLAV: flavor text browser. Quote of the day is deterministic per date,
// so the same day shows the same quote on every machine, static bundle included.
SCREENS.FLAV = { name: 'Flavor Text Browser', render: async (host, q) => {
  const query = (q || '').trim();
  let r, quotes;
  if (STATE.static) {
    // offline: one baked sample, searched client-side
    r = await apiFetch('/api/flav', { limit: 500 });
    const needle = query.toLowerCase();
    quotes = (r.quotes || []).filter(x => !needle ||
      `${x.name} ${x.set_code} ${x.set_name} ${x.flavor}`.toLowerCase().includes(needle));
  } else {
    r = await apiFetch('/api/flav', query ? { q: query, limit: 500 } : { limit: 500 });
    quotes = r.quotes || [];
  }
  const day = new Date().toISOString().slice(0, 10);
  let h = 0;
  for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const qotd = quotes.length ? quotes[h % quotes.length] : null;
  const attr = (x) => `${esc(x.name)}${x.set_name ? ', ' + esc(x.set_name) : ''}${x.artist ? ' · art: ' + esc(x.artist) : ''}`;
  const cols = [
    { key: 'flavor', label: 'Flavor text', left: true, sort: false, fmt: v => `<span class="flav-quote-cell">${esc(v)}</span>` },
    { key: 'name', label: 'Card', left: true, fmt: v => `<span class="sec-name">${esc(v)}</span>` },
    { key: 'set_code', label: 'Set', left: true, fmt: v => `<span class="sec-code">${esc(v)}</span>` },
    { key: 'rarity', label: 'Rarity', left: true, fmt: v => `<span style="color:#ff9900">${esc(String(v || '').toUpperCase())}</span>` },
    { key: 'released', label: 'Released', left: true, sortKey: 'released', fmt: (v, row) => d10(v || row.release_date) }];
  host.innerHTML = panel(fnTitle('FLAV', query ? `FLAVOR TEXTS — "${esc(query.toUpperCase())}"` : 'FLAVOR TEXT BROWSER'), `
    ${qotd && !query ? `<div class="flav-qotd">
      <div class="flav-qotd-label">FLAVOR OF THE DAY — ${esc(day)}</div>
      <div class="flav-qotd-text">${esc(qotd.flavor)}</div>
      <div class="flav-qotd-attr">— ${attr(qotd)}</div></div>` : ''}
    <div class="bbg-filters"><label>SEARCH</label>
      <input id="flavQ" class="bbg-filter-input wide" value="${esc(query)}" placeholder="card name, set, or words inside the quote…">
      <button class="bbg-mini" id="flavGo">FIND</button>
      ${query ? '<button class="bbg-mini" id="flavClr">CLEAR</button>' : ''}
      <label style="margin-left:12px">${fmtNum(r.total || quotes.length, 0)} QUOTES IN CORPUS · SHOWING ${fmtNum(quotes.length, 0)}</label></div>
    ${table(cols, quotes, { menu: true, onRow: (row) => runFunction('DES', row.name), maxHeight: '560px' })}
    <div class="bbg-note">${esc(r.note || '')} ${esc(r.source || '')}</div>`);
  const go = () => runFunction('FLAV', host.querySelector('#flavQ').value, false);
  host.querySelector('#flavGo').addEventListener('click', go);
  host.querySelector('#flavQ').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  const clr = host.querySelector('#flavClr');
  if (clr) clr.addEventListener('click', () => runFunction('FLAV', '', false));
} };

// ---- LP Launchpad: grid of mini charts
SCREENS.LP = { name: 'Launchpad', render: async (host, q) => {
  const ids = (q || STATE.tables.lp || 'MTGCOMP,MTGRL,SLDCOMP,MTGUB').toUpperCase().replace(/\s*,\s*/g, ',').trim();
  STATE.tables.lp = ids;
  const list = ids.split(',').filter(Boolean).slice(0, 4);
  const ranges = ['1M', '3M', '6M', '1Y', 'ALL'];
  const rng = STATE.chartRange === '1W' ? '1M' : STATE.chartRange;
  const ctl = `<div class="chart-controls">${ranges.map(x => `<button class="bbg-tab-btn ${x === rng ? 'on' : ''}" data-range="${x}">${x}</button>`).join('')}</div>`;
  host.innerHTML = panel(fnTitle('LP', `LAUNCHPAD — ${list.length} PANELS · ${rng}`), `
    <div class="bbg-filters"><label>SECURITIES (comma-separated, max 4)</label>
    <input id="lpIds" class="bbg-filter-input wide" style="width:420px" value="${esc(ids)}"><button class="bbg-mini" id="lpGo">LOAD</button></div>
    <div class="lp-grid">${list.map((id, i) => `<div class="lp-cell">
      <div class="lp-head" data-sec="${esc(id)}"><span><span class="code">${esc(id)}</span> <span id="lpName${i}" class="val-na"></span></span><span id="lpStat${i}"></span></div>
      <div class="chart-box"><canvas id="lpChart${i}"></canvas></div></div>`).join('')}</div>
    <div class="bbg-note">Click a panel header for the full GP. LP MTGCOMP,MH3,LTR CBX,SLDCOMP &lt;GO&gt; loads any four securities.</div>`, { controls: ctl });
  host.querySelector('#lpGo').addEventListener('click', () => runFunction('LP', host.querySelector('#lpIds').value));
  host.querySelector('#lpIds').addEventListener('keydown', e => { if (e.key === 'Enter') runFunction('LP', host.querySelector('#lpIds').value); });
  host.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => { STATE.chartRange = b.dataset.range; runFunction('LP', ids, false); }));
  host.querySelectorAll('.lp-head').forEach(h => h.addEventListener('click', () => runFunction('GP', h.dataset.sec)));
  await Promise.all(list.map(async (id, i) => {
    try {
      const ch = await apiFetch(`/api/chart/${id}`, { range: rng });
      const st = ch.stats || {};
      const isIdx = ch.security.type === 'INDEX' || ch.security.type === 'SET';
      document.getElementById(`lpName${i}`).textContent = (ch.security.name || '').slice(0, 30);
      document.getElementById(`lpStat${i}`).innerHTML = `${isIdx ? num(st.last) : px(st.last)} ${pct(st.chg_pct)}`;
      new TermChart(`lpChart${i}`, { showMA: false }).setSeries(ch.series.filter(s => s.axis !== 'R'));
    } catch (e) {
      const el = document.getElementById(`lpName${i}`); if (el) el.textContent = String(e.message || e).slice(0, 40);
    }
  }));
} };

// ---- ALLQ sealed depth: top listed asks per product from the depth lake
SCREENS.ALLQ = { name: 'Depth of Book', needsSecurity: true, render: async (host, q) => {
  const r = await apiFetch(`/api/allq/${q}`);
  STATE.security = r.security;
  const s = r.security;
  const cols = [
    { key: 'venue', label: 'Venue', left: true, fmt: v => `<span class="secf-type">${esc(v)}</span>` },
    { key: 'seller', label: 'Seller', left: true },
    { key: 'condition', label: 'Cond', left: true },
    { key: 'price', label: 'Ask', fmt: v => `<span class="sec-price">${px(v)}</span>` },
    { key: 'shipping', label: 'Ship', fmt: v => isNum(v) ? px(v) : '<span class="val-na">n/a</span>' },
    { key: 'total', label: 'All-in', fmt: v => px(v) },
    { key: 'qty', label: 'Qty', fmt: v => num(v, 0) }];
  const st = r.stats || {};
  host.innerHTML = panel(fnTitle('ALLQ', 'DEPTH OF BOOK — LISTED ASKS', secLabel(s)), fnLinks(s, 'ALLQ') + `
    ${r.sample ? '<div class="allq-note-sample">SAMPLE DATA — the depth harvester has not run yet. Numbers below are placeholders for UX work, not observed asks. Delete terminal/data/api/allq__*.json after the first real snapshot.</div>' : ''}
    <div class="bbg-sec-summary-grid">
      ${statBox('BEST ASK', px(st.best_ask), `${st.n || 0} listings captured`)}
      ${statBox('MEDIAN ASK', px(st.median_ask), `as of ${esc(d10(r.as_of))}`)}
      ${statBox('REF MARKET', px(st.tcg_market), 'TCGplayer market (last sold)')}
      ${statBox('DEALER BID', px(st.ck_buylist), 'Card Kingdom buylist')}
      ${statBox('BID-ASK PROXY', pct(st.spread_pct), 'best ask vs dealer bid')}
    </div>
    ${table(cols, r.rows || [], { maxHeight: '480px' })}
    <div class="bbg-note">${esc(r.note || 'Depth is snapshotted nightly for sealed products only. eBay-sourced rows may be published; scraped rows stay local.')}</div>`, { asof: r.as_of });
  bindFnLinks(s);
} };

SCREENS.CN = { name: 'Security News', needsSecurity: true, render: async (host, q) => {
  const r = await apiFetch(`/api/cn/${q}`, { limit: 15 });
  STATE.security = r.security;
  const items = (r.hits || []).map((h, i) => { STATE.menu.push({ label: h.title, run: () => window.open(h.url, '_blank') }); return `<div class="news-item"><span class="menu-num">${i + 1})</span><span class="news-time">${esc(h.date)}</span><span class="news-source">BM25 ${h.score}</span><span class="news-title"><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a></span></div>${h.snippet ? `<div class="news-snippet">${esc(h.snippet)}</div>` : ''}`; }).join('');
  host.innerHTML = panel(fnTitle('CN', 'SECURITY NEWS', secLabel(r.security)), fnLinks(r.security, 'CN') + `<div class="bbg-note">Query: "${esc(r.query)}"${r.error ? ' · ' + esc(r.error) : ''}</div><div class="news-feed">${items || '<div class="bbg-note">No harvested thread matches.</div>'}</div>`);
  bindFnLinks(r.security);
} };

SCREENS.ALRT = { name: 'Alerts', render: async (host, q) => {
  const r = await apiFetch('/api/alerts');
  const cols = [{ key: 'ticker', label: 'Ticker', left: true, fmt: (v, a) => `<span class="sec-code">${esc(v || a.security_id)}</span>` }, { key: 'name', label: 'Security', left: true }, { key: 'condition', label: 'Cond', left: true, fmt: v => v.toUpperCase() },
    { key: 'level', label: 'Level', fmt: v => num(v) }, { key: 'current', label: 'Current', fmt: v => num(v) }, { key: 'triggered', label: 'Status', left: true, fmt: v => v ? '<span class="val-down" style="font-weight:bold">TRIGGERED</span>' : '<span class="val-na">watching</span>' },
    { key: 'note', label: 'Note', left: true }, { key: 'created', label: 'Created', left: true }, { key: 'id', label: '', sort: false, fmt: v => `<button class="bbg-mini" data-del="${v}">DEL</button>` }];
  const form = STATE.static
    ? '<div class="bbg-note">STATIC BUNDLE: alerts are read-only offline. Add or delete alerts on the live server; they are evaluated on every analytics build.</div>'
    : `<div class="alert-form"><label style="color:#888;font-size:10px">SECURITY</label><input id="alSec" class="bbg-filter-input wide" value="${esc(q || (STATE.security ? secQuery(STATE.security) : ''))}">
    <select id="alCond" class="bbg-select"><option value="above">ABOVE</option><option value="below">BELOW</option></select><input id="alLvl" class="bbg-filter-input" placeholder="level"><input id="alNote" class="bbg-filter-input wide" placeholder="note"><button class="bbg-mini" id="alAdd">ADD ALERT</button></div>`;
  host.innerHTML = panel(fnTitle('ALRT', 'PRICE ALERTS'), `${form}
    ${table(cols, r.alerts, { onRow: (a) => runFunction('DES', a.security_type === 'CARD' ? a.security_id : (a.ticker || a.security_id)) })}<div class="bbg-note">Alerts are evaluated against the latest analytics build each time this screen loads. Stored in 02_Data/terminal_alerts.json.</div>`);
  if (STATE.static) { setTimeout(() => host.querySelectorAll('[data-del]').forEach(b => b.remove()), 0); return; }
  host.querySelector('#alAdd').addEventListener('click', async () => {
    try {
      await apiFetch('/api/alerts', {}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ security: host.querySelector('#alSec').value, condition: host.querySelector('#alCond').value, level: host.querySelector('#alLvl').value, note: host.querySelector('#alNote').value }) });
      runFunction('ALRT', '', false);
    } catch (e) { msg(String(e.message).toUpperCase(), true); }
  });
  host.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async (e) => { e.stopPropagation(); await fetch(`/api/alerts/${b.dataset.del}`, { method: 'DELETE' }); runFunction('ALRT', '', false); }));
} };

// ------------------------------------------------------------------ ribbon + status
async function loadStatus() {
  try {
    const s = await apiFetch('/api/status');
    STATE.status = s;
    document.getElementById('statusTime').textContent = s.timestamp;
    document.getElementById('statusData').textContent = `${fmtNum(s.records.sealed_priced, 0)} SEALED · ${fmtNum(s.records.cards_priced, 0)} CARDS · SINGLES ${s.singles_range[1]} · LAKE ${s.sealed_range[1]} (${s.sealed_snapshot_days}D)${STATE.static ? ' · STATIC BUNDLE' : ''}`;
    // Staleness gate: a silently dead nightly job must not lie. > 48h since the analytics build = red STALE flag.
    const builtMs = Date.parse(String(s.built_at || '').replace(' ', 'T'));
    if (!isNaN(builtMs) && (Date.now() - builtMs) > 48 * 3600 * 1000) {
      const days = Math.floor((Date.now() - builtMs) / 86400000);
      document.getElementById('statusData').insertAdjacentHTML('beforeend', `<span class="stale-flag">STALE ${days}D</span>`);
    }
    document.getElementById('footerProvenance').textContent = `URZA TOWER CAPITAL LP — analytics built ${s.built_at} — EURUSD ${s.eurusd} (${s.eurusd_source}) — public vendor prices only, no terminal data`;
  } catch (e) { document.getElementById('statusData').textContent = 'OFFLINE'; }
}
async function loadRibbon() {
  try {
    const w = STATE.wei || await apiFetch('/api/wei');
    STATE.wei = w;
    const pick = ['MTGCOMP', 'MTGRL', 'MTGUB', 'MTGCUR', 'MTGVINT', 'SLDCOMP', 'SLDCOLL'];
    const items = pick.map(c => w.indices.find(i => i.code === c)).filter(Boolean).map(i => `<div class="ticker-item" data-code="${i.code}" style="cursor:pointer"><span class="ticker-name">${i.code}:</span> <span class="ticker-val">${fmtNum(i.level, 2)}</span> ${isNum(i.chg_1d) ? `<span class="${i.chg_1d >= 0 ? 'val-up' : 'val-down'}">${i.chg_1d >= 0 ? '▲' : '▼'} ${i.chg_1d >= 0 ? '+' : ''}${i.chg_1d.toFixed(2)}%</span>` : '<span class="val-na">1D n/a</span>'}</div>`);
    const s = STATE.status;
    if (s && s.eurusd) items.push(`<div class="ticker-item"><span class="ticker-name">EURUSD:</span> <span class="ticker-val">${s.eurusd}</span> <span class="ribbon-static">${s.eurusd_date}</span></div>`);
    document.getElementById('ribbon').innerHTML = items.join('');
    document.querySelectorAll('#ribbon [data-code]').forEach(el => el.addEventListener('click', () => runFunction('DES', el.dataset.code)));
  } catch (e) { document.getElementById('ribbon').innerHTML = '<div class="ticker-item ribbon-static">INDICES UNAVAILABLE</div>'; }
}

// ------------------------------------------------------------------ login overlay (cosmetic, no auth)
function initLogin() {
  const ov = document.getElementById('loginOverlay');
  if (!ov) return;
  if (sessionStorage.getItem('ut_logged')) { ov.remove(); return; }
  const dismiss = () => {
    sessionStorage.setItem('ut_logged', '1');
    ov.remove();
    document.removeEventListener('keydown', onKey, true);
    const input = document.getElementById('cmdInput');
    if (input) input.focus();
  };
  // No auth by design: any key or click drops into the terminal.
  const onKey = (e) => { e.preventDefault(); dismiss(); };
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('click', (e) => {
    if (e.target.closest('#loginContact, #loginCreate')) {
      e.target.textContent = 'There is no one to call. Press any key.';
      return;
    }
    dismiss();
  });
  const btn = ov.querySelector('#loginBtn');
  if (btn) btn.focus();
}

// ------------------------------------------------------------------ boot
document.addEventListener('DOMContentLoaded', async () => {
  initLogin();
  try { const r = await fetch('/api/status', { cache: 'no-store' }); STATE.static = !r.ok; } catch (e) { STATE.static = true; }
  const input = document.getElementById('cmdInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { if (secfIdx >= 0) pickSecf(secfIdx); else executeCommand(input.value); }
    else if (e.key === 'Escape') { hideSecf(); input.value = ''; }
    else if (e.key === 'ArrowDown' && secfItems.length && !document.getElementById('secfDrop').hidden) { e.preventDefault(); secfIdx = Math.min(secfItems.length - 1, secfIdx + 1); highlightSecf(); }
    else if (e.key === 'ArrowUp' && secfItems.length) { e.preventDefault(); secfIdx = Math.max(0, secfIdx - 1); highlightSecf(); }
  });
  input.addEventListener('input', () => { clearTimeout(secfTimer); const v = input.value.trim(); const tokens = v.split(/\s+/); const last = tokens[tokens.length - 1].toUpperCase(); const qtext = (SCREENS[last] || FN_ALIASES[last]) && tokens.length > 1 ? tokens.slice(0, -1).join(' ') : v; if (SCREENS[v.toUpperCase()] || FN_ALIASES[v.toUpperCase()]) { hideSecf(); return; } secfTimer = setTimeout(() => showSecf(qtext), 180); });
  input.addEventListener('blur', () => setTimeout(hideSecf, 150));
  document.getElementById('goBtn').addEventListener('click', () => executeCommand(input.value));
  document.querySelectorAll('#navBar .bbg-tab-btn').forEach(b => b.addEventListener('click', () => runFunction(b.dataset.fn, '')));
  document.querySelectorAll('.bbg-func-key').forEach(b => b.addEventListener('click', () => {
    const f = b.dataset.func;
    if (f === 'CANCEL') { input.value = ''; hideSecf(); msg(''); runFunction('WEI'); }
    else if (f === 'HELP') runFunction('HELP'); else if (f === 'SEARCH') { input.focus(); runFunction('SECF', input.value); }
    else if (f === 'NEWS') runFunction('TOP'); else if (f === 'QUOTE') runFunction('QR', STATE.security ? secQuery(STATE.security) : '');
    else if (f === 'PORT') runFunction('PORT'); else if (f === 'MENU') runFunction('HELP'); else if (f === 'PRINT') window.print();
    else if (f === 'PGBA') navHistory(-1); else if (f === 'PGFW') navHistory(1);
  }));
  window.addEventListener('keydown', (e) => {
    const map = { F1: 'WEI', F2: 'MOV', F3: 'COMMOD', F4: 'EQS', F5: 'DECK', F6: 'CARDS', F7: 'DES', F8: 'GP', F9: 'TOP', F10: 'ECO', F11: 'LP', F12: 'FLAV' };
    if (map[e.key]) { e.preventDefault(); runFunction(map[e.key], ''); }
    else if (e.key === 'Escape' && document.activeElement !== input) { runFunction('WEI'); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navHistory(-1); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navHistory(1); }
    else if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
  });
  await loadStatus();
  await loadRibbon();
  const hash = decodeURIComponent((location.hash || '').slice(1));
  if (hash) executeCommand(hash); else runFunction('WEI');
  setInterval(loadStatus, 60000);
});
function highlightSecf() { document.querySelectorAll('#secfDrop .secf-row').forEach((r, i) => r.classList.toggle('active', i === secfIdx)); }
