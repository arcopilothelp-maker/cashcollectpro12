// Run: npm test   (from the worker folder). No network: all external services are mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { maskPII, costPaise, maxCostPaise, passesMarginGuard, hmacHex, verifyRazorpayCheckout, buckets, MODES, PACKS, ATS_LIMITS, parseAtsReport } from '../src/lib.js';
import { SYSTEM_PROMPT, ATS_PROMPT } from '../src/knowledge.js';

// ---------------- pure functions ----------------
test('masks personal and banking data', () => {
  const t = maskPII('Call 9876543210 or +91 9123456789, mail a.b@x.com, PAN ABCDE1234F, GSTIN 27ABCDE1234F1Z5, IFSC HDFC0001234, a/c 123456789012, card 4111 1111 1111 1111');
  for (const bad of ['9876543210', '9123456789', 'a.b@x.com', 'ABCDE1234F', '27ABCDE1234F1Z5', 'HDFC0001234', '123456789012', '4111']) assert.ok(!t.includes(bad), bad + ' leaked: ' + t);
});
test('leaves normal text and amounts alone', () => {
  assert.equal(maskPII('Invoice of ₹45,000 is 75 days overdue since 12/08/2026'), 'Invoice of ₹45,000 is 75 days overdue since 12/08/2026');
});
test('cost maths', () => {
  // 1M input + 1M output at $1/$5, 90 INR/USD = $6 = ₹540 = 54000 paise
  assert.equal(costPaise({ input_tokens: 1e6, output_tokens: 1e6 }, { in: 1, out: 5 }, 90), 54000);
  // cache reads cost 10%
  assert.equal(costPaise({ cache_read_input_tokens: 1e6 }, { in: 1, out: 5 }, 90), 900);
});
test('every request type keeps >= 80% profit at the cheapest credit price (worst case)', () => {
  const price = { fast: { in: 1, out: 5 }, smart: { in: 2, out: 10 } };
  for (const [k, m] of Object.entries(MODES)) {
    const sys = k === 'ats' ? ATS_PROMPT.length : SYSTEM_PROMPT.length;
    const q = k === 'ats' ? ATS_LIMITS.resumeMax + ATS_LIMITS.jdMax + 60 : 4000;
    const worst = maxCostPaise({ systemChars: sys, questionChars: q, maxTokens: m.maxTokens }, price[m.tier], 90);
    assert.ok(passesMarginGuard(worst, m.credits, 430, 5), k + ' fails the 80% margin guard');
  }
  assert.ok(!passesMarginGuard(1000, 1, 50, 5), 'should fail when credit value is tiny');
});
test('pack slabs: price per credit falls as the slab grows; lowest net >= ₹4.30', () => {
  for (const cat of ['individual', 'corporate']) {
    const list = Object.values(PACKS).filter(p => p.category === cat);
    for (let i = 1; i < list.length; i++) assert.ok(list[i].amountPaise / list[i].credits < list[i - 1].amountPaise / list[i - 1].credits);
  }
  for (const p of Object.values(PACKS)) assert.ok(p.amountPaise / p.credits / 1.18 * 0.98 >= 430, p.label);
  assert.equal(PACKS.try19.amountPaise, 1900);
  assert.equal(PACKS.ats99.amountPaise, 9900);
  assert.ok(PACKS.ats99.credits >= MODES.ats.credits, '₹99 pack must cover one ATS report');
});
test('ATS report parser: fixed shape, server-side total, clamps and trims', () => {
  const r = parseAtsReport('Here: {"areas":[{"name":"Format & parseability","score":99,"comment":"ok"},{"name":"Keywords & skills","score":20,"comment":"x"}],"strengths":["a"],"fixes":[{"priority":"HIGH","issue":"No metrics","fix":"Add %"}],"keywords_missing":["DSO"],"jd_match":"","summary":"s","overall":100}');
  assert.equal(r.areas.length, 6);
  assert.equal(r.areas[0].score, 30);          // clamped to max
  assert.equal(r.overall, 50);                  // recomputed, not trusted
  assert.equal(r.fixes[0].priority, 'high');
  assert.equal(r.jd_match, null);
  assert.equal(parseAtsReport('not json'), null);
});
test('razorpay signature', async () => {
  const sig = await hmacHex('secret', 'order_1|pay_1');
  assert.ok(await verifyRazorpayCheckout('order_1', 'pay_1', sig, 'secret'));
  assert.ok(!(await verifyRazorpayCheckout('order_1', 'pay_2', sig, 'secret')));
});
test('IST buckets', () => {
  assert.deepEqual(buckets(new Date('2026-10-03T20:00:00Z')), { day: 'day:2026-10-04', hour: 'hour:2026-10-04T01' });
});

