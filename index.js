// CashCollect Pro – Cloudflare Worker (backend + static site)
// All secrets live in Cloudflare (wrangler secret put ...). Nothing secret is sent to the browser.

import {
  MODES, PACKS, FREE_MAX_TOKENS, MAX_QUESTION_CHARS, REASONS, ATS_LIMITS, parseAtsReport,
  classifyTopic, cleanEvents, referrerHost, deviceType,
  costPaise, maxCostPaise, passesMarginGuard, maskPII, hmacHex,
  verifyRazorpayCheckout, verifyRazorpayWebhook, buckets,
} from './lib.js';
import { SYSTEM_PROMPT, ATS_PROMPT } from './knowledge.js';

// ---------------------------------------------------------------------
// Security headers on every response
// ---------------------------------------------------------------------
function securityHeaders(env) {
  const supa = env.SUPABASE_URL;
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://challenges.cloudflare.com https://checkout.razorpay.com",
      `connect-src 'self' ${supa} https://lumberjack.razorpay.com https://api.razorpay.com`,
      "frame-src https://challenges.cloudflare.com https://api.razorpay.com https://checkout.razorpay.com",
      "worker-src 'self' blob:",
      "font-src 'self'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline'",
      "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
    ].join('; '),
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com")',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(env) },
  });
}
const fail = (env, reason, status = 400) => json(env, { ok: false, reason, message: REASONS[reason] || 'Request could not be completed.' }, status);

// ---------------------------------------------------------------------
// Supabase helpers (server side, service role key never leaves the server)
// ---------------------------------------------------------------------
async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!r.ok) return null;
  return r.json(); // Supabase has validated the token
}

async function rpc(env, fn, args) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`db_error ${fn} ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function restGet(env, path) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!r.ok) throw new Error(`db_error ${path} ${r.status}`);
  return r.json();
}

async function restUpsertSetting(env, key, value) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/settings?on_conflict=key`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('db_error settings');
}

// ---------------------------------------------------------------------
// Anti-fraud helpers
// ---------------------------------------------------------------------
async function verifyTurnstile(token, ip, env) {
  if (!token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const d = await r.json();
  return d.success === true;
}

// Optional: reject virtual / VoIP numbers using Twilio Lookup (if configured).
async function isVirtualNumber(phone, env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return false;
  const url = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent('+' + phone.replace(/^\+/, ''))}?Fields=line_type_intelligence`;
  const r = await fetch(url, { headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`) } });
  if (!r.ok) return false; // fail open on lookup outage; other limits still apply
  const d = await r.json();
  const type = d?.line_type_intelligence?.type || '';
  return ['nonFixedVoip', 'voip', 'personal', 'pager', 'voicemail'].includes(type);
}

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || '0.0.0.0';

