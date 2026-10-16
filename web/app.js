(() => {
const $ = (s) => document.querySelector(s);
const sum = (a, f = (x) => x) => a.reduce((t, x) => t + f(x), 0);
const aic = (v) => v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 });
const int = (v) => Math.round(v).toLocaleString('en-US');
const tok = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const pct = (a, b) => Math.round((a / b) * 100) + '%';
// Bar width as a share of the whole, so a bar's length always matches its % column.
const share = (a, b) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, w) => `${int(n)} ${w}${n === 1 ? '' : 's'}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SPARK = '<svg class="octicon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M7.53 1.282a.5.5 0 0 1 .94 0l.478 1.306a7.492 7.492 0 0 0 4.464 4.464l1.305.478a.5.5 0 0 1 0 .94l-1.305.478a7.492 7.492 0 0 0-4.464 4.464l-.478 1.305a.5.5 0 0 1-.94 0l-.478-1.305a7.492 7.492 0 0 0-4.464-4.464L1.282 8.47a.5.5 0 0 1 0-.94l1.306-.478a7.492 7.492 0 0 0 4.464-4.464Z"/></svg>';
const askBtn = (label, prompt) => `<button type="button" class="btn-link f6 ask" data-ask="${esc(prompt)}">${SPARK}${esc(label)}</button>`;
const ASK_PREFIX = 'Use the copilot-usage canvas actions to look at my Copilot usage this billing period. ';
const OPEN_ICON = '<svg class="octicon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/></svg>';
// The app keeps archived sessions but can't open deleted ones, so only live sessions get a link.
const statusLabel = (s) => s.status === 'archived' ? '<span class="Label Label--secondary ml-1">Archived</span>'
  : s.status === 'deleted' ? '<span class="Label Label--secondary ml-1" title="This session is no longer in the app">Deleted</span>' : '';
const sessName = (sid, s, text = s.title) => s.status === 'open' && s.openId
  ? `<a href="ghapp://sessions/${esc(s.openId)}" class="sess-link" data-open="${esc(s.openId)}" title="Open this session">${esc(text)}${OPEN_ICON}</a>`
  : `${esc(text)}${statusLabel(s)}`;

// ---------- canvas plumbing ----------
const token = new URLSearchParams(location.search).get('t') || '';
const api = (p, body) => fetch(p, body === undefined
  ? { headers: { 'X-Token': token } }
  : { method: 'POST', headers: { 'X-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// UI state survives re-renders when fresh data arrives.
const state = { by: 'model', open: null, openSessions: new Set(), allSessions: false, builtAt: 0, day: null, allDisk: false, diskAt: 0 };
let renderBars = () => {};
let renderSessions = () => {};
let renderCalendar = () => {};

function toast(msg) {
  const host = $('#toast');
  host.innerHTML = `<div>${esc(msg)}</div>`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { host.innerHTML = ''; }, 2600);
}

function render(D) {
const P = D.period;
const start = new Date(P.start + 'T00:00:00');
const dayLabel = (d) => { const x = new Date(start); x.setDate(d); return `${MON[x.getMonth()]} ${x.getDate()}`; };

// ---------- numbers ----------
// D.daily holds actual credits per day (index 0 = day 1) up to and including today.
const daily = [D.daily.you, D.daily.sub, D.daily.auto];
const dayTotals = daily[0].map((_, i) => daily[0][i] + daily[1][i] + daily[2][i]);
const used = sum(dayTotals);                       // from this computer's logs
const complete = dayTotals.slice(0, P.today - 1);  // today is still in progress
const week = complete.slice(-7);
const localRate = week.length ? sum(week) / week.length : used / Math.max(P.elapsed, 1);
const remaining = Math.max(0, P.days - P.elapsed);
const resetIn = P.days - P.today + 1;

// GitHub's own number is the billed truth; local logs supply the breakdowns. Scale pace to the billed number.
const billed = P.serverUsed != null ? P.serverUsed : used;
const ratio = used ? billed / used : 1;
const rate = localRate * ratio;
const projected = billed + rate * remaining;

const M = D.models;
const input = sum(M, (m) => m.input);

// ---------- header + headline ----------
$('#period').textContent = `${dayLabel(1)} – ${dayLabel(P.days)} · resets in ${plural(resetIn, 'day')}`;
const gen = new Date(D.generatedAt);
$('#updated').textContent = `Updated ${MON[gen.getMonth()]} ${gen.getDate()}, ${gen.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
$('#used').textContent = int(billed);

// `?limit=N` previews the meter as if the plan had that many credits (handy on unlimited plans).
const limit = Number(new URLSearchParams(location.search).get('limit')) || P.limit;
if (limit) {
  $('#used-of').innerHTML = `of <span class="num">${int(limit)}</span> AI Credits`;
  const usedPct = Math.min(100, (billed / limit) * 100), projPct = Math.min(100, (projected / limit) * 100);
  const evenPct = Math.min(100, (P.elapsed / P.days) * 100);
  const left = Math.max(0, limit - billed);
  $('#meter').innerHTML = `
    <div class="meter-track"><div class="meter-proj" style="width:${projPct}%"></div><div class="meter-used${billed >= limit ? ' is-out' : ''}" style="width:${usedPct}%"></div></div>
    <div class="meter-wrap"><span class="meter-even" style="left:${evenPct}%" title="An even pace would put you at ${int(limit * P.elapsed / P.days)} today"></span></div>
    <div class="meter-scale f6 color-fg-muted"><span><b class="color-fg-default">${pct(billed, limit)}</b> used · ${int(left)} left</span><span class="${projected > limit ? 'color-fg-danger' : ''}">On pace for ${int(projected)} by ${dayLabel(P.days)}</span></div>`;
  $('#meter').setAttribute('aria-label', `${pct(billed, limit)} of ${int(limit)} AI Credits used, ${int(left)} left; projected ${int(projected)}`);
  const over = projected > limit, hitDay = Math.ceil(P.elapsed + (limit - billed) / rate);
  $('#outlook').className = 'callout ' + (over ? 'is-over' : 'is-ok');
  $('#outlook').innerHTML = over
    ? `At this week's pace (<b>${int(rate)}</b> credits a day) you'll run out on <b>${dayLabel(hitDay)}</b>, ${plural(P.days + 1 - hitDay, 'day')} before your credits reset.`
    : `At this week's pace (<b>${int(rate)}</b> credits a day) you'll use about <b>${int(projected)}</b> by ${dayLabel(P.days)}. You're within your limit.`;
} else {
  $('#used-of').textContent = 'AI Credits used this month';
  $('#meter').innerHTML = '';
  $('#meter').removeAttribute('aria-label');
  $('#outlook').className = 'callout is-info';
  $('#outlook').innerHTML = `Your plan has no credit limit. At this week's pace (<b>${int(rate)}</b> credits a day) you'll use about <b>${int(projected)}</b> by ${dayLabel(P.days)}.`;
}
$('#meter').hidden = !limit;

// ---------- where credits went ----------
const subAic = sum(D.subagents, (s) => s.aic), autoAic = sum(D.automations, (a) => a.aic);
const youAic = used - subAic - autoAic;
const subTok = sum(D.subagents, (s) => s.tokens), autoTok = sum(D.automations, (a) => a.tokens);
const S = (sid) => D.sessions[sid] || { title: 'Session ' + sid.slice(0, 8), project: '', started: '', status: 'deleted' };
const sessRow = (sid, v) => { const s = S(sid); return { name: s.title, sub: [s.project, s.started].filter(Boolean).join(' · '), v, sid }; };
// Children shown when a row is expanded. Anything not itemised rolls up into one muted row.
const withRest = (items, total, restLabel) => {
  items.sort((a, b) => b.v - a.v);
  const shown = items.slice(0, 8), hidden = items.length - shown.length;
  const rest = total - sum(shown, (x) => x.v);
  return { items: shown, rest: rest >= 0.5 ? { label: restLabel(hidden), v: rest } : null };
};
const autoSched = Object.fromEntries(D.automations.map((a) => [a.name, a.sched]));

const modelRow = (m) => ({
  name: m.id, v: m.aic, sub: `${plural(m.sessions, 'session')} · ${tok(m.input)} tokens sent`,
  ask: `${ASK_PREFIX}Explain my ${m.id} usage (${int(m.aic)} credits, ${pct(m.aic, used)} of my total). Which sessions drove it, and where could a cheaper model have done the job?`,
  kids: () => withRest([
    ...m.top.map(([sid, v]) => sessRow(sid, v)),
    ...m.autos.map(([n, v]) => ({ name: n, sub: autoSched[n] || '', v, auto: true }))
  ], m.aic, (h) => plural(Math.max(0, m.sessions - m.top.length) + h, 'other session'))
});

const GROUPS = {
  model: () => {
    // Fold models under 1% of credits into one row so the list stays readable.
    const sorted = [...M].sort((a, b) => b.aic - a.aic);
    const main = sorted.filter((m) => m.aic >= used * 0.01), small = sorted.filter((m) => m.aic < used * 0.01);
    const rows = main.map(modelRow);
    if (small.length) rows.push({
      name: plural(small.length, 'other model'), v: sum(small, (m) => m.aic),
      sub: `${int(sum(small, (m) => m.req))} requests · ${tok(sum(small, (m) => m.input))} tokens sent`,
      kids: () => ({ items: small.map((m) => ({ name: m.id, sub: `${int(m.req)} requests${m.aic < 0.05 ? ' · no credits charged' : ''}`, v: m.aic })), rest: null })
    });
    return rows;
  },
  source: () => [
    { name: 'You', v: youAic, sub: `${plural(D.you.sessions, 'session')} · ${tok(input - subTok - autoTok)} tokens sent`,
      ask: `${ASK_PREFIX}Which of my own sessions used the most credits, and what made them expensive?`,
      kids: () => withRest(D.you.top.map(([sid, v]) => sessRow(sid, v)), youAic,
        (h) => plural(Math.max(0, D.you.sessions - D.you.top.length) + h, 'other session')) },
    { name: 'Subagents', v: subAic, sub: `${plural(sum(D.subagents, (s) => s.runs), 'run')} · ${tok(subTok)} tokens sent`,
      ask: `${ASK_PREFIX}Which subagents cost the most (${int(subAic)} credits in total), and could any of them run on a cheaper model?`,
      kids: () => withRest(D.subagents.map((x) => ({ name: x.name, sub: [plural(x.runs, 'run'), x.model].filter(Boolean).join(' · '), v: x.aic })), subAic, (h) => plural(h, 'other type')) },
    { name: 'Automations', v: autoAic, sub: `${plural(sum(D.automations, (a) => a.runs), 'run')} · ${tok(autoTok)} tokens sent`,
      ask: `${ASK_PREFIX}Which automations cost the most per run (${int(autoAic)} credits in total), and should any of them run less often or on a cheaper model?`,
      kids: () => withRest(D.automations.map((x) => ({ name: x.name, sub: [x.sched, plural(x.runs, 'run'), x.model].filter(Boolean).join(' · '), v: x.aic })), autoAic, (h) => plural(h, 'other automation')) }
  ].filter((r) => r.v > 0),
  project: () => {
    const recent = sum(D.projects, (p) => sum(p.spark.slice(-7)));
    const sorted = [...D.projects].sort((a, b) => b.aic - a.aic);
    const small = sorted.filter((p) => p.aic < used * 0.01);
    const rows = sorted.filter((p) => p.aic >= used * 0.01).map((p) => {
      // Project pace = its share of the last 7 days applied to the remaining days.
      const share = recent ? sum(p.spark.slice(-7)) / recent : 0;
      const quiet = share < 0.005;
      return { name: p.name, v: p.aic,
        ask: `${ASK_PREFIX}Why did the ${p.name} project use ${int(p.aic)} credits? Which sessions and models drove it, and what would make it cheaper?`,
        sub: p.newToday ? `${plural(p.sessions, 'session')} · started today`
           : quiet ? `${plural(p.sessions, 'session')} · no use in the last week`
           : `${plural(p.sessions, 'session')} · on pace for ${int(p.aic + localRate * remaining * share)} by ${dayLabel(P.days)}`,
        kids: () => withRest(p.top.map(([sid, v]) => sessRow(sid, v)), p.aic, (h) => plural(Math.max(0, p.sessions - p.top.length) + h, 'other session'))
      };
    });
    if (small.length) rows.push({
      name: plural(small.length, 'other project'), v: sum(small, (p) => p.aic), sub: plural(sum(small, (p) => p.sessions), 'session'),
      kids: () => ({ items: small.map((p) => ({ name: p.name, sub: plural(p.sessions, 'session'), v: p.aic })), rest: null })
    });
    return rows;
  }
};

const kidsHtml = (parent, { items, rest }) => {
  const row = (name, sub, v, muted) => `
    <li class="kid${muted ? ' kid-rest' : ''}">
      <div class="bar-label"><span>${name}</span>${sub ? `<span class="f6 color-fg-muted">${esc(sub)}</span>` : ''}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${share(v, used)}%"></div></div>
      <span class="num">${aic(v)}</span>
      <span class="num color-fg-muted bar-pct">${pct(v, used)}</span>
    </li>`;
  const label = (x) => x.sid ? sessName(x.sid, S(x.sid)) : esc(x.name) + (x.auto ? ' <span class="Label">Automation</span>' : '');
  return `<ul class="kids">${items.map((x) => row(label(x), x.auto ? x.sub.replace('Automation · ', '') : x.sub, x.v)).join('')}${rest ? row(esc(rest.label), '', rest.v, true) : ''}</ul>` +
    (parent.ask ? `<div class="ask-row">${askBtn(`Ask Copilot about ${parent.name}`, parent.ask)}</div>` : '');
};

const chevron = '<svg class="octicon chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/></svg>';

renderBars = function (by, focusName) {
  state.by = by;
  $('#bars-col').textContent = { model: 'Model', source: 'Source', project: 'Project' }[by];
  const rows = GROUPS[by]();
  $('#bars').innerHTML = rows.map((r, i) => `
    <li><details class="bar-item" data-i="${i}">
      <summary class="bar-row">
        <div class="bar-label">
          <span class="text-bold">${chevron}${esc(r.name)}</span>
          <span class="f6 color-fg-muted">${esc(r.sub)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${share(r.v, used)}%"></div></div>
        <span class="num text-bold">${aic(r.v)}</span>
        <span class="num color-fg-muted bar-pct">${pct(r.v, used)}</span>
      </summary>
    </details></li>`).join('');
  const all = [...$('#bars').querySelectorAll('details')];
  all.forEach((d) => d.addEventListener('toggle', () => {
    const r = rows[d.dataset.i];
    if (!d.open) { if (state.open === r.name) state.open = null; return; }
    state.open = r.name;
    if (!d.querySelector('.kids')) d.insertAdjacentHTML('beforeend', kidsHtml(r, r.kids()));
    all.forEach((o) => { if (o !== d) o.open = false; });
  }));
  document.querySelectorAll('[data-by]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.by === by));
    b.classList.toggle('selected', b.dataset.by === by);
  });
  // Re-open the row the user (or the agent) had selected. Small items live inside the "N other …" row.
  const want = (focusName || state.open || '').toLowerCase();
  if (!want) return;
  let i = rows.findIndex((r) => r.name.toLowerCase() === want);
  if (i < 0) i = rows.findIndex((r) => r.kids().items.some((k) => String(k.name).toLowerCase() === want));
  if (i < 0) i = rows.findIndex((r) => r.name.toLowerCase().includes(want));
  if (i < 0) return focusName && toast(`“${focusName}” isn't in this breakdown`);
  all[i].open = true;
  if (focusName) {
    all[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
    all[i].classList.remove('is-focused'); void all[i].offsetWidth; all[i].classList.add('is-focused');
  }
};
renderBars(state.by);

// ---------- calendar: one cell per local day; select a day to zoom into its hours and sessions ----------
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CAL = D.calendar || [];
const dateOf = (k) => new Date(k + 'T00:00:00');
const longDay = (k) => { const x = dateOf(k); return `${WEEKDAY[x.getDay()]}, ${MON[x.getMonth()]} ${x.getDate()}`; };
const compact = (v) => v >= 1000 ? (v / 1000).toFixed(v >= 1e4 ? 0 : 1) + 'k' : int(v);
const hh = (h) => String(h).padStart(2, '0') + ':00';
const nowD = new Date();
const todayKey = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
// Scale to the 90th percentile so one huge day or hour doesn't wash out everything else.
const levelFor = (vals) => {
  const nz = vals.filter((v) => v > 0).sort((a, b) => a - b);
  const top = nz[Math.floor(nz.length * 0.9)] || nz[nz.length - 1] || 1;
  return (v) => { if (v < 0.5) return 0; const r = v / top; return r < 0.15 ? 1 : r < 0.4 ? 2 : r < 0.75 ? 3 : 4; };
};
const heatScale = `<div class="hm-scale f6 color-fg-muted">Less ${[0, 1, 2, 3, 4].map((l) => `<i class="hm-cell l${l}"></i>`).join('')} More</div>`;

const renderMonth = () => {
  const past = CAL.filter((c) => !c.future);
  const level = levelFor(past.map((c) => c.aic));
  const pad = CAL[0] ? (dateOf(CAL[0].date).getDay() + 6) % 7 : 0;
  // Show the month name on the first cell and on the 1st so periods that span two months read clearly.
  const dateText = (k, i) => { const x = dateOf(k); return i === 0 || x.getDate() === 1 ? `${MON[x.getMonth()]} ${x.getDate()}` : x.getDate(); };
  const cells = CAL.map((c, i) => c.future
    ? `<span class="cal-day is-future"><span class="cal-date">${dateText(c.date, i)}</span></span>`
    : `<button type="button" class="cal-day l${level(c.aic)}${c.date === todayKey ? ' is-today' : ''}" data-day="${c.date}" title="${longDay(c.date)}${c.date === todayKey ? ' (so far)' : ''} · ${int(c.aic)} credits">
        <span class="cal-date">${dateText(c.date, i)}</span><span class="cal-val num">${c.aic >= 0.5 ? compact(c.aic) : ''}</span></button>`);
  $('#cal-title').textContent = 'Credits by day';
  $('#cal-nav').innerHTML = '';
  const busiest = past.reduce((a, c) => (c.aic > (a ? a.aic : 0) ? c : a), null);
  $('#cal-lead').innerHTML = busiest
    ? `Your busiest day was <b>${longDay(busiest.date)}</b> with <b>${int(busiest.aic)}</b> credits. Select a day to see its hours and sessions.`
    : 'No usage yet this period.';
  $('#calendar').innerHTML = `<div class="cal-grid">${DAYS.map((d) => `<span class="cal-head f6 color-fg-muted">${d}</span>`).join('')}${'<span></span>'.repeat(pad)}${cells.join('')}</div>${heatScale}`;
};

const renderDay = (k) => {
  const i = CAL.findIndex((c) => c.date === k && !c.future);
  if (i < 0) { state.day = null; return renderMonth(); }
  const c = CAL[i], prev = CAL[i - 1], next = CAL[i + 1] && !CAL[i + 1].future ? CAL[i + 1] : null;
  $('#cal-title').textContent = longDay(k) + (k === todayKey ? ' (so far)' : '');
  $('#cal-nav').innerHTML = `<button class="btn btn-sm" type="button" data-day="">All days</button>
    <div class="BtnGroup"><button class="btn btn-sm BtnGroup-item" type="button" aria-label="Previous day" ${prev ? `data-day="${prev.date}"` : 'disabled'}>‹</button><button class="btn btn-sm BtnGroup-item" type="button" aria-label="Next day" ${next ? `data-day="${next.date}"` : 'disabled'}>›</button></div>`;
  let peak = 0;
  c.hours.forEach((v, h) => { if (v > c.hours[peak]) peak = h; });
  const split = [['you', 'by you'], ['sub', 'by subagents'], ['auto', 'by automations']].filter(([key]) => c[key] >= 0.5).map(([key, l]) => `${int(c[key])} ${l}`);
  $('#cal-lead').innerHTML = c.aic >= 0.5
    ? `<b>${int(c.aic)}</b> AI Credits across ${plural(c.sessions, 'session')}${split.length > 1 ? ` (${split.join(', ')})` : ''}. The busiest hour was <b>${hh(peak)}</b> with ${int(c.hours[peak])} credits.`
    : 'No credits were used on this day.';
  const level = levelFor(c.hours);
  const shown = sum(c.top, (x) => x[1]), others = c.sessions - c.top.length;
  $('#calendar').innerHTML = `
    <div class="hours">${c.hours.map((v, h) => `<span class="hm-cell hour l${level(v)}" title="${hh(h)}–${hh((h + 1) % 24)} · ${int(v)} credits">${v >= 0.5 ? compact(v) : ''}</span>`).join('')}</div>
    <div class="hours-scale f6 color-fg-muted">${[0, 3, 6, 9, 12, 15, 18, 21].map((h) => `<span style="grid-column:${h + 1} / span 3">${hh(h)}</span>`).join('')}</div>
    ${heatScale}
    ${c.top.length ? `<h3 class="f5 mt-4 mb-2">Sessions on this day</h3>
    <div class="bar-row bars-head flat f6 color-fg-muted" aria-hidden="true"><span>Session</span><span></span><span class="num">AI Credits</span><span class="num">% of day</span></div>
    <ul class="bars flat">${c.top.map(([sid, v]) => { const s = S(sid); return `<li><div class="bar-row">
      <div class="bar-label"><span>${sessName(sid, s)}${s.automation ? ' <span class="Label">Automation</span>' : ''}</span><span class="f6 color-fg-muted">${esc([s.automation, s.project].filter(Boolean).join(' · '))}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${share(v, c.aic)}%"></div></div>
      <span class="num">${aic(v)}</span><span class="num color-fg-muted bar-pct">${pct(v, c.aic)}</span></div></li>`; }).join('')}
      ${others > 0 && c.aic - shown >= 0.5 ? `<li><div class="bar-row kid-rest"><div class="bar-label"><span>${plural(others, 'other session')}</span></div><span></span><span class="num">${aic(c.aic - shown)}</span><span class="num bar-pct">${pct(c.aic - shown, c.aic)}</span></div></li>` : ''}
    </ul>` : ''}`;
};

renderCalendar = function (day) {
  const was = state.day;
  if (day !== undefined) state.day = day || null;
  // A day view replaces the whole tab: the period totals and breakdowns below don't change with the day.
  $('#app').classList.toggle('is-day', !!state.day);
  if (day !== undefined && !!was !== !!state.day) window.scrollTo({ top: 0 });
  return state.day ? renderDay(state.day) : renderMonth();
};
renderCalendar();

// ---------- sessions ----------
const median = D.medianSessionAic || 1;
$('#median').textContent = `A typical session uses ${int(median)} credits. Select a session to see which prompts cost the most.`;
const BG = '(background task finished)';
const sessHtml = (sid) => {
  const s = S(sid), x = s.aic / median;
  const subs = s.subs || [];
  const ask = `${ASK_PREFIX}Look at session ${sid} ("${s.title}", ${int(s.aic)} credits, ${int(x)}× a typical session) with get_session. What made it expensive, and what could I do differently next time?`;
  return `
  <details class="Box-row sess" data-sid="${esc(sid)}"${state.openSessions.has(sid) ? ' open' : ''}>
    <summary>
      <div class="sess-main">
        <span class="text-bold">${sessName(sid, s)}</span>
        <span class="f6 color-fg-muted">${esc([s.project, s.started, plural(s.req, 'request')].filter(Boolean).join(' · '))}</span>
      </div>
      <span>${s.live ? '<span class="Label Label--success mr-1">Active</span>' : ''}<span class="Label ${x >= 10 ? 'Label--danger' : 'Label--attention'}">${int(x)}× typical</span></span>
      <span class="num text-bold sess-aic">${int(s.aic)}</span>
    </summary>
    <ul class="prompts">
      ${s.prompts.map((p) => `
        <li>
          <div><p class="prompt-q${p.q === BG ? ' is-bg' : ''}">${esc(p.q === BG ? 'Follow-up after a background task finished' : p.q)}</p>
          <p class="f6 color-fg-muted">${plural(p.req, 'request')} · ${tok(p.ctx)} tokens sent</p></div>
          <span class="num">${int(p.aic)}</span>
        </li>`).join('')}
    </ul>
    ${subs.length ? `<p class="f6 color-fg-muted sess-subs">Subagents used ${int(sum(subs, (z) => z[2]))} of these credits: ${subs.slice(0, 4).map(([n, r, c]) => `${esc(n)} ×${r} (${int(c)})`).join(', ')}${subs.length > 4 ? ', …' : ''}.</p>` : ''}
    <div class="ask-row">${askBtn('Ask Copilot why this was expensive', ask)}</div>
  </details>`;
};
const SHOWN = 6;
renderSessions = function (focusSid) {
  const ids = D.topSessions;
  const n = state.allSessions ? Math.min(ids.length, 25) : SHOWN;
  $('#sessions').innerHTML = ids.slice(0, n).map(sessHtml).join('');
  $('#sessions').querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => {
    state.openSessions[d.open ? 'add' : 'delete'](d.dataset.sid);
  }));
  const more = $('#more-sessions');
  more.hidden = ids.length <= SHOWN;
  more.textContent = state.allSessions ? 'Show fewer' : `Show ${Math.min(ids.length, 25) - SHOWN} more`;
  if (focusSid) {
    const d = [...$('#sessions').querySelectorAll('details')].find((x) => x.dataset.sid === focusSid);
    if (!d) return toast('That session isn’t among the most expensive ones');
    d.open = true;
    d.scrollIntoView({ block: 'center', behavior: 'smooth' });
    d.classList.remove('is-focused'); void d.offsetWidth; d.classList.add('is-focused');
  }
};
renderSessions();