// ---------------- worker with mocked services ----------------
const env = {
  SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc-role-secret',
  TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'ts', RAZORPAY_KEY_ID: 'rzp_test', RAZORPAY_KEY_SECRET: 'rzsecret',
  RAZORPAY_WEBHOOK_SECRET: 'whsecret', ANTHROPIC_API_KEY: 'sk-test', HASH_PEPPER: 'pepper', ADMIN_EMAILS: 'boss@x.com',
  MODEL_FAST: 'fast', MODEL_SMART: 'smart', PRICE_FAST_IN: '1', PRICE_FAST_OUT: '5', PRICE_SMART_IN: '2', PRICE_SMART_OUT: '10',
  USD_INR: '90', CREDIT_VALUE_PAISE: '430', MIN_MARGIN: '5',
  ASSETS: { fetch: async () => new Response('<html>ok</html>', { headers: { 'Content-Type': 'text/html' } }) },
};
const ctx = { waitUntil: () => {} };

function mockServices(state) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url); calls.push({ url, opts });
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    if (url.endsWith('/auth/v1/user')) {
      return opts.headers.Authorization === 'Bearer good'
        ? Response.json({ id: 'u1', email: state.email || 'user@x.com', email_confirmed_at: 'x', phone: '919876543210', phone_confirmed_at: 'x' })
        : new Response('no', { status: 401 });
    }
    if (url.includes('/rest/v1/profiles')) return Response.json([{ free_credits: state.free, paid_credits: state.paid }]);
    if (url.includes('/rest/v1/free_grants')) return Response.json([]);
    if (url.includes('/rest/v1/payments')) return Response.json(state.ownsOrder ? [{ id: 1 }] : []);
    if (url.includes('/rpc/reserve_usage')) { state.reserved = body; return Response.json(state.reserveResult || { ok: true, usage_id: 7, day_spent_paise: 10, day_budget_paise: 50000 }); }
    if (url.includes('/rpc/finalize_usage')) { state.finalized = body; return new Response(''); }
    if (url.includes('/rpc/credit_payment')) { state.credited = body; return Response.json('ok'); }
    if (url.includes('/rpc/track_events')) { state.tracked = body; return new Response(''); }
    if (url.includes('/rpc/admin_dashboard')) { state.dash = body; return Response.json({ kpi: {} }); }
    if (url.includes('/rpc/claim_free_grant')) { state.claim = body; return Response.json('ok'); }
    if (url.includes('turnstile')) return Response.json({ success: state.human !== false });
    if (url.includes('api.anthropic.com')) {
      state.aiBody = body;
      if (state.aiFail) return new Response('err', { status: 529 });
      return Response.json({ content: [{ type: 'text', text: state.aiText || 'Do this.' }], usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 2000 } });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return calls;
}
const req = (path, { method = 'GET', body, token = 'good', headers = {} } = {}) =>
  new Request('https://arcopilot.in' + path, {
    method, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
  });

