// Pure helper functions (no network). Unit-tested in test/lib.test.mjs

// ---------------------------------------------------------------------
// Products: what each kind of question costs the customer
// ---------------------------------------------------------------------
export const MODES = {
  quick:    { label: 'Quick AR question',   credits: 1,  tier: 'fast',  maxTokens: 700,  freeAllowed: true },
  email:    { label: 'Customer email',      credits: 2,  tier: 'smart', maxTokens: 800,  freeAllowed: false },
  script:   { label: 'Call script',         credits: 2,  tier: 'smart', maxTokens: 800,  freeAllowed: false },
  detailed: { label: 'Detailed analysis',   credits: 3,  tier: 'smart', maxTokens: 1500, freeAllowed: false },
  strategy: { label: 'Collection strategy', credits: 5,  tier: 'smart', maxTokens: 3000, freeAllowed: false },
  // Resume ATS check has its own endpoint (/api/ats); not selectable in /api/ask
  ats:      { label: 'Resume ATS score report', credits: 12, tier: 'smart', maxTokens: 2500, freeAllowed: false, askable: false },
};
export const FREE_MAX_TOKENS = 500;        // free answers are short
export const MAX_QUESTION_CHARS = 4000;    // hard cap on input size
export const ATS_LIMITS = { resumeMin: 300, resumeMax: 15000, jdMax: 6000 };

// Credit packs (slabs) – amounts are decided on the SERVER only.
// Bigger slab = lower price per credit. Credits add up (top up any time).
// Lowest net value per credit = ₹9,999 / 1,900 / 1.18 GST × 0.98 fee ≈ ₹4.37 -> CREDIT_VALUE_PAISE 430.
export const PACKS = {
  // Individuals
  try19:    { category: 'individual', label: 'Try',               amountPaise:   1900, credits:    2, note: 'Try the AI assistant' },
  start49:  { category: 'individual', label: 'Starter',           amountPaise:   4900, credits:    6, note: 'Quick questions or customer emails' },
  ats99:    { category: 'individual', label: 'Resume ATS Pack',   amountPaise:   9900, credits:   13, note: '1 full ATS score report + 1 question', highlight: true },
  pro199:   { category: 'individual', label: 'Professional',      amountPaise:  19900, credits:   28, note: 'About 9 detailed analyses' },
  power499: { category: 'individual', label: 'Power User',        amountPaise:  49900, credits:   75, note: 'About 15 collection strategies' },
  // Corporate
  team999:  { category: 'corporate',  label: 'Team',              amountPaise:  99900, credits:  160, note: 'For a small AR team' },
  biz2499:  { category: 'corporate',  label: 'Business',          amountPaise: 249900, credits:  425, note: 'Collections team or HR screening', highlight: true },
  ent4999:  { category: 'corporate',  label: 'Enterprise',        amountPaise: 499900, credits:  900, note: 'Shared services or campus hiring' },
  ent9999:  { category: 'corporate',  label: 'Enterprise Plus',   amountPaise: 999900, credits: 1900, note: 'Lowest price per credit' },
};

// ATS report: fixed scoring areas (server recomputes the total, never trusts the AI's sum)
export const ATS_AREAS = [
  ['Format & parseability', 30], ['Contact & profile', 10], ['Keywords & skills', 25],
  ['Impact & achievements', 20], ['Structure & sections', 10], ['Language & clarity', 5],
];

// Pull the first JSON object out of the AI's reply and clean it, so the browser only
// ever receives short plain-text fields in a fixed shape.
export function parseAtsReport(text) {
  const s = String(text || ''); const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let d; try { d = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!d || typeof d !== 'object' || !Array.isArray(d.areas)) return null;
  const str = (v, n = 300) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  const list = (v, n, len) => (Array.isArray(v) ? v : []).slice(0, n).map(x => str(x, len)).filter(Boolean);
  const areas = ATS_AREAS.map(([name, max]) => {
    const found = d.areas.find(x => x && str(x.name).toLowerCase().startsWith(name.slice(0, 6).toLowerCase())) || {};
    const score = Math.max(0, Math.min(max, Math.round(Number(found.score) || 0)));
    return { name, score, max, comment: str(found.comment, 240) };
  });
  const fixes = (Array.isArray(d.fixes) ? d.fixes : []).slice(0, 8).map(f => ({
    priority: ['high', 'medium', 'low'].includes(String(f?.priority).toLowerCase()) ? String(f.priority).toLowerCase() : 'medium',
    issue: str(f?.issue, 200), fix: str(f?.fix, 300),
  })).filter(f => f.issue);
  return {
    overall: areas.reduce((t, x) => t + x.score, 0),
    areas,
    strengths: list(d.strengths, 5, 200),
    fixes,
    keywords_missing: list(d.keywords_missing, 15, 40),
    jd_match: d.jd_match == null || d.jd_match === '' ? null : Math.max(0, Math.min(100, Math.round(Number(d.jd_match) || 0))),
    summary: str(d.summary, 500),
  };
}

