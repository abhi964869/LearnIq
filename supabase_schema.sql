-- ============================================================
-- LearnIQ AI — Supabase schema
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- Each table stores a JSON payload keyed by (user_id, row_key), protected by RLS
-- so every user can read/write ONLY their own rows.
-- ============================================================

create table if not exists public.documents (
  user_id uuid not null references auth.users on delete cascade,
  row_key text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, row_key)
);

create table if not exists public.chats (
  user_id uuid not null references auth.users on delete cascade,
  row_key text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, row_key)
);

create table if not exists public.quizzes (
  user_id uuid not null references auth.users on delete cascade,
  row_key text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, row_key)
);

create table if not exists public.events (
  user_id uuid not null references auth.users on delete cascade,
  row_key text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, row_key)
);

-- Enable row-level security on all tables
alter table public.documents enable row level security;
alter table public.chats     enable row level security;
alter table public.quizzes   enable row level security;
alter table public.events    enable row level security;

-- Policies: a user may only touch rows where user_id = their auth uid.
do $$
declare t text;
begin
  foreach t in array array['documents','chats','quizzes','events'] loop
    execute format('drop policy if exists "own_rows_select" on public.%I;', t);
    execute format('drop policy if exists "own_rows_modify" on public.%I;', t);
    execute format($f$create policy "own_rows_select" on public.%I
                     for select using (auth.uid() = user_id);$f$, t);
    execute format($f$create policy "own_rows_modify" on public.%I
                     for all using (auth.uid() = user_id)
                     with check (auth.uid() = user_id);$f$, t);
  end loop;
end $$;