test('config exposes no secrets', async () => {
  mockServices({});
  const r = await worker.fetch(req('/api/config', { token: null }), env, ctx);
  const txt = await r.text();
  for (const s of ['svc-role-secret', 'rzsecret', 'whsecret', 'sk-test', 'pepper', '"ts"']) assert.ok(!txt.includes(s), 'leaked ' + s);
  assert.ok(r.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
});

test('rejects requests without a valid login', async () => {
  mockServices({});
  const r = await worker.fetch(req('/api/ask', { method: 'POST', body: { question: 'hi' }, token: 'bad' }), env, ctx);
  assert.equal(r.status, 401);
});

test('blocks cross-site POST', async () => {
  mockServices({});
  const r = await worker.fetch(req('/api/ask', { method: 'POST', body: { question: 'hi' }, headers: { Origin: 'https://evil.com' } }), env, ctx);
  assert.equal(r.status, 403);
});

test('paid question: reserves, masks PII, calls AI, records real cost', async () => {
  const s = { free: 0, paid: 10 }; mockServices(s);
  const r = await worker.fetch(req('/api/ask', { method: 'POST', body: { mode: 'detailed', question: 'Customer 9876543210 is 75 days overdue' } }), env, ctx);
  const d = await r.json();
  assert.equal(d.ok, true); assert.equal(d.answer, 'Do this.'); assert.equal(d.masked, true);
  assert.equal(s.reserved.p_credits, 3); assert.equal(s.reserved.p_is_free, false);
  assert.ok(!JSON.stringify(s.aiBody).includes('9876543210'), 'phone sent to AI');
  assert.equal(s.aiBody.max_tokens, 1500);
  assert.equal(s.finalized.p_success, true);
  assert.ok(s.finalized.p_cost_paise > 0);
});

test('free question uses fast model, short answer, needs human check', async () => {
  const s = { free: 3, paid: 0 }; mockServices(s);
  let r = await worker.fetch(req('/api/ask', { method: 'POST', body: { mode: 'quick', question: 'What is DSO?', turnstileToken: 't' } }), env, ctx);
  assert.equal((await r.json()).ok, true);
  assert.equal(s.aiBody.model, 'fast'); assert.equal(s.aiBody.max_tokens, 500); assert.equal(s.reserved.p_is_free, true);
  const s2 = { free: 3, paid: 0, human: false }; mockServices(s2);
  r = await worker.fetch(req('/api/ask', { method: 'POST', body: { mode: 'quick', question: 'What is DSO?', turnstileToken: 't' } }), env, ctx);
  assert.equal(r.status, 403);
});

test('free credits cannot be used for paid-only requests', async () => {
  mockServices({ free: 3, paid: 0 });
  const r = await worker.fetch(req('/api/ask', { method: 'POST', body: { mode: 'strategy', question: 'Plan please', turnstileToken: 't' } }), env, ctx);
  assert.equal(r.status, 402);
});

test('budget exhausted => no AI call', async () => {
  const s = { free: 3, paid: 0, reserveResult: { ok: false, reason: 'free_budget_day' } }; mockServices(s);
  const r = await worker.fetch(req('/api/ask', { method: 'POST', body: { mode: 'quick', question: 'x', turnstileToken: 't' } }), env, ctx);
  const d = await r.json();
  assert.equal(d.reason, 'free_budget_day'); assert.equal(s.aiBody, undefined);
});

test('AI failure refunds credits', async () => {
  const s = { free: 0, paid: 10, aiFail: true }; mockServices(s);
  const r = await worker.fetch(req('/api/ask', { method: 'POST', body: { mode: 'quick', question: 'x' } }), env, ctx);
  assert.equal(r.status, 503); assert.equal(s.finalized.p_success, false);
});

test('question too long is rejected before any cost', async () => {
  const s = { free: 0, paid: 10 }; mockServices(s);
  const r = await worker.fetch(req('/api/ask', { method: 'POST', body: { mode: 'quick', question: 'a'.repeat(4001) } }), env, ctx);
  assert.equal(r.status, 400); assert.equal(s.reserved, undefined);
});

test('webhook: bad signature rejected, good signature credits', async () => {
  const s = {}; mockServices(s);
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 19900 } } } });
  let r = await worker.fetch(req('/api/razorpay/webhook', { method: 'POST', body: raw, token: null, headers: { 'X-Razorpay-Signature': 'nope' } }), env, ctx);
  assert.equal(r.status, 400); assert.equal(s.credited, undefined);
  const sig = await hmacHex('whsecret', raw);
  r = await worker.fetch(req('/api/razorpay/webhook', { method: 'POST', body: raw, token: null, headers: { 'X-Razorpay-Signature': sig } }), env, ctx);
  assert.equal(r.status, 200); assert.equal(s.credited.p_amount, 19900);
});