function isAdmin(user, env) {
  const admins = (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return !!user?.email && admins.includes(user.email.toLowerCase()) && !!user.email_confirmed_at;
}

function priceFor(tier, env) {
  return tier === 'fast'
    ? { in: Number(env.PRICE_FAST_IN), out: Number(env.PRICE_FAST_OUT) }
    : { in: Number(env.PRICE_SMART_IN), out: Number(env.PRICE_SMART_OUT) };
}

// Reject cross-site POSTs (defence in depth on top of Bearer tokens)
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

// ---------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------
async function handleConfig(env) {
  // Only PUBLIC values here.
  return json(env, {
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    razorpayKeyId: env.RAZORPAY_KEY_ID,
    modes: Object.fromEntries(Object.entries(MODES).map(([k, m]) => [k, { label: m.label, credits: m.credits, freeAllowed: m.freeAllowed, askable: m.askable !== false }])),
    packs: Object.fromEntries(Object.entries(PACKS).map(([k, p]) => [k, {
      label: p.label, amountPaise: p.amountPaise, credits: p.credits, category: p.category, note: p.note, highlight: !!p.highlight,
    }])),
    atsLimits: ATS_LIMITS,
  });
}

async function handleMe(user, env) {
  const rows = await restGet(env, `profiles?user_id=eq.${user.id}&select=free_credits,paid_credits,is_blocked`);
  const grants = await restGet(env, `free_grants?user_id=eq.${user.id}&select=granted_at`);
  return json(env, {
    ok: true,
    email: user.email,
    phoneVerified: !!user.phone_confirmed_at,
    freeClaimed: grants.length > 0,
    isAdmin: isAdmin(user, env),
    ...(rows[0] || { free_credits: 0, paid_credits: 0 }),
  });
}

async function handleClaimFree(request, user, env) {
  const body = await request.json().catch(() => ({}));
  const ip = clientIp(request);
  if (!(await verifyTurnstile(body.turnstileToken, ip, env))) return fail(env, 'human_check', 403);
  if (!user.phone || !user.phone_confirmed_at) return fail(env, 'phone_not_verified', 403);
  if (await isVirtualNumber(user.phone, env)) return fail(env, 'virtual_number', 403);

  const pepper = env.HASH_PEPPER;
  const phoneHash  = await hmacHex(pepper, 'phone:' + user.phone.replace(/\D/g, ''));
  const ipHash     = await hmacHex(pepper, 'ip:' + ip);
  const deviceHash = await hmacHex(pepper, 'dev:' + String(body.deviceId || '').slice(0, 64));

  const status = await rpc(env, 'claim_free_grant', {
    p_user: user.id, p_phone_hash: phoneHash, p_ip_hash: ipHash, p_device_hash: deviceHash,
  });
  if (status !== 'ok') return fail(env, status, 403);
  return json(env, { ok: true });
}

// One call to Claude. Returns { ok, usage, text }. Never throws.
async function callClaude(env, { model, maxTokens, system, content }) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      }),
    });
    if (!r.ok) return { ok: false, usage: {}, text: '' };
    const d = await r.json();
    const text = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    return { ok: !!text, usage: d.usage || {}, text };
  } catch (_) { return { ok: false, usage: {}, text: '' }; }
}

async function finalize(env, usageId, ok, usage, cost, b) {
  await rpc(env, 'finalize_usage', {
    p_usage_id: usageId, p_success: ok, p_cost_paise: cost,
    p_input: usage.input_tokens || 0, p_output: usage.output_tokens || 0,
    p_cache_read: usage.cache_read_input_tokens || 0, p_cache_write: usage.cache_creation_input_tokens || 0,
    p_day_bucket: b.day, p_hour_bucket: b.hour,
  });
}