// ---------------------------------------------------------------------
// Cost maths (prices in USD per million tokens, from env)
// ---------------------------------------------------------------------
export function costPaise(usage, price, usdInr) {
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const cr  = usage.cache_read_input_tokens || 0;
  const cw  = usage.cache_creation_input_tokens || 0;
  const usd = (inp * price.in + cr * price.in * 0.1 + cw * price.in * 1.25 + out * price.out) / 1e6;
  return Math.ceil(usd * usdInr * 100);
}

// Worst-case cost BEFORE calling the AI (system prompt not cached + full answer).
// ~3 characters per token is a safe (over-)estimate for English text.
export function maxCostPaise({ systemChars, questionChars, maxTokens }, price, usdInr) {
  const inTokens = Math.ceil((systemChars + questionChars) / 3) + 50;
  return costPaise({ cache_creation_input_tokens: inTokens, output_tokens: maxTokens }, price, usdInr);
}

// Margin guard: the worst-case AI cost must be <= 1/minMargin of what the
// customer pays for those credits.
export function passesMarginGuard(worstCasePaise, credits, creditValuePaise, minMargin) {
  return worstCasePaise * minMargin <= credits * creditValuePaise;
}

// ---------------------------------------------------------------------
// Data protection: mask personal / banking data before it reaches the AI
// ---------------------------------------------------------------------
const MASKS = [
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi, '[GSTIN]'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/gi,                       '[PAN]'],
  [/\b[A-Z]{4}0[A-Z0-9]{6}\b/gi,                     '[IFSC]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,         '[EMAIL]'],
  [/\b(?:\d[ -]?){13,19}\b/g,                        '[CARD/ACCOUNT]'],
  [/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,                 '[AADHAAR]'],
  [/(?:\+91[ -]?|\b0)?\b[6-9]\d{9}\b/g,              '[PHONE]'],
  [/\b\d{9,18}\b/g,                                  '[ACCOUNT]'],
];
export function maskPII(text) {
  let t = String(text);
  for (const [re, rep] of MASKS) t = t.replace(re, rep);
  return t;
}