// ---------- tips: each one only appears if the data supports it ----------
const tips = [];
const totalReq = sum(M, (m) => m.req);
const pricey = M.filter((m) => m.aic >= used * 0.1 && m.req)
  .map((m) => ({ m, k: (m.aic / used) / (m.req / totalReq) })).sort((a, b) => b.k - a.k)[0];
if (pricey && pricey.k >= 2) tips.push({ v: pricey.m.aic,
  t: `<b>${esc(pricey.m.id)}</b> handled ${pct(pricey.m.req, totalReq)} of requests but used ${pct(pricey.m.aic, used)} of credits, about ${aic(pricey.m.aic / pricey.m.req)} per request against ${aic(used / totalReq)} on average. Save it for work that needs it.` });

const big = D.contextBuckets[D.contextBuckets.length - 1], bReq = sum(D.contextBuckets, (b) => b.req);
if (big && big.req / bReq >= 0.15) tips.push({ v: big.aic,
  t: `${pct(big.req, bReq)} of requests carried more than 150k tokens of context, and they used ${pct(big.aic, used)} of credits. Start new sessions or run <span class="text-mono">/compact</span> sooner.` });

const top = D.topSessions.map(S).find((s) => s.prompts.length && s.prompts[0].aic >= s.aic * 0.4 && s.prompts[0].aic >= median * 5);
if (top) tips.push({ v: top.prompts[0].aic,
  t: `One prompt in <b>${esc(top.title)}</b> cost ${int(top.prompts[0].aic)} credits on its own (“${esc(top.prompts[0].q.slice(0, 60))}${top.prompts[0].q.length > 60 ? '…' : ''}”). Long open-ended prompts keep the agent working until it decides to stop.` });