test('payment verify requires valid signature and own order', async () => {
  const s = { ownsOrder: false }; mockServices(s);
  const sig = await hmacHex('rzsecret', 'order_1|pay_1');
  let r = await worker.fetch(req('/api/payments/verify', { method: 'POST', body: { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: sig } }), env, ctx);
  assert.equal(r.status, 404);
  s.ownsOrder = true;
  r = await worker.fetch(req('/api/payments/verify', { method: 'POST', body: { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'forged' } }), env, ctx);
  assert.equal(r.status, 400);
});

test('admin endpoints refuse non-admins', async () => {
  mockServices({ email: 'user@x.com' });
  const r = await worker.fetch(req('/api/admin/metrics'), env, ctx);
  assert.equal(r.status, 403);
});

test('free claim stores only hashes, never the phone number', async () => {
  const s = {}; mockServices(s);
  const r = await worker.fetch(req('/api/claim-free', { method: 'POST', body: { turnstileToken: 't', deviceId: 'd1' } }), env, ctx);
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(s.claim).includes('9876543210'));
  assert.equal(s.claim.p_phone_hash.length, 64);
});

test('static pages get security headers', async () => {
  mockServices({});
  const r = await worker.fetch(req('/', { token: null }), env, ctx);
  assert.equal(r.headers.get('X-Frame-Options'), 'DENY');
  assert.ok(r.headers.get('Strict-Transport-Security'));
});

// ---------------- Resume ATS ----------------
const RESUME = 'Priya Sharma | priya.s@mail.com | 9876543210 | Bengaluru\nSUMMARY\nAR Analyst with 5 years in order-to-cash.\n' +
  'EXPERIENCE\nAR Analyst, ABC Ltd, Jan 2021 - Present\n- Reduced DSO from 62 to 48 days\n- Managed 300 customer accounts\n'.repeat(4) +
  'EDUCATION\nB.Com, 2019\nSKILLS\nSAP FI, Excel, Collections';
const AI_JSON = JSON.stringify({ areas: [
  { name: 'Format & parseability', score: 25, comment: 'Clean' }, { name: 'Contact & profile', score: 9, comment: 'Good' },
  { name: 'Keywords & skills', score: 18, comment: 'Add tools' }, { name: 'Impact & achievements', score: 15, comment: 'Some metrics' },
  { name: 'Structure & sections', score: 8, comment: 'Fine' }, { name: 'Language & clarity', score: 4, comment: 'Fine' }],
  strengths: ['Quantified DSO'], fixes: [{ priority: 'high', issue: 'Thin skills', fix: 'Add BlackLine, HighRadius if you have them' }],
  keywords_missing: ['Cash application'], jd_match: null, summary: 'Solid.' });

test('ATS: paid report, 12 credits, PII masked, fixed max tokens, clean JSON back', async () => {
  const s = { free: 3, paid: 13, aiText: AI_JSON }; mockServices(s);
  const r = await worker.fetch(req('/api/ats', { method: 'POST', body: { resumeText: RESUME, jobDescription: 'Need SAP and cash application' } }), env, ctx);
  const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.ok, true);
  assert.equal(d.report.overall, 79); assert.equal(d.report.areas.length, 6);
  assert.equal(s.reserved.p_credits, 12); assert.equal(s.reserved.p_mode, 'ats'); assert.equal(s.reserved.p_is_free, false);
  assert.equal(s.aiBody.max_tokens, MODES.ats.maxTokens); assert.equal(s.aiBody.model, 'smart');
  const sent = JSON.stringify(s.aiBody);
  for (const bad of ['9876543210', 'priya.s@mail.com']) assert.ok(!sent.includes(bad), bad + ' sent to AI');
  assert.ok(sent.includes('<job>'));
  assert.equal(s.finalized.p_success, true);
});

