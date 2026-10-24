-- ============================================================
-- NotMozgi — схема Supabase
-- Один файл, можно запускать повторно (idempotent).
-- Supabase Dashboard → SQL Editor → New query → вставить → Run
--
-- Важно: id измерений в приложении — ровно 'ya' / 'study' / 'work'.
-- Старая версия этого файла создавала 'study' / 'personal' / 'projects',
-- из-за чего push заметок с dimension='ya' падал на внешнем ключе (FK).
-- ============================================================

-- ---------- 1. Измерения ----------
create table if not exists public.dimensions (
  id    text primary key,
  name  text not null,
  color text not null default '#d1d5db'
);

insert into public.dimensions (id, name, color) values
  ('ya',    'Я',     '#3b82f6'),
  ('study', 'Учёба', '#8b5cf6'),
  ('work',  'Работа', '#f59e0b')
on conflict (id) do nothing;

-- ---------- 2. Заметки ----------
create table if not exists public.notes (
  id             uuid primary key default gen_random_uuid(),
  title          text not null default '',
  body           text not null default '',
  dimension      text not null default 'ya' references public.dimensions(id),
  estimate_hours numeric not null default 0,
  updated_at     timestamptz not null default now()
);

-- поля v2: закрепление + два формата заметки (текст / холст)
alter table public.notes add column if not exists is_pinned   boolean not null default false;
alter table public.notes add column if not exists note_type   text    not null default 'text';
alter table public.notes add column if not exists canvas_data jsonb;
-- рисунок поверх текста (штрихи стилусом по заметке)
alter table public.notes add column if not exists draw_data  jsonb;
-- мягкое удаление: чтобы удаление расходилось по устройствам, а не терялось
alter table public.notes add column if not exists deleted    boolean not null default false;
alter table public.notes alter column dimension set default 'ya';

-- если раньше запускали «сырую» миграцию, там могли остаться NULL
update public.notes set is_pinned = false where is_pinned is null;
update public.notes set note_type = 'text'  where note_type is null;
alter table public.notes alter column is_pinned set not null;
alter table public.notes alter column note_type set not null;

alter table public.notes drop constraint if exists notes_note_type_check;
alter table public.notes
  add constraint notes_note_type_check check (note_type in ('text', 'canvas'));

-- ---------- 3. События календаря ----------
-- id текстовый и стабильный на всех устройствах (ev...),
-- deleted = soft-delete: удаление расходится синком и не воскресает.
create table if not exists public.events (
  id         text primary key,
  day        date not null,
  title      text not null default '',
  dimension  text references public.dimensions(id) on delete set null,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);

-- закреплённые даты / пин событий
alter table public.events add column if not exists is_pinned boolean not null default false;

-- ---------- 4. Связи между заметками ----------
create table if not exists public.links (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid not null references public.notes(id) on delete cascade,
  to_id      uuid not null references public.notes(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (from_id, to_id)
);

-- ---------- 5. Чанки (auto-chunking) и привычки ----------
create table if not exists public.chunks (
  id      uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  day     date not null,
  hours   numeric not null default 0,
  done    boolean not null default false,
  habit   boolean not null default false,
  unique (note_id, day, habit)
);

-- миграция для баз, созданных до появления habit
alter table public.chunks drop constraint if exists chunks_note_id_day_key;
alter table public.chunks add column if not exists habit boolean not null default false;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.chunks'::regclass
      and conname = 'chunks_note_day_habit_key'
  ) then
    alter table public.chunks
      add constraint chunks_note_day_habit_key unique (note_id, day, habit);
  end if;
end $$;

-- ---------- 6. Пиксели карты ----------
create table if not exists public.pixels (
  x         int not null,
  y         int not null,
  note_id   uuid references public.notes(id) on delete set null,
  opened_at timestamptz not null default now(),
  primary key (x, y)
);

-- ---------- 7. Приводим измерения к трём базовым ----------
-- Сначала переносим ссылки, только потом удаляем лишние (иначе FK не даст).
update public.notes  set dimension = 'ya'
  where dimension is not null and dimension not in ('ya', 'study', 'work');
update public.events set dimension = null
  where dimension is not null and dimension not in ('ya', 'study', 'work');
delete from public.dimensions where id not in ('ya', 'study', 'work');

-- ---------- 8. Индексы ----------
create index if not exists idx_notes_pinned     on public.notes (is_pinned desc, updated_at desc);
create index if not exists idx_notes_dimension  on public.notes (dimension, updated_at desc);
create index if not exists idx_events_day       on public.events (day);
create index if not exists idx_events_pinned    on public.events (is_pinned desc, day);
create index if not exists idx_chunks_note      on public.chunks (note_id, day);

-- ---------- 9. Аккаунты и доступ ----------
-- anon-ключ публичен (он лежит в бандле сайта), поэтому доступ к строкам
-- ограничен владельцем: user_id = auth.uid(). Без входа данные не видны никому,
-- и чужой человек, открывший сайт, увидит только пустое приложение.
alter table public.notes  add column if not exists user_id uuid default auth.uid();
alter table public.events add column if not exists user_id uuid default auth.uid();
alter table public.links  add column if not exists user_id uuid default auth.uid();
alter table public.chunks add column if not exists user_id uuid default auth.uid();
alter table public.pixels add column if not exists user_id uuid default auth.uid();

-- пиксели: ключ теперь (пользователь, x, y)
delete from public.pixels where user_id is null;
alter table public.pixels alter column user_id set not null;
alter table public.pixels drop constraint if exists pixels_pkey;
alter table public.pixels add primary key (user_id, x, y);

alter table public.notes      enable row level security;
alter table public.events     enable row level security;
alter table public.pixels     enable row level security;
alter table public.dimensions enable row level security;
alter table public.links      enable row level security;
alter table public.chunks     enable row level security;

-- старые политики «allow all» больше не нужны
drop policy if exists "allow all" on public.notes;
drop policy if exists "allow all" on public.events;
drop policy if exists "allow all" on public.pixels;
drop policy if exists "allow all" on public.dimensions;
drop policy if exists "allow all" on public.links;
drop policy if exists "allow all" on public.chunks;
drop policy if exists "own notes" on public.notes;
drop policy if exists "own events" on public.events;
drop policy if exists "own pixels" on public.pixels;
drop policy if exists "own links" on public.links;
drop policy if exists "own chunks" on public.chunks;
drop policy if exists "dimensions for signed in" on public.dimensions;

create policy "own notes" on public.notes
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own events" on public.events
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own pixels" on public.pixels
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own links" on public.links
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own chunks" on public.chunks
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- измерения общие (три фиксированные строки), но тоже только для вошедших
create policy "dimensions for signed in" on public.dimensions
  for all to authenticated using (true) with check (true);

-- анонимный доступ закрываем полностью
revoke all on public.notes, public.events, public.links, public.chunks, public.pixels
  from anon;
revoke all on public.dimensions from anon;
grant select, insert, update, delete on public.notes, public.events, public.links,
  public.chunks, public.pixels, public.dimensions to authenticated;

-- ---------- 10. Проверка ----------
-- Должно вернуть 3 измерения и по строке на каждую таблицу.
select 'dimensions' as table_name, count(*) from public.dimensions
union all select 'notes',  count(*) from public.notes
union all select 'events', count(*) from public.events
union all select 'links',  count(*) from public.links
union all select 'chunks', count(*) from public.chunks
union all select 'pixels', count(*) from public.pixels;
