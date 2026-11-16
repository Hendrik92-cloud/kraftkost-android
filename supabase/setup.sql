-- Kraftkost: gemeinsame Einkaufsliste und Wochenplan für einen Haushalt.
-- Einmal im Supabase-Dashboard unter "SQL Editor" einfügen und ausführen.
-- Zugriff hat nur, wer den geheimen Haushaltscode kennt (er steckt in der Einladung).

create table if not exists public.kk_items (
  id text primary key,
  household text not null,
  name text not null default '',
  amount text not null default '',
  cat text not null default 'Sonstiges',
  done boolean not null default false,
  deleted boolean not null default false,
  updated_at bigint not null default 0
);
create index if not exists kk_items_household on public.kk_items (household);

create table if not exists public.kk_docs (
  household text not null,
  kind text not null,
  data jsonb,
  updated_at bigint not null default 0,
  primary key (household, kind)
);

alter table public.kk_items enable row level security;
alter table public.kk_docs enable row level security;

-- Haushaltscode aus dem Request-Header "x-household"
create or replace function public.kk_household() returns text
language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json ->> 'x-household', '')
$$;

drop policy if exists kk_items_rw on public.kk_items;
create policy kk_items_rw on public.kk_items for all to anon, authenticated
  using (length(household) >= 20 and household = public.kk_household())
  with check (length(household) >= 20 and household = public.kk_household());

drop policy if exists kk_docs_rw on public.kk_docs;
create policy kk_docs_rw on public.kk_docs for all to anon, authenticated
  using (length(household) >= 20 and household = public.kk_household())
  with check (length(household) >= 20 and household = public.kk_household());