const au = [...D.automations].sort((a, b) => b.aic - a.aic)[0];
if (au && au.aic >= used * 0.01) tips.push({ v: au.aic,
  t: `<b>${esc(au.name)}</b> ran ${plural(au.runs, 'time')} at about ${int(au.aic / au.runs)} credits a run. If most runs find nothing to do, schedule it less often.` });

const sa = D.subagents[0];
if (sa && sa.aic >= used * 0.03) tips.push({ v: sa.aic,
  t: `<b>${esc(sa.name)}</b> subagents ran ${plural(sa.runs, 'time')}${sa.model ? `, mostly on ${esc(sa.model)}` : ''}, averaging ${int(sa.aic / sa.runs)} credits each. A smaller model may be enough for delegated work.` });

const plain = (html) => { const el = document.createElement('div'); el.innerHTML = html; return el.textContent; };
$('#tips').innerHTML = tips.length
  ? tips.map((x) => `<li><span>${x.t}</span><span class="tip-side"><span class="num color-fg-muted tip-save" title="Credits involved">${int(x.v)}</span>${askBtn('Ask Copilot', `${ASK_PREFIX}Help me act on this suggestion from the usage canvas: "${plain(x.t)}" Check the data first, then tell me concretely what to change.`)}</span></li>`).join('')
  : '<li class="color-fg-muted">Nothing stands out this period.</li>';
}