test('ATS: free credits cannot pay; not enough credits => 402 and no AI call', async () => {
  const s = { free: 3, paid: 11, aiText: AI_JSON }; mockServices(s);
  const r = await worker.fetch(req('/api/ats', { method: 'POST', body: { resumeText: RESUME } }), env, ctx);
  assert.equal(r.status, 402); assert.equal((await r.json()).reason, 'no_ats_credits');
  assert.equal(s.reserved, undefined); assert.equal(s.aiBody, undefined);
});

test('ATS: too short / too long input rejected before any cost', async () => {
  const s = { paid: 50 }; mockServices(s);
  let r = await worker.fetch(req('/api/ats', { method: 'POST', body: { resumeText: 'short' } }), env, ctx);
  assert.equal((await r.json()).reason, 'resume_short');
  r = await worker.fetch(req('/api/ats', { method: 'POST', body: { resumeText: 'a'.repeat(15001) } }), env, ctx);
  assert.equal((await r.json()).reason, 'resume_long');
  r = await worker.fetch(req('/api/ats', { method: 'POST', body: { resumeText: RESUME, jobDescription: 'j'.repeat(6001) } }), env, ctx);
  assert.equal((await r.json()).reason, 'jd_long');
  assert.equal(s.reserved, undefined);
});

test('ATS: unusable AI reply => credits refunded', async () => {
  const s = { paid: 13, aiText: 'Sorry, I cannot.' }; mockServices(s);
  const r = await worker.fetch(req('/api/ats', { method: 'POST', body: { resumeText: RESUME } }), env, ctx);
  assert.equal(r.status, 503); assert.equal(s.finalized.p_success, false);
});

test('ATS mode cannot be used through /api/ask (falls back to quick)', async () => {
  const s = { paid: 50 }; mockServices(s);
  await worker.fetch(req('/api/ask', { method: 'POST', body: { mode: 'ats', question: 'hi' } }), env, ctx);
  assert.equal(s.reserved.p_credits, 1);
});

test('config lists individual and corporate slabs, no secrets', async () => {
  mockServices({});
  const d = await (await worker.fetch(req('/api/config', { token: null }), env, ctx)).json();
  const cats = new Set(Object.values(d.packs).map(p => p.category));
  assert.ok(cats.has('individual') && cats.has('corporate'));
  assert.equal(d.modes.ats.askable, false);
  assert.ok(!JSON.stringify(d).includes('PROMPT'));
});

// ---------------- Owner analytics ----------------
test('AR question topic is stored as a label only, never the question', async () => {
  const s = { paid: 10 }; mockServices(s);
  await worker.fetch(req('/api/ask', { method: 'POST', body: { mode: 'detailed', question: 'Customer short paid citing a quality dispute, 9876543210' } }), env, ctx);
  assert.equal(s.reserved.p_topic, 'Disputes & deductions');
  assert.ok(!JSON.stringify(s.reserved).includes('quality dispute'));
});

test('track: counts allowed events only, adds referrer site/device/country, stores no IP', async () => {
  const s = {}; mockServices(s);
  const ev = [{ m: 'page_view', l: '/' }, { m: 'cta', l: 'whatsapp' }, { m: 'cta', l: '<script>' }, { m: 'evil', l: 'x' }, { m: 'quiz_start', l: 'Cash application' }];
  const r = await worker.fetch(req('/api/track', { method: 'POST', token: null, body: { events: ev, ref: 'https://www.linkedin.com/feed/' },
    headers: { Origin: 'https://arcopilot.in', 'CF-Connecting-IP': '1.2.3.4', 'CF-IPCountry': 'IN', 'User-Agent': 'Mozilla/5.0 (iPhone) Mobile' } }), env, ctx);
  assert.equal(r.status, 204);
  const got = s.tracked.p_events.map(e => e.m + ':' + e.l);
  assert.deepEqual(got, ['page_view:/', 'cta:whatsapp', 'quiz_start:Cash application', 'referrer:linkedin.com', 'device:mobile', 'country:IN']);
  assert.equal(s.tracked.p_visitor.length, 64);
  assert.ok(!JSON.stringify(s.tracked).includes('1.2.3.4'));
});

