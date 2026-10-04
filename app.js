// CashCollect Pro – browser code. Holds NO secrets. All checks are repeated on the server.
(() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  let sb, cfg, session, me, tsClaimId, tsAskId;
  const packCat = { packsLanding: 'individual', packsApp: 'individual' };

  // Small storage helpers (storage can be blocked; never rely on it)
  const store = {
    get: (s, k) => { try { return window[s].getItem(k); } catch { return null; } },
    set: (s, k, v) => { try { window[s].setItem(k, v); } catch {} },
    del: (s, k) => { try { window[s].removeItem(k); } catch {} },
  };

  // Random per-browser id (one of several anti-abuse signals; never trusted alone)
  function deviceId() {
    let id = store.get('localStorage', 'arc_dev');
    if (!id) { id = crypto.randomUUID(); store.set('localStorage', 'arc_dev', id); }
    return id || 'nostorage';
  }

  const rupees = (p) => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function show(e, on = true) { e.classList.toggle('hidden', !on); }
  function note(box, text, kind = 'info') { box.textContent = text; box.className = 'msg ' + kind; show(box, !!text); }
  const message = (t, k) => note($('msg'), t, k);

  async function api(path, body) {
    const opts = { headers: { 'Content-Type': 'application/json' } };
    if (session) opts.headers.Authorization = 'Bearer ' + session.access_token;
    if (body) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
    try { const r = await fetch(path, opts); return await r.json(); }
    catch { return { ok: false, message: 'Network error. Please check your connection.' }; }
  }

  // ---------- pricing ----------
  function renderPacks(containerId) {
    const container = $(containerId); if (!container) return;
    container.textContent = '';
    const cat = packCat[containerId];
    const atsCredits = cfg.modes.ats?.credits || 12;
    for (const [key, p] of Object.entries(cfg.packs)) {
      if (p.category !== cat) continue;
      const card = el('div', 'pack' + (p.highlight ? ' hot' : ''));
      if (p.highlight) card.append(el('span', 'ribbon', cat === 'individual' ? 'Most popular' : 'Best for teams'));
      card.append(el('h4', null, p.label));
      const price = el('div', 'price'); price.append(el('b', null, rupees(p.amountPaise)));
      card.append(price);
      card.append(el('p', 'credits', `${p.credits.toLocaleString('en-IN')} AR Credits`));
      card.append(el('p', 'per', `${rupees(Math.round(p.amountPaise / p.credits))} per credit`));
      const ul = el('ul', 'ticks sm');
      ul.append(el('li', null, p.note));
      if (p.credits >= atsCredits * 2) ul.append(el('li', null, `or ${Math.floor(p.credits / atsCredits).toLocaleString('en-IN')} resume ATS reports`));
      else if (p.credits < atsCredits) ul.append(el('li', null, `${p.credits} quick questions`));
      card.append(ul);
      const btn = el('button', 'btn ' + (p.highlight ? 'btn-primary' : 'btn-dark'), session ? 'Buy now' : 'Get started');
      btn.onclick = () => buyOrSignIn(key);
      card.append(btn);
      container.append(card);
    }
  }

  function setupSegments() {
    $$('.seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
          packCat[seg.dataset.target] = b.dataset.cat;
          if (window.ccpTrack) window.ccpTrack('pricing_tab', b.dataset.cat);
          renderPacks(seg.dataset.target);
        };
      });
    });
  }

  function renderModes() {
    const t = $('modesTable');
    const body = t ? t.createTBody() : null;
    if (t) { const head = t.createTHead().insertRow(); ['Request', 'Credits', 'Free?'].forEach(x => head.append(el('th', null, x))); }
    const sel = $('modeSelect'); sel.textContent = '';
    for (const [k, m] of Object.entries(cfg.modes)) {
      if (body) { const r = body.insertRow(); r.insertCell().textContent = m.label; r.insertCell().textContent = m.credits; r.insertCell().textContent = m.freeAllowed ? 'Yes' : '–'; }
      if (m.askable) { const o = el('option', null, `${m.label} · ${m.credits} credit${m.credits > 1 ? 's' : ''}`); o.value = k; sel.append(o); }
    }
    sel.onchange = updateModeCost; updateModeCost();
  }

  function updateModeCost() {
    const m = cfg.modes[$('modeSelect').value];
    $('modeCost').textContent = m.freeAllowed ? 'Your free questions can be used here.' : 'Uses paid AR Credits.';
  }

  // ---------- account ----------
  async function refresh() {
    me = await api('/api/me');
    if (!me.ok) return;
    $('freeBal').textContent = me.free_credits;
    $('paidBal').textContent = me.paid_credits;
    show($('adminLink'), me.isAdmin);
    const phoneOk = !cfg.requirePhone || me.phoneVerified;
    show($('phoneBox'), !phoneOk && !me.freeClaimed);
    show($('claimBox'), phoneOk && !me.freeClaimed);
    const ct = $('claimTitle'); if (ct) ct.textContent = cfg.requirePhone ? 'Your number is verified' : 'Unlock your 3 free questions';
    if (phoneOk && !me.freeClaimed && window.turnstile && tsClaimId === undefined) {
      tsClaimId = turnstile.render('#tsClaim', { sitekey: cfg.turnstileSiteKey });
    }
  }

  function setSignedIn(on) {
    show($('app'), on);
    show($('btnSignIn'), !on); show($('btnSignOut'), on);
    renderPacks('packsLanding'); renderPacks('packsApp');
  }

  function openTab(id) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
    $$('.tabpane').forEach(p => show(p, p.id === id));
    if (id === 'tabAsk' && window.turnstile && tsAskId === undefined) {
      tsAskId = turnstile.render('#tsAsk', { sitekey: cfg.turnstileSiteKey, size: 'flexible' });
    }
  }

  function goTo(tab) {
    if (!session) { store.set('sessionStorage', 'ccp_intent', tab); return signIn(); }
    openTab(tab);
    $('app').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function runIntent() {
    const i = store.get('sessionStorage', 'ccp_intent');
    if (!i || !session) return;
    store.del('sessionStorage', 'ccp_intent');
    if (i.startsWith('buy:')) { goTo('tabBuy'); buy(i.slice(4)); } else goTo(i);
  }

  // ---------- auth ----------
  async function signIn() {
    await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } });
  }

  async function sendOtp() {
    const phone = $('phoneInput').value.replace(/[^\d+]/g, '');
    if (!/^\+?\d{10,15}$/.test(phone)) return message('Please enter a valid mobile number, e.g. +919876543210', 'error');
    const full = phone.startsWith('+') ? phone : '+91' + phone;
    const { error } = await sb.auth.updateUser({ phone: full });
    if (error) return message(error.message, 'error');
    $('phoneInput').dataset.full = full;
    show($('otpRow')); message('OTP sent. Please check your SMS.', 'info');
  }

  async function verifyOtp() {
    const phone = $('phoneInput').dataset.full;
    const token = $('otpInput').value.trim();
    const { error } = await sb.auth.verifyOtp({ phone, token, type: 'phone_change' });
    if (error) return message('Incorrect or expired OTP. Please try again.', 'error');
    await sb.auth.refreshSession();
    session = (await sb.auth.getSession()).data.session;
    message('Mobile number verified.', 'ok');
    refresh();
  }

  async function claimFree() {
    const token = window.turnstile ? turnstile.getResponse(tsClaimId) : '';
    const r = await api('/api/claim-free', { turnstileToken: token, deviceId: deviceId() });
    if (window.turnstile) turnstile.reset(tsClaimId);
    openTab('tabAsk');
    message(r.ok ? 'Your 3 free questions are ready. Ask away!' : r.message, r.ok ? 'ok' : 'error');
    refresh();
  }

  // ---------- ask ----------
  async function ask() {
    const q = $('question').value.trim();
    if (!q) return message('Please type your question.', 'error');
    const btn = $('btnAsk'); btn.disabled = true; btn.textContent = 'Thinking…';
    message('');
    const token = window.turnstile && tsAskId !== undefined ? turnstile.getResponse(tsAskId) : '';
    const r = await api('/api/ask', { mode: $('modeSelect').value, question: q, turnstileToken: token });
    if (window.turnstile && tsAskId !== undefined) turnstile.reset(tsAskId);
    btn.disabled = false; btn.textContent = 'Ask';
    if (!r.ok) { message(r.message || 'Something went wrong.', 'error'); return refresh(); }
    const a = $('answer'); a.textContent = r.answer; show(a);    // textContent = no HTML injection
    if (r.masked) message('Note: we hid some personal or banking details before sending your question.', 'info');
    refresh();
  }

  // ---------- resume ATS ----------
  async function readFile(file) {
    const info = $('resumeInfo');
    info.textContent = 'Reading your resume…';
    note($('atsMsg'), '');
    try {
      const r = await window.CCPResume.extract(file);
      $('resumeText').value = r.text.slice(0, cfg.atsLimits.resumeMax);
      info.textContent = `✓ Read ${r.text.length.toLocaleString('en-IN')} characters from ${r.name}${r.pages ? ` (${r.pages} page${r.pages > 1 ? 's' : ''})` : ''}. Check the text below if you like.`;
      $('resumeText').closest('details').open = true;
      if (r.pages && r.pages > 3) note($('atsMsg'), 'Your resume is over 3 pages. Recruiters and many ATS prefer 1–2 pages (3 for 15+ years).', 'info');
    } catch (e) {
      info.textContent = '';
      note($('atsMsg'), e.message || 'Could not read this file. Please paste the text instead.', 'error');
    }
  }

  async function runAts() {
    const resumeText = window.CCPResume.tidy($('resumeText').value);
    const jobDescription = $('jdText').value.trim();
    const box = $('atsMsg');
    if (resumeText.length < cfg.atsLimits.resumeMin) return note(box, 'Please upload your resume or paste its full text first.', 'error');
    const need = cfg.modes.ats.credits;
    if (me && me.paid_credits < need) {
      note(box, `A Resume ATS report needs ${need} AR Credits. You have ${me.paid_credits}. `, 'error');
      const b = el('button', 'btn btn-primary btn-inline', `Buy the ₹99 Resume ATS Pack`);
      b.onclick = () => buy('ats99'); box.append(b);
      return;
    }
    const btn = $('btnAts'); btn.disabled = true; btn.textContent = 'Analysing your resume…';
    note(box, 'This usually takes 30–60 seconds. Please keep this page open.', 'info');
    show($('atsResult'), false);
    const r = await api('/api/ats', { resumeText, jobDescription });
    btn.disabled = false; btn.textContent = `Get my ATS score · ${need} credits`;
    if (!r.ok) {
      note(box, r.message || 'Something went wrong.', 'error');
      if (r.reason === 'no_ats_credits') { const b = el('button', 'btn btn-primary btn-inline', 'Buy the ₹99 Resume ATS Pack'); b.onclick = () => buy('ats99'); box.append(b); }
      return refresh();
    }
    note(box, r.masked ? 'Done. We hid your contact details before analysis.' : 'Done. Here is your report.', 'ok');
    renderReport(r.report);
    refresh();
  }

  function setRing(ring, score) {
    ring.style.setProperty('--p', Math.max(0, Math.min(100, score)));
    ring.dataset.band = score >= 80 ? 'good' : score >= 60 ? 'ok' : 'low';
  }

  function renderReport(rep) {
    $('atsOverall').textContent = rep.overall;
    setRing($('atsRing'), rep.overall);
    $('atsBand').textContent = rep.overall >= 80 ? 'Strong: likely to pass most ATS' : rep.overall >= 60 ? 'Fair: a few fixes will lift it' : 'At risk: likely to be filtered out';
    $('atsSummary').textContent = rep.summary;
    $('atsJd').textContent = rep.jd_match == null ? 'Tip: add a job description next time to get a job match score.' : `Job description match: ${rep.jd_match}/100`;

    const areas = $('atsAreas'); areas.textContent = '';
    for (const a of rep.areas) {
      const row = el('div', 'bar');
      const top = el('div', 'bar-top'); top.append(el('b', null, a.name), el('span', null, `${a.score}/${a.max}`));
      const track = el('div', 'track'); const fill = el('i'); fill.style.width = `${Math.round(100 * a.score / a.max)}%`;
      fill.dataset.band = a.score / a.max >= 0.8 ? 'good' : a.score / a.max >= 0.6 ? 'ok' : 'low';
      track.append(fill);
      row.append(top, track, el('p', 'small muted', a.comment));
      areas.append(row);
    }
    const fixes = $('atsFixes'); fixes.textContent = '';
    for (const f of rep.fixes) {
      const li = el('li'); li.append(el('span', 'prio ' + f.priority, f.priority), el('b', null, f.issue), el('p', null, f.fix));
      fixes.append(li);
    }
    const st = $('atsStrengths'); st.textContent = '';
    rep.strengths.forEach(s => st.append(el('li', null, s)));
    const kw = $('atsKeywords'); kw.textContent = '';
    rep.keywords_missing.forEach(k => kw.append(el('span', null, k)));
    if (!rep.keywords_missing.length) kw.append(el('span', 'muted', 'No major gaps found'));
    show($('atsResult'));
    $('atsResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- payments ----------
  function buyOrSignIn(pack) {
    if (!session) { store.set('sessionStorage', 'ccp_intent', 'buy:' + pack); return signIn(); }
    buy(pack);
  }

  async function buy(pack) {
    const o = await api('/api/payments/order', { pack });
    if (!o.ok) return message(o.message || 'Could not start payment.', 'error');
    const rzp = new Razorpay({
      key: o.keyId, amount: o.amountPaise, currency: 'INR', order_id: o.orderId,
      name: 'CashCollect Pro', description: cfg.packs[pack].label + ' · ' + cfg.packs[pack].credits + ' AR Credits',
      prefill: { email: me?.email || '' }, theme: { color: '#0B1F3A' },
      handler: async (resp) => {
        const v = await api('/api/payments/verify', resp);
        const t = v.ok ? 'Payment successful. Credits added.' : 'Payment received; credits will appear shortly.';
        message(t, v.ok ? 'ok' : 'info'); note($('atsMsg'), t, v.ok ? 'ok' : 'info');
        refresh();
      },
    });
    rzp.open();
  }

  // ---------- landing extras ----------
  function decorate() {
    $$('.mock .ring').forEach(r => setRing(r, Number(r.dataset.score)));
    $$('.mock i[data-w]').forEach(i => { i.style.width = i.dataset.w + '%'; });
    // close the mobile menu after choosing a link
    $$('.menu-panel a').forEach(a => a.addEventListener('click', () => { a.closest('details').open = false; }));
  }

  function setupNudge() {
    const n = $('atsNudge');
    if (store.get('localStorage', 'ccp_nudge')) return;
    setTimeout(() => {
      const atsTop = $('ats').getBoundingClientRect().top;
      if (atsTop < window.innerHeight && atsTop > -$('ats').offsetHeight) return; // already looking at it
      show(n);
    }, 7000);
    const close = () => { show(n, false); store.set('localStorage', 'ccp_nudge', '1'); };
    $('nudgeClose').onclick = close;
    n.querySelector('.js-ats').addEventListener('click', close);
  }

  // ---------- start ----------
  async function init() {
    decorate();
    try { cfg = await (await fetch('/api/config')).json(); }
    catch { return; }
    setupSegments();
    renderModes();

    $$('.js-ats').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); goTo('tabAts'); }));
    $$('.js-ask').forEach(b => b.addEventListener('click', () => goTo('tabAsk')));
    $$('.tab').forEach(t => { t.onclick = () => openTab(t.dataset.tab); });
    $('btnSignIn').onclick = signIn;
    $('btnSignOut').onclick = async () => { await sb.auth.signOut(); location.reload(); };
    $('btnSendOtp').onclick = sendOtp; $('btnVerifyOtp').onclick = verifyOtp;
    $('btnClaim').onclick = claimFree; $('btnAsk').onclick = ask;
    $('btnAts').onclick = runAts;
    $('btnAtsPrint').onclick = () => window.print();
    $('question').oninput = () => { $('charCount').textContent = $('question').value.length; };
    $('resumeFile').onchange = (e) => e.target.files[0] && readFile(e.target.files[0]);
    const dz = $('dropZone');
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
    setupNudge();

    // Links from the pricing page: /?buy=ats99 or /?go=tabAts
    const qs = new URLSearchParams(location.search);
    const buyKey = qs.get('buy'), goTab = qs.get('go');
    if ((buyKey && cfg.packs[buyKey]) || ['tabAts', 'tabAsk', 'tabBuy'].includes(goTab)) {
      store.set('sessionStorage', 'ccp_intent', buyKey && cfg.packs[buyKey] ? 'buy:' + buyKey : goTab);
      history.replaceState(null, '', '/');
    }

    sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { flowType: 'pkce' } });
    session = (await sb.auth.getSession()).data.session;
    sb.auth.onAuthStateChange((_e, s) => {
      const was = !!session; session = s; setSignedIn(!!s);
      if (s) { refresh(); if (!was) runIntent(); }
    });
    setSignedIn(!!session);
    if (session) { await refresh(); runIntent(); }
    else if (store.get('sessionStorage', 'ccp_intent') && (buyKey || goTab)) signIn();
  }
  window.addEventListener('load', init);
})();