// ---------- disk space: worktrees on disk, biggest first ----------
const bytes = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.round(n / 1e6) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B';
const DISK_SHOWN = 10;
const DISK_STATUS = {
  open: '',
  archived: '<span class="Label Label--attention ml-1" title="The session is archived but its folder is still on disk">Archived</span>',
  orphan: '<span class="Label Label--danger ml-1" title="No session in the app points at this folder anymore">No session</span>'
};
let disk = null;

const FOLDER_SVG = '<svg class="octicon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z"/></svg>';

function renderDisk() {
  const st = lastStatus.disk || {};
  const lead = $('#disk-lead'), host = $('#disk'), more = $('#more-disk'), actions = $('#disk-actions');
  const count = $('#disk-count');
  if (!disk) {
    more.hidden = true;
    host.innerHTML = actions.innerHTML = '';
    lead.innerHTML = st.error ? `Couldn't measure disk usage: ${esc(st.error)}`
      : st.progress ? `Measuring folders… ${st.progress.done} of ${st.progress.total}`
      : 'Measuring folders. This takes a minute or two the first time.';
    return;
  }
  const items = disk.items;
  const stale = items.filter((x) => x.status !== 'open');
  const staleBytes = sum(stale, (x) => x.bytes);
  count.hidden = false;
  count.textContent = bytes(disk.total);
  // Deleting is two clicks: the first arms the button, the second does it.
  const busy = !!st.deleting || !!st.building;
  const delBtn = (key, label, armedLabel, cls = '') => `<button type="button" class="btn btn-sm ${state.armed === key ? 'btn-danger' : ''} ${cls}" data-del="${esc(key)}"${busy ? ' disabled' : ''}>${state.armed === key ? armedLabel : label}</button>`;
  actions.innerHTML = stale.length ? delBtn('*', `Delete all archived (${bytes(staleBytes)})`, `Delete ${plural(stale.length, 'folder')}?`) : '';
  const when = new Date(disk.generatedAt);
  lead.innerHTML = st.deleting ? `Deleting folders… ${st.deleting.done} of ${st.deleting.total}`
    : `<b>${bytes(disk.total)}</b> in ${plural(items.length, 'folder')}${staleBytes >= 1e8 ? `. <b>${bytes(staleBytes)}</b> is from archived or deleted sessions` : ''}. ` +
      `<span class="color-fg-muted f6">${st.progress ? `Re-measuring… ${st.progress.done} of ${st.progress.total}` : `Measured ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}</span>`;
  const list = state.allDisk ? items : items.slice(0, DISK_SHOWN);
  host.innerHTML = `
    <div class="bar-row bars-head flat disk-row f6 color-fg-muted" aria-hidden="true"><span>Folder</span><span></span><span class="num">Size</span><span></span></div>
    <ul class="bars flat disk">${list.map((x) => `<li><div class="bar-row disk-row">
      <div class="bar-label"><span>${x.status === 'open' && x.openId ? sessName(null, { status: 'open', openId: x.openId, title: x.title || x.name }) : esc(x.title || x.name)}${DISK_STATUS[x.status] || ''}</span>
        <span class="f6 color-fg-muted text-mono" title="${esc(x.path)}">${esc(x.project ? x.project + ' / ' + x.name : x.name)}</span></div>
      <div class="bar-track"><div class="bar-fill${x.status === 'open' ? '' : ' is-stale'}" style="width:${share(x.bytes, disk.total)}%"></div></div>
      <span class="num text-bold">${bytes(x.bytes)}</span>
      <span class="disk-acts"><button type="button" class="btn-octicon" data-reveal="${esc(x.path)}" title="Show in File Explorer" aria-label="Show ${esc(x.name)} in File Explorer">${FOLDER_SVG}</button>${x.status === 'open'
        ? '<span class="del-spacer" title="Archive the session in the app first"></span>'
        : delBtn(x.path, 'Delete', 'Confirm')}</span>
    </div></li>`).join('')}</ul>
    ${disk.sessionState ? `<p class="f6 color-fg-muted mt-3">Session history in <span class="text-mono">${esc(disk.sessionState.path)}</span> uses another <b>${bytes(disk.sessionState.bytes)}</b>. <button type="button" class="btn-link" data-reveal="${esc(disk.sessionState.path)}">Show folder</button></p>` : ''}`;
  more.hidden = items.length <= DISK_SHOWN;
  more.textContent = state.allDisk ? 'Show fewer' : `Show all ${items.length}`;
}

async function deleteDisk(key) {
  if (state.armed !== key) {
    state.armed = key;
    clearTimeout(state.armTimer);
    state.armTimer = setTimeout(() => { state.armed = null; renderDisk(); }, 4000);
    return renderDisk();
  }
  state.armed = null;
  clearTimeout(state.armTimer);
  const paths = key === '*' ? disk.items.filter((x) => x.status !== 'open').map((x) => x.path) : [key];
  lastStatus.disk = { ...lastStatus.disk, deleting: { done: 0, total: paths.length } };
  renderDisk();
  const r = await api('/api/delete', { paths }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) toast(j.error || 'Couldn’t delete that');
  else toast(j.failed.length
    ? `Freed ${bytes(j.freed)}. ${plural(j.failed.length, 'folder')} couldn't be deleted: ${j.failed[0].error}`
    : `Deleted ${plural(j.deleted, 'folder')} and freed ${bytes(j.freed)}`);
  return loadDisk();
}

