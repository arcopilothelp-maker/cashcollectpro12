// Owner dashboard. The server checks admin rights on every call; this page only displays.
// Everything is rendered with textContent (no HTML injection).
(() => {
  const $ = (id) => document.getElementById(id);
  let session, settings = {}, days = 30, names = { packs: {}, modes: {} };
  const rupees = (p) => '₹' + (Number(p || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const num = (n) => Number(n || 0).toLocaleString('en-IN');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const LIMITS = {
    daily_free_budget_paise:  ['Daily free budget (₹)', true],
    hourly_free_budget_paise: ['Hourly free budget (₹)', true],
    free_questions_per_phone: ['Free questions per phone', false],
    max_grants_per_ip_per_day: ['Free sign-ups per IP / day', false],
    max_grants_per_device_per_day: ['Free sign-ups per device / day', false],
    max_questions_per_minute: ['Questions per user / minute', false],
    max_questions_per_day:    ['Questions per user / day', false],
  };

  // Friendly names for tracked labels
  const SECTION = { help: 'How I help', about: 'About me', ats: 'Resume ATS', ai: 'AI assistant', courses: 'Training programs',
    consulting: 'Consulting', insights: 'Free insights', quiz: 'Quiz', pricing: 'Pricing strip', faq: 'FAQ', contact: 'Contact' };
  const CTA = { whatsapp: 'WhatsApp', email: 'Email', linkedin: 'LinkedIn', pricing_page: 'Opened pricing page', nav_talk: 'Talk to me (menu)',
    hero_help: 'Find the right help (hero)', hero_talk: 'Talk to me (hero)', ats_section: 'Check resume (ATS section)', ats_nudge: 'Check resume (pop-up)',
    ai_try: 'Try AI free', enquire_courses: 'Enquire about training', book_call: 'Book a call', discovery_call: 'Free 30-min call',
    resume_curation: '1-to-1 resume curation', pricing_proposal: 'Ask for a proposal (pricing)' };
  const NEED = { ar: 'AR / collections problem', job: 'Job or better role', skills: 'Grow my skills', business: 'Improve company collections',
    team: 'Train my team', hero_ar: 'AR question (hero)', hero_job: 'Job (hero)', hero_skills: 'Skills (hero)', hero_business: 'Company collections (hero)', hero_team: 'Train team (hero)' };
  const INSIGHT = { diagnose: 'Diagnose before you chase', ptp: 'Promise-to-pay', escalation: 'Escalation ladder', metrics: 'Metrics that move cash',
    resume: 'Resume fixes for ATS', interview: 'Interview answers' };
  let countryName = (c) => c;
  try { const dn = new Intl.DisplayNames(['en'], { type: 'region' }); countryName = (c) => dn.of(c) || c; } catch {}

  async function api(path, body) {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  }

  // ---------- small chart helpers ----------
  function hbars(id, obj, nameFn = (k) => k, limit = 10, fmt = num) {
    const box = $(id); box.textContent = '';
    const rows = Object.entries(obj || {}).filter(([, v]) => Number(v) > 0).sort((a, b) => b[1] - a[1]).slice(0, limit);
    if (!rows.length) { box.append(el('p', 'empty', 'No data yet for this period.')); return; }
    const max = rows[0][1];
    const wrap = el('div', 'hbars');
    for (const [k, v] of rows) {
      const r = el('div', 'hbar'); const t = el('div', 't'); const i = el('i'); i.style.width = (100 * v / max) + '%'; t.append(i);
      const label = el('span', null, nameFn(k)); label.title = nameFn(k);
      r.append(label, t, el('b', null, fmt(v, k))); wrap.append(r);
    }
    box.append(wrap);
  }

  function columns(id, series, key, fmt) {
    const box = $(id); box.textContent = '';
    const max = Math.max(1, ...series.map(d => Number(d[key]) || 0));
    const chart = el('div', 'colchart');
    chart.append(el('span', 'max', fmt(max)));
    for (const d of series) {
      const v = Number(d[key]) || 0;
      const c = el('div', 'col'); const i = el('i'); i.style.height = (100 * v / max) + '%';
      const day = new Date(d.day + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      c.append(i, el('span', 'tip', `${day}: ${fmt(v)}`)); c.setAttribute('aria-label', `${day}: ${fmt(v)}`);
      chart.append(c);
    }
    const axis = el('div', 'axis');
    const f = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    axis.append(el('span', null, f(series[0].day)), el('span', null, f(series[series.length - 1].day)));
    box.append(chart, axis);
  }

  function kpi(label, value, sub) {
    const d = el('div', 'kpi'); d.append(el('span', null, label), el('b', null, value)); if (sub) d.append(el('small', null, sub)); return d;
  }

  // ---------- load ----------
  async function loadDashboard() {
    const r = await api('/api/admin/dashboard?days=' + days);
    if (!r.ok) { $('adminMsg').textContent = 'Not authorised. Sign in on the main page with your admin Google account.'; $('adminMsg').className = 'msg error'; return; }
    $('adminMsg').classList.add('hidden'); $('adminBody').classList.remove('hidden');
    for (const [k, p] of Object.entries(r.packs || {})) names.packs[k] = `${p.label} (${rupees(p.amountPaise)})`;
    names.modes = r.modes || {};
    const d = r.dashboard, k = d.kpi || {}, st = d.stats || {};
    const profit = k.revenue_paise ? Math.round(100 * (1 - k.ai_cost_paise / k.revenue_paise)) + '%' : '–';
    const conv = k.visitors ? ((100 * k.buyers) / k.visitors).toFixed(1) + '%' : '–';
    const K = $('kpis'); K.textContent = '';
    K.append(
      kpi('Visitors', num(k.visitors), `${num(k.page_views)} page views`),
      kpi('Sign-ups', num(k.signups), 'new accounts'),
      kpi('Buyers', num(k.buyers), `${num(k.orders)} orders · ${conv} of visitors`),
      kpi('Revenue', rupees(k.revenue_paise), `AI cost ${rupees(k.ai_cost_paise)}`),
      kpi('Gross profit after AI', profit, 'target 80% or more'),
      kpi('AI answers', num(k.ai_requests), `${num(k.ats_reports)} resume ATS reports`),
      kpi('Quiz rounds', num(k.quiz_rounds), 'free, no AI cost'),
      kpi('Contact clicks', num(k.enquiry_clicks), 'WhatsApp, email, LinkedIn'),
    );

    const series = d.series || [];
    if (series.length) {
      columns('chartVisitors', series, 'visitors', num);
      columns('chartRevenue', series, 'revenue_paise', rupees);
      const t = el('table', 'tbl'); const h = t.createTHead().insertRow();
      [['Day', ''], ['Visitors', 'n'], ['Orders', 'n'], ['Revenue', 'n']].forEach(([x, c]) => { const th = el('th', c, x); h.append(th); });
      const b = t.createTBody();
      for (const s of series.slice().reverse()) {
        const row = b.insertRow();
        row.insertCell().textContent = s.day;
        [num(s.visitors), num(s.orders), rupees(s.revenue_paise)].forEach(v => { const c = row.insertCell(); c.className = 'n'; c.textContent = v; });
      }
      $('dailyTable').textContent = ''; $('dailyTable').append(t);
    }

    // sales by pack
    const sp = $('salesByPack'); sp.textContent = '';
    if (!(d.sales_by_pack || []).length) sp.append(el('p', 'empty', 'No sales yet for this period.'));
    else {
      const t = el('table', 'tbl'); const h = t.createTHead().insertRow();
      [['Pack', ''], ['Orders', 'n'], ['Buyers', 'n'], ['Revenue', 'n']].forEach(([x, c]) => h.append(el('th', c, x)));
      const b = t.createTBody();
      for (const p of d.sales_by_pack) {
        const row = b.insertRow(); row.insertCell().textContent = names.packs[p.pack] || p.pack;
        [num(p.orders), num(p.buyers), rupees(p.revenue_paise)].forEach(v => { const c = row.insertCell(); c.className = 'n'; c.textContent = v; });
      }
      sp.append(t);
    }

    // recent payments
    const rp = $('recentPayments'); rp.textContent = '';
    if (!(d.recent_payments || []).length) rp.append(el('p', 'empty', 'No payments yet.'));
    else {
      const t = el('table', 'tbl'); const h = t.createTHead().insertRow();
      [['When', ''], ['Customer', ''], ['Pack', ''], ['Amount', 'n']].forEach(([x, c]) => h.append(el('th', c, x)));
      const b = t.createTBody();
      for (const p of d.recent_payments) {
        const row = b.insertRow();
        row.insertCell().textContent = new Date(p.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        row.insertCell().textContent = p.email || '–';
        row.insertCell().textContent = (names.packs[p.pack] || p.pack).replace(/ \(.*/, '');
        const c = row.insertCell(); c.className = 'n'; c.textContent = rupees(p.amount_paise);
      }
      rp.append(t);
    }

    hbars('arTopics', d.ar_topics);
    hbars('usageByMode', d.usage_by_mode, (m) => names.modes[m] || m);
    hbars('sections', st.section_view, (s) => SECTION[s] || s, 12);
    hbars('ctas', st.cta, (c) => CTA[c] || (c.startsWith('buy_') ? 'Get started: ' + (names.packs[c.slice(4)] || c.slice(4)) : c), 12);
    hbars('needs', st.help_need, (n) => NEED[n] || n);
    hbars('insights', st.insight_open, (n) => INSIGHT[n] || n);
    const done = st.quiz_complete || {};
    hbars('quiz', st.quiz_start, (q) => q, 10, (v, q) => `${num(v)} · ${num(done[q] || 0)} done`);
    hbars('referrers', st.referrer, (x) => x === 'direct' ? 'Direct / typed / app' : x);
    hbars('countries', st.country, countryName);
    hbars('cities', st.city, (x) => x, 8);
    hbars('devices', st.device, (x) => x[0].toUpperCase() + x.slice(1));
  }

  async function loadSettings() {
    const r = await api('/api/admin/metrics');
    if (!r.ok) return;
    const m = r.metrics; settings = m.settings || {};
    $('freeToday').textContent = `Free budget used today: ${rupees(m.free_spent_today_paise)} of ${rupees(settings.daily_free_budget_paise)} · ${num(m.free_grants_today)} free sign-ups today`;
    $('toggleFree').textContent = settings.free_enabled ? 'Free questions: ON (click to turn OFF)' : 'Free questions: OFF (click to turn ON)';
    $('togglePaid').textContent = settings.paid_enabled ? 'Paid questions: ON (click to turn OFF)' : 'Paid questions: OFF (click to turn ON)';
    const lim = $('limits'); lim.textContent = '';
    for (const [k, [label, money]] of Object.entries(LIMITS)) {
      const wrap = el('label'); wrap.append(el('span', 'small muted', label));
      const i = el('input'); i.type = 'number'; i.min = '0'; i.id = 'lim_' + k;
      i.value = money ? Number(settings[k]) / 100 : settings[k];
      wrap.append(i); lim.append(wrap);
    }
  }

  async function init() {
    const cfg = await (await fetch('/api/config')).json();
    const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { flowType: 'pkce' } });
    session = (await sb.auth.getSession()).data.session;
    if (!session) { $('adminMsg').textContent = 'Please sign in on the main page first, then come back to /admin.html.'; return; }
    document.querySelectorAll('#range button').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('#range button').forEach(x => x.classList.toggle('active', x === b));
        days = Number(b.dataset.days); loadDashboard();
      };
    });
    $('toggleFree').onclick = async () => { await api('/api/admin/settings', { free_enabled: !settings.free_enabled }); loadSettings(); };
    $('togglePaid').onclick = async () => { await api('/api/admin/settings', { paid_enabled: !settings.paid_enabled }); loadSettings(); };
    $('saveLimits').onclick = async () => {
      const body = {};
      for (const [k, [, money]] of Object.entries(LIMITS)) {
        const v = Number($('lim_' + k).value);
        if (Number.isFinite(v) && v >= 0) body[k] = money ? Math.round(v * 100) : Math.round(v);
      }
      await api('/api/admin/settings', body); loadSettings();
    };
    await loadDashboard();
    loadSettings();
  }
  window.addEventListener('load', init);
})();
