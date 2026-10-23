# NotMozgi

Заметки для планшета: текст + холст (схемы стилусом), календарь с быстрыми событиями,
закрепление заметок и дат. Работает офлайн, синхронизируется через Supabase.

Собрано под **Xiaomi Pad 6** и стилус: крупные зоны нажатия, булавка в один тап,
сдвиг вьюпорта под панель Gboard.

---

## Вариант 1 — просто залить папку `site/` (npm не нужен)

В `site/` лежит **готовая сборка**. Никаких `npm install`, никакой сборки:

```
site/
  index.html            приложение
  app.js                весь код одним файлом
  app.css               стили
  config.js             ← сюда ключи Supabase (необязательно)
  manifest.webmanifest  установка на планшет
  sw.js                 офлайн-кэш
  icon-*.png / icon.svg
```

Что делать:

1. Залить содержимое `site/` на любой статический хостинг
   (Cloudflare Pages, Netlify, GitHub Pages, любой nginx).
   Publish directory = `site`.
2. Открыть ссылку на планшете → меню браузера → «Установить приложение».
3. Хочешь синхронизацию — открой `site/config.js` и впиши ключи:

```js
window.__NOT_CONFIG__ = {
  supabaseUrl: 'https://xxxx.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...',
}
```

   Пересборка не нужна: `config.js` читается при загрузке страницы.
   Перед этим один раз выполни `supabase/schema.sql` в SQL Editor.

**Важно:** открывать надо по `http://` или `https://`, а не двойным кликом
(`file://`). В Chrome на `file://` заблокирован IndexedDB — база просто не создастся.
Локально проще всего: `python -m http.server 8000 --directory site`.

**Если поменял исходники в `src/` — обязательно пересобери `site/`**, иначе
`npm run build` задеплоит старую версию. Нужен только node, npm не нужен:

```bash
node node_modules/esbuild/bin/esbuild build/entry.jsx --bundle --minify \
  --format=iife --jsx=automatic --platform=browser --target=es2020 \
  --define:import.meta.env={} --define:process.env='{"NODE_ENV":"production"}' \
  --outfile=site/app.js

node node_modules/@tailwindcss/cli/dist/index.mjs -i src/index.css -o site/app.css --minify
```

После пересборки подними `VERSION` в `site/sw.js`, иначе планшет останется на старом кэше.

---

## Вариант 2 — разработка через Vite

```bash
npm install
npm run dev        # http://<ip-ноутбука>:5173 — открывать с планшета по Wi-Fi
npm run build      # dist/ = копия site/ (то, что уезжает на хостинг)
npm run build:vite # классическая сборка Vite (если нужен её пайплайн)
```

`npm run build` намеренно не запускает Vite: он просто копирует `site/` в `dist/`.
Так деплой на Cloudflare/Netlify отдаёт ровно ту сборку, которая проверена,
и не может упасть из-за нативных бинарников или версии Node в CI.

Ключи Supabase для этого варианта — в `.env` (см. `.env.example`).
Без ключей приложение работает полностью локально.

---

## Supabase

1. Создай проект.
2. SQL Editor → вставь целиком `supabase/schema.sql` → Run.
   Файл идемпотентный, его можно запускать повторно на существующей базе.
3. Ключи — в `.env` (Vite) или в `site/config.js` (готовая сборка).

Если в облаке осталась старая схема (без `is_pinned` / `note_type` / `canvas_data`),
синк не падает: работает с базовыми полями и пишет подсказку в журнал
(вкладка «Диагностика»).

| Локально (Dexie) | Облако (Supabase) |
| --- | --- |
| `notes` (+ `is_pinned`, `note_type`, `canvas_data`) | `notes` |
| `events` (+ `is_pinned`) | `events` |
| `dimensions`, `links`, `chunks`, `pixels` | те же таблицы |
| `settings` | только локально |

Конфликты решаются по содержимому: побеждает сторона, которую меняли последней,
локальная правка никогда не затирается молча.

## Структура

```
src/
  App.jsx                    приложение: список, редактор, календарь, граф, карта
  lib/db.js                  Dexie: схема v1–v5, пиннинг, события, сиды
  lib/supabase.js            двусторонний синк + деградация на старой схеме
  lib/chunks.js              авто-чанкинг (оценка часов / дни до дедлайна)
  lib/dates.js               парсинг «дедлайн: 30.09», «завтра», «в пятницу»
  lib/notify.js              локальные напоминания
  components/CanvasBoard.jsx холст: маркер, ластик, блоки, стрелки, текст
  components/NoteCard.jsx    карточка с булавкой
  components/EventModal.jsx  быстрое событие на день (+ пин даты)
build/                       точка входа и CSS для сборки site/
site/                        ГОТОВОЕ приложение (заливать это)
supabase/schema.sql          схема БД (идемпотентная)
```

## Данные

Всё лежит в IndexedDB, база `not-dark-os`. `is_pinned` хранится как `0/1`, а не `boolean`:
IndexedDB не умеет индексировать boolean, и запись с `true` в индексируемом поле ломает таблицу.

Миграция со старой версии автоматическая (Dexie v4 → v5): существующие заметки получают
`is_pinned = 0`, `note_type = 'text'`, ничего не удаляется.

## Полезное

- **Дедлайн из текста**: `дедлайн: 30.09`, `завтра`, `в пятницу` → появляется в календаре.
- **Оценка**: `оценка: 6ч` → кнопка «Разбить на чанки» раскидывает часы по дням.
- **Привычка**: слово «ежедневно» → чекбокс на каждый день.
- **Связи**: `[[Название заметки]]` в тексте или ручная связь в редакторе.
- **Холст**: заметка → тип «🎨 Доска». Двумя пальцами — масштаб, «✋» — двигать.
- **Supabase free tier засыпает** после ~7 дней без запросов — в `.github/workflows/`
  лежит keep-alive пинг (секреты `SUPABASE_URL`, `SUPABASE_ANON_KEY`).

## Папка `legacy/`

Нерабочая предыдущая «v2»-попытка (`App_v2.jsx`, `db_v2*.js`, `CanvasNoteEditor.jsx`,
`schema_v2_final.sql`) и старые доки. В сборке не участвует, в `.gitignore`.
Можно удалить целиком.