async function loadDisk() {
  const r = await api('/api/disk');
  if (!r.ok) return;
  const j = await r.json();
  lastStatus.disk = { builtAt: j.builtAt, building: j.building, error: j.error, hasData: j.hasData, progress: j.progress, deleting: j.deleting };
  if (j.data) { disk = j.data; state.diskAt = j.builtAt; }
  renderDisk();
}

// ---------- loading, refresh, agent focus ----------
let current = null;
let pendingFocus = null;
let lastStatus = {};
const SHOWN_FOCUS = 6;
const GROUP_KEYS = ['model', 'source', 'project'];

function showStatus(next) {
  const st = lastStatus = { ...lastStatus, ...next };
  const btn = $('#refresh');
  btn.disabled = st.building;
  btn.setAttribute('aria-busy', String(st.building));
  btn.querySelector('span').textContent = st.building ? 'Refreshing…' : 'Refresh';
  const err = $('#error');
  err.hidden = !st.error;
  err.textContent = st.error ? (current ? `Couldn't refresh: ${st.error}. Showing the last data.` : `Couldn't read usage data: ${st.error}`) : '';
  if (!current && st.error) $('#empty').hidden = true;
  if (current) {
    const gen = new Date(current.generatedAt);
    const mins = Math.floor((Date.now() - gen) / 60000);
    $('#updated').textContent = st.building ? 'Refreshing…' : `Updated ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${MON[gen.getMonth()]} ${gen.getDate()}, ${gen.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}`;
  }
}

