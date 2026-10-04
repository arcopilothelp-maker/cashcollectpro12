-- =====================================================================
-- CashCollect Pro – database schema (Supabase / PostgreSQL)
-- Run once in Supabase: Dashboard > SQL Editor > New query > paste > Run
--
-- Security model
--  * Row Level Security (RLS) is ON for every table.
--  * Browsers (anon / authenticated roles) can only READ their own
--    profile, usage and payments. They can never write anything.
--  * All writes (credits, budgets, payments) happen ONLY inside the
--    functions below, which only the server (service_role) may execute.
--  * Phone numbers are stored only as a keyed hash (HMAC), never in clear
--    text, in our own tables.
--  * Question and answer text is NOT stored – only usage metadata.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  free_credits  integer not null default 0 check (free_credits >= 0),
  paid_credits  integer not null default 0 check (paid_credits >= 0),
  is_blocked    boolean not null default false,
  created_at    timestamptz not null default now()
);

-- One free grant per verified phone number, ever.
create table if not exists public.free_grants (
  phone_hash   text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  ip_hash      text,
  device_hash  text,
  granted_at   timestamptz not null default now()
);
create index if not exists free_grants_ip_idx     on public.free_grants (ip_hash, granted_at);
create index if not exists free_grants_device_idx on public.free_grants (device_hash, granted_at);

-- Usage log: metadata only (no question / answer text).
create table if not exists public.usage_log (
  id               bigserial primary key,
  user_id          uuid not null references auth.users(id) on delete cascade,
  mode             text not null,
  model            text,
  is_free          boolean not null default false,
  credits_charged  integer not null default 0,
  reserved_paise   integer not null default 0,
  cost_paise       integer,
  input_tokens     integer,
  output_tokens    integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  status           text not null default 'reserved'
                   check (status in ('reserved','done','failed')),
  created_at       timestamptz not null default now()
);
create index if not exists usage_log_user_time_idx on public.usage_log (user_id, created_at);
create index if not exists usage_log_time_idx      on public.usage_log (created_at);
-- Topic label only (e.g. 'Disputes & deductions'), worked out by the server. Never the question text.
alter table public.usage_log add column if not exists topic text;

-- Website footprint: daily COUNTS only. No cookies, no IP addresses, no personal data.
create table if not exists public.daily_stats (
  day     date   not null,
  metric  text   not null,          -- e.g. page_view, section_view, cta, quiz_start, referrer, country
  label   text   not null default '',
  count   bigint not null default 0,
  primary key (day, metric, label)
);
-- Unique-visitor counting: a keyed hash that changes every day (cannot be traced back to a person).
create table if not exists public.visitor_days (
  day           date not null,
  visitor_hash  text not null,
  events        int  not null default 0,
  primary key (day, visitor_hash)
);

-- Payments (Razorpay). Amount and credits are always set by the server.
create table if not exists public.payments (
  id                    bigserial primary key,
  user_id               uuid not null references auth.users(id) on delete cascade,
  pack                  text not null,
  amount_paise          integer not null check (amount_paise > 0),
  credits               integer not null check (credits > 0),
  razorpay_order_id     text not null unique,
  razorpay_payment_id   text unique,
  status                text not null default 'created'
                        check (status in ('created','paid','failed')),
  created_at            timestamptz not null default now(),
  paid_at               timestamptz
);

-- Spend counters for the free-question budget (day and hour buckets).
create table if not exists public.budget_counters (
  bucket       text primary key,          -- e.g. 'day:2026-10-03', 'hour:2026-10-03T10'
  spent_paise  bigint not null default 0,
  alerted      boolean not null default false,
  updated_at   timestamptz not null default now()
);