async function handleAsk(request, user, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const mode = MODES[body.mode] && MODES[body.mode].askable !== false ? body.mode : 'quick';
  const m = MODES[mode];
  const raw = String(body.question || '').trim();
  if (!raw) return fail(env, 'too_long');
  if (raw.length > MAX_QUESTION_CHARS) return fail(env, 'too_long');

  // Which pot pays? Paid credits first; free only for quick questions.
  const me = (await restGet(env, `profiles?user_id=eq.${user.id}&select=free_credits,paid_credits`))[0] || {};
  const usePaid = (me.paid_credits || 0) >= m.credits;
  const useFree = !usePaid && m.freeAllowed && (me.free_credits || 0) >= m.credits;
  if (!usePaid && !useFree) return fail(env, m.freeAllowed ? 'no_free_credits' : 'no_paid_credits', 402);

  // Free questions must pass the human check again (stops scripted abuse).
  if (useFree && !(await verifyTurnstile(body.turnstileToken, clientIp(request), env))) return fail(env, 'human_check', 403);

  const tier = useFree ? 'fast' : m.tier;
  const model = tier === 'fast' ? env.MODEL_FAST : env.MODEL_SMART;
  const maxTokens = useFree ? FREE_MAX_TOKENS : m.maxTokens;
  const price = priceFor(tier, env);
  const usdInr = Number(env.USD_INR);
  const question = maskPII(raw);

  const worst = maxCostPaise({ systemChars: SYSTEM_PROMPT.length, questionChars: question.length, maxTokens }, price, usdInr);
  if (!useFree && !passesMarginGuard(worst, m.credits, Number(env.CREDIT_VALUE_PAISE), Number(env.MIN_MARGIN))) {
    return fail(env, 'margin');
  }

  const b = buckets();
  const res = await rpc(env, 'reserve_usage', {
    p_user: user.id, p_mode: mode, p_model: model, p_credits: m.credits, p_is_free: useFree,
    p_max_cost_paise: worst, p_day_bucket: b.day, p_hour_bucket: b.hour, p_topic: classifyTopic(raw),
  });
  if (!res?.ok) return fail(env, res?.reason || 'no_profile', 402);

  // Alert once when half of today's free budget is used
  if (useFree && res.day_spent_paise * 2 >= res.day_budget_paise && env.ALERT_WEBHOOK_URL) {
    ctx.waitUntil((async () => {
      if (await rpc(env, 'mark_alerted', { p_bucket: b.day })) {
        await fetch(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `CashCollect Pro: over 50% of today's free budget used (${(res.day_spent_paise / 100).toFixed(2)} INR).` }) });
      }
    })().catch(() => {}));
  }

  const ai = await callClaude(env, {
    model, maxTokens, system: SYSTEM_PROMPT,
    content: `Request type: ${m.label}${useFree ? ' (free preview: keep it brief, around 250 words)' : ''}\n\n${question}`,
  });
  const ok = ai.ok, answer = ai.text;
  const cost = costPaise(ai.usage, price, usdInr);
  await finalize(env, res.usage_id, ok, ai.usage, cost, b);

  if (!ok) return json(env, { ok: false, reason: 'ai_error', message: 'The AI service is busy. Your credits have been refunded. Please try again.' }, 503);
  return json(env, { ok: true, answer, creditsUsed: m.credits, usedFree: useFree, masked: question !== raw });
}

// Resume ATS score: paid only, fixed price in credits, fixed maximum tokens => known maximum cost.
async function handleAts(request, user, env) {
  const body = await request.json().catch(() => ({}));
  const m = MODES.ats;
  const resumeRaw = String(body.resumeText || '').replace(/\s+\n/g, '\n').trim();
  const jdRaw = String(body.jobDescription || '').trim();
  if (resumeRaw.length < ATS_LIMITS.resumeMin) return fail(env, 'resume_short');
  if (resumeRaw.length > ATS_LIMITS.resumeMax) return fail(env, 'resume_long');
  if (jdRaw.length > ATS_LIMITS.jdMax) return fail(env, 'jd_long');

  const me = (await restGet(env, `profiles?user_id=eq.${user.id}&select=paid_credits`))[0] || {};
  if ((me.paid_credits || 0) < m.credits) return fail(env, 'no_ats_credits', 402);

  // Mask contact / ID / bank details. Strip angle brackets so the text can't close our tags.
  const resume = maskPII(resumeRaw).replace(/[<>]/g, ' ');
  const jd = maskPII(jdRaw).replace(/[<>]/g, ' ');
  const price = priceFor(m.tier, env);
  const usdInr = Number(env.USD_INR);
  const worst = maxCostPaise({ systemChars: ATS_PROMPT.length, questionChars: resume.length + jd.length + 60, maxTokens: m.maxTokens }, price, usdInr);
  if (!passesMarginGuard(worst, m.credits, Number(env.CREDIT_VALUE_PAISE), Number(env.MIN_MARGIN))) return fail(env, 'margin');

  const b = buckets();
  const res = await rpc(env, 'reserve_usage', {
    p_user: user.id, p_mode: 'ats', p_model: env.MODEL_SMART, p_credits: m.credits, p_is_free: false,
    p_max_cost_paise: worst, p_day_bucket: b.day, p_hour_bucket: b.hour, p_topic: 'Resume ATS',
  });
  if (!res?.ok) return fail(env, res?.reason || 'no_profile', 402);

  const ai = await callClaude(env, {
    model: env.MODEL_SMART, maxTokens: m.maxTokens, system: ATS_PROMPT,
    content: `<resume>\n${resume}\n</resume>` + (jd ? `\n<job>\n${jd}\n</job>` : '\n(No job description given.)'),
  });
  const report = ai.ok ? parseAtsReport(ai.text) : null;
  const ok = !!report;
  await finalize(env, res.usage_id, ok, ai.usage, costPaise(ai.usage, price, usdInr), b);
  if (!ok) return json(env, { ok: false, reason: 'ai_error', message: 'We could not complete the report. Your credits have been refunded. Please try again.' }, 503);
  return json(env, { ok: true, report, creditsUsed: m.credits, masked: resume !== resumeRaw.replace(/[<>]/g, ' ') });
}