async function load() {
  const res = await api('/api/data');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.data && j.builtAt !== state.builtAt) {
    state.builtAt = j.builtAt;
    current = j.data;
    render(current);
    $('#empty').hidden = true;
    $('#app').hidden = false;
    if (pendingFocus) { applyFocus(pendingFocus); pendingFocus = null; }
  }
  showStatus(j);
}

function applyFocus(f) {
  if (!current) { pendingFocus = f; return; }
  if (f.disk) return showTab('disk');
  showTab('usage');
  if (f.day) return renderCalendar(f.day);
  if (f.session || f.by || f.name) renderCalendar(null);
  if (f.session) {
    const idx = current.topSessions.findIndex((s) => s === f.session || s.startsWith(f.session));
    if (idx >= SHOWN_FOCUS) state.allSessions = true;
    return renderSessions(idx >= 0 ? current.topSessions[idx] : f.session);
  }
  if (f.by || f.name) renderBars(f.by && GROUP_KEYS.includes(f.by) ? f.by : state.by, f.name);
}
function showTab(name) {
  state.tab = name;
  document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $('#tab-usage').hidden = name !== 'usage';
  $('#tab-disk').hidden = name !== 'disk';
}
document.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
document.querySelectorAll('[data-by]').forEach((b) => b.addEventListener('click', () => { state.open = null; renderBars(b.dataset.by); }));
$('#more-sessions').addEventListener('click', () => { state.allSessions = !state.allSessions; renderSessions(); });
$('#more-disk').addEventListener('click', () => { state.allDisk = !state.allDisk; renderDisk(); });
$('#refresh').addEventListener('click', async () => {
  showStatus({ building: true, error: null });
  const r = await api('/api/refresh', {}).catch(() => null);
  if (!r || !r.ok) showStatus({ building: false, error: 'the canvas server didn’t respond' });
});
document.addEventListener('click', async (e) => {
  const day = e.target.closest('[data-day]');
  if (day && !day.disabled) return renderCalendar(day.dataset.day);
  const del = e.target.closest('[data-del]');
  if (del && !del.disabled) return deleteDisk(del.dataset.del);
  // Session links and folder buttons go through the canvas server, which hands them to Windows.
  const link = e.target.closest('[data-open], [data-reveal]');
  if (link) {
    e.preventDefault();
    e.stopPropagation();
    const open = link.dataset.open;
    const r = await api(open ? '/api/open' : '/api/reveal', open ? { id: open } : { path: link.dataset.reveal }).catch(() => null);
    return toast(r && r.ok ? (open ? 'Opening session…' : 'Opening File Explorer…') : (r && (await r.json().catch(() => ({}))).error) || 'Couldn’t open that');
  }
  const b = e.target.closest('[data-ask]');
  if (!b) return;
  e.preventDefault();
  b.disabled = true;
  const r = await api('/api/ask', { prompt: b.dataset.ask }).catch(() => null);
  b.disabled = false;
  if (r && r.ok) { b.dataset.sent = ''; toast('Sent to Copilot'); }
  else toast((r && (await r.json().catch(() => ({}))).error) || 'Couldn’t reach Copilot');
});

const es = new EventSource(`/events?t=${encodeURIComponent(token)}`);
es.addEventListener('state', (e) => {
  const st = JSON.parse(e.data);
  if (st.disk) {
    const prev = lastStatus.disk || {};
    lastStatus.disk = st.disk;
    if (st.disk.hasData && st.disk.builtAt !== state.diskAt) loadDisk().catch(() => {});
    else if (current && (st.disk.progress || prev.progress || st.disk.deleting || prev.deleting || st.disk.error !== prev.error)) renderDisk();
  }
  if (st.hasData && st.builtAt !== state.builtAt) load().catch(() => {});
  else showStatus(st);
});
es.addEventListener('focus', (e) => applyFocus(JSON.parse(e.data)));
setInterval(() => current && showStatus({}), 60000);
load().then(() => loadDisk()).catch((e) => showStatus({ building: false, error: e.message }));
})();