test('track: ignores other websites and bots', async () => {
  const s = {}; mockServices(s);
  await worker.fetch(req('/api/track', { method: 'POST', token: null, body: { events: [{ m: 'page_view', l: '/' }] }, headers: { Origin: 'https://evil.com' } }), env, ctx);
  await worker.fetch(req('/api/track', { method: 'POST', token: null, body: { events: [{ m: 'page_view', l: '/' }] }, headers: { Origin: 'https://arcopilot.in', 'User-Agent': 'Googlebot/2.1' } }), env, ctx);
  assert.equal(s.tracked, undefined);
});

test('owner dashboard: admins only', async () => {
  const s = { email: 'user@x.com' }; mockServices(s);
  let r = await worker.fetch(req('/api/admin/dashboard?days=30'), env, ctx);
  assert.equal(r.status, 403); assert.equal(s.dash, undefined);
  const s2 = { email: 'boss@x.com' }; mockServices(s2);
  r = await worker.fetch(req('/api/admin/dashboard?days=7'), env, ctx);
  assert.equal(r.status, 200); assert.equal(s2.dash.p_days, 7);
});

test('www address redirects to the main domain', async () => {
  mockServices({});
  const r = await worker.fetch(new Request('https://www.cashcollectpro.com/pricing.html?x=1'), env, ctx);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), 'https://cashcollectpro.com/pricing.html?x=1');
});

test('without OTP: one free set per Google mailbox (dots/+tags ignored)', async () => {
  const s1 = { email: 'sudipta.ghosh+1@gmail.com' }; mockServices(s1);
  await worker.fetch(req('/api/claim-free', { method: 'POST', body: { turnstileToken: 't', deviceId: 'd1' } }), env, ctx);
  const s2 = { email: 'sudiptaghosh@gmail.com' }; mockServices(s2);
  await worker.fetch(req('/api/claim-free', { method: 'POST', body: { turnstileToken: 't', deviceId: 'd2' } }), env, ctx);
  assert.equal(s1.claim.p_phone_hash, s2.claim.p_phone_hash);
  assert.ok(!JSON.stringify(s1.claim).includes('sudipta'));
});

test('with OTP switched on: phone must be verified', async () => {
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'u1', email: 'a@x.com', email_confirmed_at: 'x' });
    if (url.includes('turnstile')) return Response.json({ success: true });
    throw new Error('unexpected ' + url);
  };
  const r = await worker.fetch(req('/api/claim-free', { method: 'POST', body: { turnstileToken: 't' } }), { ...env, REQUIRE_PHONE_OTP: 'true' }, ctx);
  assert.equal(r.status, 403); assert.equal((await r.json()).reason, 'phone_not_verified');
});

test('without OTP: one free set per Google mailbox (dots/+tags ignored)', async () => {
  const s1 = { email: 'sudipta.ghosh+1@gmail.com' }; mockServices(s1);
  await worker.fetch(req('/api/claim-free', { method: 'POST', body: { turnstileToken: 't', deviceId: 'd1' } }), env, ctx);
  const s2 = { email: 'sudiptaghosh@gmail.com' }; mockServices(s2);
  await worker.fetch(req('/api/claim-free', { method: 'POST', body: { turnstileToken: 't', deviceId: 'd2' } }), env, ctx);
  assert.equal(s1.claim.p_phone_hash, s2.claim.p_phone_hash);
  assert.ok(!JSON.stringify(s1.claim).includes('sudipta'));
});

test('with OTP switched on: phone must be verified', async () => {
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'u1', email: 'a@x.com', email_confirmed_at: 'x' });
    if (url.includes('turnstile')) return Response.json({ success: true });
    throw new Error('unexpected ' + url);
  };
  const r = await worker.fetch(req('/api/claim-free', { method: 'POST', body: { turnstileToken: 't' } }), { ...env, REQUIRE_PHONE_OTP: 'true' }, ctx);
  assert.equal(r.status, 403); assert.equal((await r.json()).reason, 'phone_not_verified');
});