-- Admin-controlled settings (kill switch, budgets, limits).
create table if not exists public.settings (
  key    text primary key,
  value  jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.settings (key, value) values
  ('free_enabled',               'true'),
  ('paid_enabled',               'true'),
  ('free_questions_per_phone',   '3'),
  ('daily_free_budget_paise',    '50000'),   -- ₹500 per day for ALL free users
  ('hourly_free_budget_paise',   '5000'),    -- ₹50 per hour
  ('max_grants_per_ip_per_day',  '2'),
  ('max_grants_per_device_per_day','2'),
  ('max_questions_per_minute',   '6'),
  ('max_questions_per_day',      '100')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 2. Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.free_grants     enable row level security;
alter table public.daily_stats     enable row level security;
alter table public.visitor_days    enable row level security;
alter table public.usage_log       enable row level security;
alter table public.payments        enable row level security;
alter table public.budget_counters enable row level security;
alter table public.settings        enable row level security;

-- Users may read ONLY their own rows. No insert/update/delete policies
-- exist for browser roles, so all browser writes are denied.
drop policy if exists "own profile"  on public.profiles;
create policy "own profile"  on public.profiles  for select to authenticated using (user_id = auth.uid());
drop policy if exists "own usage"    on public.usage_log;
create policy "own usage"    on public.usage_log for select to authenticated using (user_id = auth.uid());
drop policy if exists "own payments" on public.payments;
create policy "own payments" on public.payments  for select to authenticated using (user_id = auth.uid());
-- free_grants, budget_counters, settings: no policies => no browser access at all.

-- Belt and braces: remove direct write privileges from browser roles.
revoke insert, update, delete on all tables in schema public from anon, authenticated;
revoke all on public.free_grants, public.budget_counters, public.settings, public.daily_stats, public.visitor_days from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. New user => empty profile (0 credits until phone is verified)
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper to read an integer / boolean setting
create or replace function public.setting_int(p_key text) returns bigint
language sql stable set search_path = public as $$
  select (value #>> '{}')::bigint from public.settings where key = p_key
$$;
create or replace function public.setting_bool(p_key text) returns boolean
language sql stable set search_path = public as $$
  select coalesce((value #>> '{}')::boolean, false) from public.settings where key = p_key
$$;

-- ---------------------------------------------------------------------
-- 4. Claim free questions (once per verified phone)
-- ---------------------------------------------------------------------
create or replace function public.claim_free_grant(
  p_user uuid, p_phone_hash text, p_ip_hash text, p_device_hash text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_ip_count int; v_dev_count int; v_blocked boolean;
begin
  if not setting_bool('free_enabled') then return 'free_disabled'; end if;

  select is_blocked into v_blocked from profiles where user_id = p_user for update;
  if v_blocked is null then return 'no_profile'; end if;
  if v_blocked then return 'blocked'; end if;

  if exists (select 1 from free_grants where user_id = p_user) then return 'already_claimed'; end if;
  if exists (select 1 from free_grants where phone_hash = p_phone_hash) then return 'phone_used'; end if;

  select count(*) into v_ip_count from free_grants
   where ip_hash = p_ip_hash and granted_at > now() - interval '1 day';
  if v_ip_count >= setting_int('max_grants_per_ip_per_day') then return 'ip_limit'; end if;

  select count(*) into v_dev_count from free_grants
   where device_hash = p_device_hash and granted_at > now() - interval '1 day';
  if v_dev_count >= setting_int('max_grants_per_device_per_day') then return 'device_limit'; end if;

  insert into free_grants (phone_hash, user_id, ip_hash, device_hash)
  values (p_phone_hash, p_user, p_ip_hash, p_device_hash);

  update profiles set free_credits = free_credits + setting_int('free_questions_per_phone')::int
   where user_id = p_user;
  return 'ok';
exception when unique_violation then
  return 'phone_used';
end $$;

-- ---------------------------------------------------------------------
-- 5. Reserve credits (and free budget) BEFORE calling the AI
--    Atomic: locks the profile row; budget check-and-increment in one step.
-- ---------------------------------------------------------------------
drop function if exists public.reserve_usage(uuid, text, text, int, boolean, int, text, text);
create or replace function public.reserve_usage(
  p_user uuid, p_mode text, p_model text, p_credits int, p_is_free boolean,
  p_max_cost_paise int, p_day_bucket text, p_hour_bucket text, p_topic text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prof profiles%rowtype; v_min int; v_day int; v_id bigint;
  v_day_spent bigint; v_hour_spent bigint;
begin
  select * into v_prof from profiles where user_id = p_user for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_profile'); end if;
  if v_prof.is_blocked then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;

  -- per-user rate limits
  select count(*) into v_min from usage_log where user_id = p_user and created_at > now() - interval '1 minute';
  if v_min >= setting_int('max_questions_per_minute') then
    return jsonb_build_object('ok', false, 'reason', 'rate_minute'); end if;
  select count(*) into v_day from usage_log where user_id = p_user and created_at > now() - interval '1 day';
  if v_day >= setting_int('max_questions_per_day') then
    return jsonb_build_object('ok', false, 'reason', 'rate_day'); end if;

  if p_is_free then
    if not setting_bool('free_enabled') then
      return jsonb_build_object('ok', false, 'reason', 'free_disabled'); end if;
    if v_prof.free_credits < p_credits then
      return jsonb_build_object('ok', false, 'reason', 'no_free_credits'); end if;

    -- global day budget: increment only if it stays within the limit
    insert into budget_counters (bucket, spent_paise) values (p_day_bucket, 0) on conflict do nothing;
    update budget_counters set spent_paise = spent_paise + p_max_cost_paise, updated_at = now()
     where bucket = p_day_bucket
       and spent_paise + p_max_cost_paise <= setting_int('daily_free_budget_paise')
     returning spent_paise into v_day_spent;
    if v_day_spent is null then
      return jsonb_build_object('ok', false, 'reason', 'free_budget_day'); end if;

    insert into budget_counters (bucket, spent_paise) values (p_hour_bucket, 0) on conflict do nothing;
    update budget_counters set spent_paise = spent_paise + p_max_cost_paise, updated_at = now()
     where bucket = p_hour_bucket
       and spent_paise + p_max_cost_paise <= setting_int('hourly_free_budget_paise')
     returning spent_paise into v_hour_spent;
    if v_hour_spent is null then
      -- undo the day increment (whole function is one transaction, but be explicit)
      update budget_counters set spent_paise = spent_paise - p_max_cost_paise where bucket = p_day_bucket;
      return jsonb_build_object('ok', false, 'reason', 'free_budget_hour'); end if;

    update profiles set free_credits = free_credits - p_credits where user_id = p_user;
  else
    if not setting_bool('paid_enabled') then
      return jsonb_build_object('ok', false, 'reason', 'paid_disabled'); end if;
    if v_prof.paid_credits < p_credits then
      return jsonb_build_object('ok', false, 'reason', 'no_paid_credits'); end if;
    update profiles set paid_credits = paid_credits - p_credits where user_id = p_user;
  end if;

  insert into usage_log (user_id, mode, model, is_free, credits_charged, reserved_paise, topic)
  values (p_user, p_mode, p_model, p_is_free, p_credits, p_max_cost_paise, left(p_topic, 40))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'usage_id', v_id,
                            'day_spent_paise', coalesce(v_day_spent, 0),
                            'day_budget_paise', setting_int('daily_free_budget_paise'));
end $$;

-- ---------------------------------------------------------------------
-- 6. Finalise after the AI call: record real cost, refund on failure
-- ---------------------------------------------------------------------
create or replace function public.finalize_usage(
  p_usage_id bigint, p_success boolean, p_cost_paise int,
  p_input int, p_output int, p_cache_read int, p_cache_write int,
  p_day_bucket text, p_hour_bucket text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_row usage_log%rowtype; v_delta int;
begin
  select * into v_row from usage_log where id = p_usage_id for update;
  if not found or v_row.status <> 'reserved' then return; end if;

  if p_success then
    update usage_log set status = 'done', cost_paise = p_cost_paise,
           input_tokens = p_input, output_tokens = p_output,
           cache_read_tokens = p_cache_read, cache_write_tokens = p_cache_write
     where id = p_usage_id;
    if v_row.is_free then
      -- replace the reserved (maximum) cost with the real cost
      v_delta := p_cost_paise - v_row.reserved_paise;
      update budget_counters set spent_paise = greatest(0, spent_paise + v_delta)
       where bucket in (p_day_bucket, p_hour_bucket);
    end if;
  else
    -- credits are refunded, but any real AI cost (e.g. an unusable reply) is still recorded
    update usage_log set status = 'failed', cost_paise = coalesce(p_cost_paise, 0),
           input_tokens = p_input, output_tokens = p_output,
           cache_read_tokens = p_cache_read, cache_write_tokens = p_cache_write
     where id = p_usage_id;
    if v_row.is_free then
      update profiles set free_credits = free_credits + v_row.credits_charged where user_id = v_row.user_id;
      update budget_counters set spent_paise = greatest(0, spent_paise - v_row.reserved_paise)
       where bucket in (p_day_bucket, p_hour_bucket);
    else
      update profiles set paid_credits = paid_credits + v_row.credits_charged where user_id = v_row.user_id;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. Payments
-- ---------------------------------------------------------------------
create or replace function public.create_payment_order(
  p_user uuid, p_pack text, p_amount int, p_credits int, p_order_id text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into payments (user_id, pack, amount_paise, credits, razorpay_order_id)
  values (p_user, p_pack, p_amount, p_credits, p_order_id);
end $$;

-- Idempotent: crediting the same order twice is impossible.
create or replace function public.credit_payment(
  p_order_id text, p_payment_id text, p_amount int
) returns text
language plpgsql security definer set search_path = public as $$
declare v_pay payments%rowtype;
begin
  select * into v_pay from payments where razorpay_order_id = p_order_id for update;
  if not found then return 'unknown_order'; end if;
  if v_pay.status = 'paid' then return 'already_paid'; end if;
  if p_amount is not null and p_amount <> v_pay.amount_paise then return 'amount_mismatch'; end if;

  update payments set status = 'paid', razorpay_payment_id = p_payment_id, paid_at = now()
   where id = v_pay.id;
  update profiles set paid_credits = paid_credits + v_pay.credits where user_id = v_pay.user_id;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------
-- 8. Admin metrics and alert flag
-- ---------------------------------------------------------------------
create or replace function public.admin_metrics(p_day_bucket text) returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'users_total',        (select count(*) from profiles),
    'users_today',        (select count(*) from profiles where created_at > now() - interval '1 day'),
    'free_grants_today',  (select count(*) from free_grants where granted_at > now() - interval '1 day'),
    'free_spent_today_paise', coalesce((select spent_paise from budget_counters where bucket = p_day_bucket), 0),
    'questions_today',    (select count(*) from usage_log where created_at > now() - interval '1 day'),
    'ats_reports_30d',    (select count(*) from usage_log where mode = 'ats' and status = 'done' and created_at > now() - interval '30 days'),
    'ai_cost_30d_paise',  coalesce((select sum(cost_paise) from usage_log where status in ('done','failed') and created_at > now() - interval '30 days'), 0),
    'revenue_30d_paise',  coalesce((select sum(amount_paise) from payments where status='paid' and paid_at > now() - interval '30 days'), 0),
    'paying_users_30d',   (select count(distinct user_id) from payments where status='paid' and paid_at > now() - interval '30 days'),
    'settings',           (select jsonb_object_agg(key, value) from settings)
  )
$$;

create or replace function public.mark_alerted(p_bucket text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v boolean;
begin
  update budget_counters set alerted = true where bucket = p_bucket and alerted = false
  returning true into v;
  return coalesce(v, false);
end $$;

-- ---------------------------------------------------------------------
-- 8b. Website footprint counters (called by the server for /api/track)
--     p_events: [{"m":"page_view","l":"/"}, ...]  (already validated by the server)
--     Each visitor can add at most 300 events a day, so spam can't inflate numbers much.
-- ---------------------------------------------------------------------
create or replace function public.track_events(p_day date, p_visitor text, p_events jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_new boolean; v_events int; e jsonb; n int;
begin
  n := least(jsonb_array_length(coalesce(p_events, '[]'::jsonb)), 20);
  if n = 0 then return; end if;
  insert into visitor_days (day, visitor_hash, events) values (p_day, p_visitor, 0)
    on conflict do nothing;
  v_new := found;
  update visitor_days set events = events + n where day = p_day and visitor_hash = p_visitor
    returning events into v_events;
  if v_events > 300 then return; end if;
  if v_new then
    insert into daily_stats (day, metric, label, count) values (p_day, 'visitors', '', 1)
      on conflict (day, metric, label) do update set count = daily_stats.count + 1;
  end if;
  for e in select * from jsonb_array_elements(p_events) limit 20 loop
    insert into daily_stats (day, metric, label, count)
    values (p_day, left(e->>'m', 30), left(coalesce(e->>'l', ''), 60), 1)
      on conflict (day, metric, label) do update set count = daily_stats.count + 1;
  end loop;
  -- housekeeping: visitor hashes are only needed for today
  delete from visitor_days where day < p_day - 2;
end $$;

-- ---------------------------------------------------------------------
-- 8c. Owner dashboard: everything the admin page shows, for the last p_days days
-- ---------------------------------------------------------------------
create or replace function public.admin_dashboard(p_days int) returns jsonb
language sql security definer set search_path = public as $$
  with r as (select greatest(1, least(coalesce(p_days, 30), 365)) as d),
  since as (select (now() at time zone 'Asia/Kolkata')::date - (select d from r) + 1 as day),
  days as (select generate_series((select day from since), (now() at time zone 'Asia/Kolkata')::date, interval '1 day')::date as day),
  st as (select metric, label, sum(count)::bigint as n from daily_stats where day >= (select day from since) group by 1, 2),
  pay as (select * from payments where status = 'paid' and paid_at >= (select day from since)),
  use as (select * from usage_log where status = 'done' and created_at >= (select day from since))
  select jsonb_build_object(
    'days', (select d from r),
    'kpi', jsonb_build_object(
      'visitors',      coalesce((select n from st where metric = 'visitors'), 0),
      'page_views',    coalesce((select sum(n) from st where metric = 'page_view'), 0),
      'signups',       (select count(*) from profiles where created_at >= (select day from since)),
      'buyers',        (select count(distinct user_id) from pay),
      'orders',        (select count(*) from pay),
      'revenue_paise', coalesce((select sum(amount_paise) from pay), 0),
      'ai_cost_paise', coalesce((select sum(cost_paise) from usage_log where status in ('done','failed') and created_at >= (select day from since)), 0),
      'ai_requests',   (select count(*) from use),
      'ats_reports',   (select count(*) from use where mode = 'ats'),
      'quiz_rounds',   coalesce((select sum(n) from st where metric = 'quiz_start'), 0),
      'enquiry_clicks',coalesce((select sum(n) from st where metric = 'cta' and label in ('whatsapp','email','linkedin')), 0)
    ),
    'series', (select jsonb_agg(jsonb_build_object(
        'day', d.day,
        'visitors', coalesce((select count from daily_stats s where s.day = d.day and s.metric = 'visitors' and s.label = ''), 0),
        'revenue_paise', coalesce((select sum(amount_paise) from pay where (paid_at at time zone 'Asia/Kolkata')::date = d.day), 0),
        'orders', (select count(*) from pay where (paid_at at time zone 'Asia/Kolkata')::date = d.day)
      ) order by d.day) from days d),
    'sales_by_pack', coalesce((select jsonb_agg(x order by x->>'revenue_paise' desc) from (
        select jsonb_build_object('pack', pack, 'orders', count(*), 'buyers', count(distinct user_id), 'revenue_paise', sum(amount_paise)) x
        from pay group by pack) t), '[]'),
    'usage_by_mode', coalesce((select jsonb_object_agg(mode, n) from (select mode, count(*) n from use group by mode) t), '{}'),
    'ar_topics',     coalesce((select jsonb_object_agg(coalesce(topic, 'Other'), n) from (select topic, count(*) n from use where mode <> 'ats' group by topic) t), '{}'),
    'stats',         coalesce((select jsonb_object_agg(metric, labels) from (
        select metric, jsonb_object_agg(label, n) labels from st where metric <> 'visitors' group by metric) t), '{}'),
    'recent_payments', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('at', p.paid_at, 'pack', p.pack, 'amount_paise', p.amount_paise, 'credits', p.credits,
               'email', u.email) x
        from payments p left join auth.users u on u.id = p.user_id
        where p.status = 'paid' order by p.paid_at desc limit 15) t), '[]')
  )
$$;

-- ---------------------------------------------------------------------
-- 9. Only the server (service_role) may run the functions above
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on function
  public.claim_free_grant(uuid, text, text, text),
  public.reserve_usage(uuid, text, text, int, boolean, int, text, text, text),
  public.track_events(date, text, jsonb),
  public.admin_dashboard(int),
  public.finalize_usage(bigint, boolean, int, int, int, int, int, text, text),
  public.create_payment_order(uuid, text, int, int, text),
  public.credit_payment(text, text, int),
  public.admin_metrics(text),
  public.mark_alerted(text)
to service_role;