// ---------------------------------------------------------------------
// Crypto helpers (Web Crypto – available in Cloudflare Workers and Node 18+)
// ---------------------------------------------------------------------
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// Constant-time comparison to avoid timing attacks
export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Razorpay Checkout signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret)
export async function verifyRazorpayCheckout(orderId, paymentId, signature, keySecret) {
  return safeEqual(await hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}
// Razorpay webhook signature = HMAC_SHA256(raw_body, webhook_secret)
export async function verifyRazorpayWebhook(rawBody, signature, webhookSecret) {
  return safeEqual(await hmacHex(webhookSecret, rawBody), signature);
}

// ---------------------------------------------------------------------
// Time buckets for the free budget (Indian Standard Time)
// ---------------------------------------------------------------------
export function buckets(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString(); // YYYY-MM-DDTHH:...
  return { day: `day:${ist.slice(0, 10)}`, hour: `hour:${ist.slice(0, 13)}` };
}

// Friendly messages for blocked requests
export const REASONS = {
  free_disabled:   'Free questions are paused right now. You can still buy credits to continue.',
  free_budget_day: "Today's free questions are fully booked. Buy credits to continue, or try again tomorrow.",
  free_budget_hour:'Free questions are very busy this hour. Please try again shortly, or buy credits.',
  no_free_credits: "You've used all your free questions. Choose a credit pack to continue.",
  no_paid_credits: 'Not enough AR Credits for this request. Please buy a credit pack.',
  paid_disabled:   'The service is temporarily paused for maintenance.',
  rate_minute:     'Too many questions in a short time. Please wait a minute.',
  rate_day:        "You've reached today's question limit. Please continue tomorrow.",
  blocked:         'This account is blocked. Please contact support.',
  no_profile:      'Account not ready. Please sign out and sign in again.',
  phone_used:      'This phone number has already received free questions.',
  already_claimed: 'You have already received your free questions.',
  ip_limit:        'Too many free sign-ups from this network today. Please try tomorrow.',
  device_limit:    'Too many free sign-ups from this device today. Please try tomorrow.',
  virtual_number:  'Please verify with a regular mobile number (virtual numbers are not accepted).',
  phone_not_verified: 'Please verify your mobile number first.',
  human_check:     'Security check failed. Please refresh the page and try again.',
  too_long:        'Your question is too long. Please shorten it.',
  margin:          'This request is too large for one question. Please shorten it or split it.',
  resume_short:    'We could not read enough text from your resume. Please upload a text-based PDF/DOCX or paste the text.',
  resume_long:     'Your resume text is too long. Please keep it under 15,000 characters (about 5 pages).',
  jd_long:         'The job description is too long. Please keep it under 6,000 characters.',
  no_ats_credits:  'A Resume ATS report needs 12 AR Credits. Get the ₹99 Resume ATS Pack to continue.',
};

// ---------------------------------------------------------------------
// Owner analytics (privacy-friendly: labels and counts only)
// ---------------------------------------------------------------------
// Topic of an AR question, from keywords. Only this label is stored, never the question.
const TOPICS = [
  ['Disputes & deductions', /disput|deduct|short[- ]?pa|claim|pricing issue|quality issue|rejected/],
  ['Credit & debit memos',  /credit (memo|note)|debit (memo|note)|\bcn\b|\bdn\b/],
  ['Cash application',      /cash app|unapplied|remittance|reconcil|apply (the )?payment|on[- ]account|misapplied/],
  ['Credit review & risk',  /credit (limit|review|risk|check|hold|block)|exposure|bad debt|provision|insolven|nclt/],
  ['Escalation & legal',    /legal|notice|escalat|msme|arbitrat|lawyer|court|section 138|cheque bounce/],
  ['Metrics & reporting',   /\bdso\b|\bcei\b|ageing|aging|kpi|dashboard|report|metric|forecast/],
  ['Process & automation',  /process|automat|\bsop\b|workflow|\bsap\b|oracle|erp|tool|system|portal/],
  ['Team, career & skills', /team|interview|career|resume|cv\b|hire|hiring|train|coach|manager|appraisal/],
  ['Overdue & follow-up',   /overdue|follow[- ]?up|remind|chase|promise|\bptp\b|not pay|delay|pending|outstanding|collect/],
];
export function classifyTopic(text) {
  const t = String(text || '').toLowerCase();
  for (const [name, re] of TOPICS) if (re.test(t)) return name;
  return 'Other';
}

// Events the website may send to /api/track. Anything else is dropped.
const LABEL_SLUG = /^[a-z0-9_-]{1,40}$/;
const LABEL_TEXT = /^[A-Za-z0-9 &(),.–'-]{1,50}$/;
export const TRACK_EVENTS = {
  page_view:     (l) => /^\/[a-z0-9_\-/.]{0,40}$/.test(l),
  section_view:  (l) => LABEL_SLUG.test(l),
  cta:           (l) => LABEL_SLUG.test(l),
  help_need:     (l) => LABEL_SLUG.test(l),
  insight_open:  (l) => LABEL_SLUG.test(l),
  pricing_tab:   (l) => l === 'individual' || l === 'corporate',
  quiz_start:    (l) => LABEL_TEXT.test(l),
  quiz_complete: (l) => LABEL_TEXT.test(l),
  ats_file:      (l) => ['pdf', 'docx', 'txt', 'paste'].includes(l),
};
export function cleanEvents(list) {
  const out = [];
  for (const e of (Array.isArray(list) ? list : []).slice(0, 20)) {
    const m = String(e?.m || ''); const l = String(e?.l ?? '');
    if (TRACK_EVENTS[m] && TRACK_EVENTS[m](l)) out.push({ m, l });
  }
  return out;
}
// Referrer reduced to a site name only (e.g. "linkedin.com"); our own site is ignored.
export function referrerHost(ref, ownHost) {
  try {
    const h = new URL(ref).hostname.toLowerCase().replace(/^www\.|^m\.|^l\.|^lm\./, '');
    if (!h || h === ownHost.replace(/^www\./, '') || !/^[a-z0-9.-]{3,60}$/.test(h)) return null;
    return h;
  } catch { return null; }
}
export function deviceType(ua) {
  ua = String(ua || '');
  if (/bot|crawl|spider|slurp|preview|headless|lighthouse|monitor/i.test(ua)) return 'bot';
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  return /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
}