// Website footprint. Anonymous, no cookies: stores counts per day only.
// The visitor fingerprint is a keyed hash that changes daily, used only to count unique visitors.
async function handleTrack(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) return new Response(null, { status: 204 });
  const ua = request.headers.get('User-Agent') || '';
  const device = deviceType(ua);
  if (device === 'bot') return new Response(null, { status: 204 });
  const raw = await request.text();
  if (raw.length > 4000) return new Response(null, { status: 204 });
  let body; try { body = JSON.parse(raw); } catch { return new Response(null, { status: 204 }); }
  const events = cleanEvents(body.events);
  if (events.some(e => e.m === 'page_view')) {
    const ref = referrerHost(body.ref, new URL(request.url).hostname);
    events.push({ m: 'referrer', l: ref || 'direct' });
    events.push({ m: 'device', l: device });
    const country = (request.cf?.country || request.headers.get('CF-IPCountry') || '').slice(0, 2).toUpperCase();
    if (/^[A-Z]{2}$/.test(country)) events.push({ m: 'country', l: country });
    const city = String(request.cf?.city || '').slice(0, 40);
    if (/^[\p{L} .'-]{2,40}$/u.test(city)) events.push({ m: 'city', l: city });
  }
  if (!events.length) return new Response(null, { status: 204 });
  const day = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const visitor = await hmacHex(env.HASH_PEPPER, `visitor:${day}:${clientIp(request)}:${ua.slice(0, 200)}`);
  await rpc(env, 'track_events', { p_day: day, p_visitor: visitor, p_events: events.slice(0, 20) });
  return new Response(null, { status: 204 });
}

async function handleCreateOrder(request, user, env) {
  const body = await request.json().catch(() => ({}));
  const pack = PACKS[body.pack];
  if (!pack) return fail(env, 'bad_pack');
  const receipt = `rcpt_${Date.now()}_${user.id.slice(0, 8)}`;
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount: pack.amountPaise, currency: 'INR', receipt, notes: { user_id: user.id, pack: body.pack } }),
  });
  if (!r.ok) return json(env, { ok: false, message: 'Payment service unavailable. Please try again.' }, 502);
  const order = await r.json();
  await rpc(env, 'create_payment_order', {
    p_user: user.id, p_pack: body.pack, p_amount: pack.amountPaise, p_credits: pack.credits, p_order_id: order.id,
  });
  return json(env, { ok: true, orderId: order.id, amountPaise: pack.amountPaise, keyId: env.RAZORPAY_KEY_ID });
}

async function handleVerifyPayment(request, user, env) {
  const b = await request.json().catch(() => ({}));
  const valid = await verifyRazorpayCheckout(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature, env.RAZORPAY_KEY_SECRET);
  if (!valid) return json(env, { ok: false, message: 'Payment could not be verified.' }, 400);
  // Make sure this order belongs to this user
  const rows = await restGet(env, `payments?razorpay_order_id=eq.${encodeURIComponent(b.razorpay_order_id)}&user_id=eq.${user.id}&select=id`);
  if (!rows.length) return json(env, { ok: false, message: 'Order not found.' }, 404);
  const status = await rpc(env, 'credit_payment', { p_order_id: b.razorpay_order_id, p_payment_id: b.razorpay_payment_id, p_amount: null });
  return json(env, { ok: status === 'ok' || status === 'already_paid', status });
}

