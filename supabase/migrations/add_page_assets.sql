create table if not exists public.keyflow_page_assets (
  key text primary key,
  image_data text,
  updated_at timestamptz not null default now()
);

alter table public.keyflow_page_assets enable row level security;

drop policy if exists "keyflow page assets anon select" on public.keyflow_page_assets;
create policy "keyflow page assets anon select"
  on public.keyflow_page_assets for select to anon, authenticated using (true);

drop policy if exists "keyflow page assets anon insert" on public.keyflow_page_assets;
create policy "keyflow page assets anon insert"
  on public.keyflow_page_assets for insert to anon, authenticated with check (true);

drop policy if exists "keyflow page assets anon update" on public.keyflow_page_assets;
create policy "keyflow page assets anon update"
  on public.keyflow_page_assets for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.keyflow_page_assets to anon, authenticated;

insert into public.keyflow_page_assets (key, image_data)
values ('register_banner', null)
on conflict (key) do nothing;
