-- Earmark database schema

create table if not exists public.articles (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  author text default '',
  text text not null,
  source text default '',
  url text default '',
  added_at bigint not null,
  finished boolean default false,
  created_at timestamptz default now()
);


create index if not exists articles_user_added_idx
  on public.articles (user_id, added_at desc);

alter table public.articles enable row level security;

drop policy if exists "articles_select_own" on public.articles;
create policy "articles_select_own" on public.articles
  for select using (auth.uid() = user_id);

drop policy if exists "articles_insert_own" on public.articles;
create policy "articles_insert_own" on public.articles
  for insert with check (auth.uid() = user_id);

drop policy if exists "articles_update_own" on public.articles;
create policy "articles_update_own" on public.articles
  for update using (auth.uid() = user_id);

drop policy if exists "articles_delete_own" on public.articles;
create policy "articles_delete_own" on public.articles
  for delete using (auth.uid() = user_id);