async function handleRazorpayWebhook(request, env) {
  const raw = await request.text();
  const sig = request.headers.get('X-Razorpay-Signature') || '';
  if (!(await verifyRazorpayWebhook(raw, sig, env.RAZORPAY_WEBHOOK_SECRET))) return new Response('bad signature', { status: 400 });
  const evt = JSON.parse(raw);
  const p = evt?.payload?.payment?.entity;
  if ((evt.event === 'payment.captured' || evt.event === 'order.paid') && p?.order_id) {
    await rpc(env, 'credit_payment', { p_order_id: p.order_id, p_payment_id: p.id, p_amount: p.amount });
  }
  return new Response('ok');
}

async function handleAdmin(request, user, env, path) {
  if (!isAdmin(user, env)) return fail(env, 'forbidden', 403);
  if (path === '/api/admin/metrics' && request.method === 'GET') {
    return json(env, { ok: true, metrics: await rpc(env, 'admin_metrics', { p_day_bucket: buckets().day }) });
  }
  if (path === '/api/admin/dashboard' && request.method === 'GET') {
    const days = [7, 30, 90, 365].includes(Number(new URL(request.url).searchParams.get('days'))) ? Number(new URL(request.url).searchParams.get('days')) : 30;
    return json(env, { ok: true, dashboard: await rpc(env, 'admin_dashboard', { p_days: days }), packs: PACKS, modes: Object.fromEntries(Object.entries(MODES).map(([k, m]) => [k, m.label])) });
  }
  if (path === '/api/admin/settings' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const allowed = {
      free_enabled: 'bool', paid_enabled: 'bool', free_questions_per_phone: 'int',
      daily_free_budget_paise: 'int', hourly_free_budget_paise: 'int',
      max_grants_per_ip_per_day: 'int', max_grants_per_device_per_day: 'int',
      max_questions_per_minute: 'int', max_questions_per_day: 'int',
    };
    for (const [k, v] of Object.entries(b)) {
      if (!allowed[k]) continue;
      if (allowed[k] === 'bool' && typeof v === 'boolean') await restUpsertSetting(env, k, v);
      if (allowed[k] === 'int' && Number.isInteger(v) && v >= 0 && v <= 100000000) await restUpsertSetting(env, k, v);
    }
    return json(env, { ok: true });
  }
  return fail(env, 'not_found', 404);
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // www.cashcollectpro.com -> cashcollectpro.com (one address for logins, cookies and SEO)
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    try {
      if (path === '/api/razorpay/webhook' && request.method === 'POST') return await handleRazorpayWebhook(request, env);
      if (path === '/api/config' && request.method === 'GET') return await handleConfig(env);
      if (path === '/api/track' && request.method === 'POST') return await handleTrack(request, env);

      if (path.startsWith('/api/')) {
        if (request.method !== 'GET' && !sameOrigin(request)) return fail(env, 'forbidden', 403);
        const user = await getUser(request, env);
        if (!user) return fail(env, 'unauthorised', 401);

        if (path === '/api/me' && request.method === 'GET') return await handleMe(user, env);
        if (path === '/api/claim-free' && request.method === 'POST') return await handleClaimFree(request, user, env);
        if (path === '/api/ask' && request.method === 'POST') return await handleAsk(request, user, env, ctx);
        if (path === '/api/ats' && request.method === 'POST') return await handleAts(request, user, env);
        if (path === '/api/payments/order' && request.method === 'POST') return await handleCreateOrder(request, user, env);
        if (path === '/api/payments/verify' && request.method === 'POST') return await handleVerifyPayment(request, user, env);
        if (path.startsWith('/api/admin/')) return await handleAdmin(request, user, env, path);
        return fail(env, 'not_found', 404);
      }

      // Static files (index.html, app.js, ...) with security headers
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(securityHeaders(env))) out.headers.set(k, v);
      return out;
    } catch (err) {
      // Never leak internal details to the browser
      console.error(err?.message);
      return json(env, { ok: false, message: 'Something went wrong. Please try again.' }, 500);
    }
  },
};
