-- Aura Teams: таблица задач канбан-доски и Realtime-публикация.
-- Применить в SQL Editor Supabase (или psql к self-hosted инстансу) один раз на базу.
-- В Aura IDE затем задать auraTeams.supabase.url и auraTeams.supabase.anonKey.

create table if not exists public.aura_tasks (
	id          text primary key,
	project     text        not null,
	title       text        not null,
	description text        not null default '',
	status      text        not null default 'backlog'
		check (status in ('backlog', 'inProgress', 'review', 'done')),
	priority    text        not null default 'medium'
		check (priority in ('high', 'medium', 'low')),
	assignee    text,
	branch      text,
	sort_order  integer     not null default 0,
	created_at  timestamptz not null default now(),
	updated_at  timestamptz not null default now()
);

create index if not exists aura_tasks_project_idx on public.aura_tasks (project, status, sort_order);

-- Realtime: события INSERT/UPDATE/DELETE уходят подписчикам канала realtime:aura:<project>.
-- DELETE несёт old_record только при replica identity full.
alter table public.aura_tasks replica identity full;

do $$
begin
	if not exists (
		select 1 from pg_publication_tables
		where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aura_tasks'
	) then
		alter publication supabase_realtime add table public.aura_tasks;
	end if;
end $$;

-- RLS: anon-ключ ходит в таблицу напрямую, поэтому доступ ограничен политиками.
-- Стартовая политика — «все участники с ключом видят и правят все доски». Когда появится
-- авторизация (auth.uid()), замените её на политику по членству в проекте.
alter table public.aura_tasks enable row level security;

drop policy if exists aura_tasks_team_all on public.aura_tasks;
create policy aura_tasks_team_all on public.aura_tasks
	for all
	to anon, authenticated
	using (true)
	with check (true);

-- updated_at всегда ставит сервер, чтобы часы клиентов не ломали разрешение конфликтов.
create or replace function public.aura_tasks_touch_updated_at()
returns trigger language plpgsql as $$
begin
	if new.updated_at is null or new.updated_at < old.updated_at then
		new.updated_at := now();
	end if;
	return new;
end $$;

drop trigger if exists aura_tasks_touch on public.aura_tasks;
create trigger aura_tasks_touch
	before update on public.aura_tasks
	for each row execute function public.aura_tasks_touch_updated_at();
