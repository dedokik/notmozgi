import Dexie from 'dexie'

// Единственная база приложения. Имя оставлено прежним ('not-dark-os'),
// чтобы уже существующие заметки не потерялись при обновлении.
export const DIMENSIONS = [
  { id: 'ya', name: 'Я', color: '#3b82f6' },
  { id: 'study', name: 'Учёба', color: '#8b5cf6' },
  { id: 'work', name: 'Работа', color: '#f59e0b' },
]

export const MAP_W = 100
export const MAP_H = 50

export const db = new Dexie('not-dark-os')

// ВАЖНО: is_pinned хранится числом 0/1, а НЕ boolean.
// IndexedDB не умеет индексировать boolean: запись с true в индексируемом
// поле отваливается с DataError, и таблица перестаёт открываться.
// Число 0/1 и индексируется нормально, и работает в проверках `if (note.is_pinned)`.

db.version(1).stores({
  notes: '++id, dimension, updatedAt',
  settings: 'key',
})

db.version(2).stores({
  notes: '++id, dimension, updatedAt',
  settings: 'key',
  links: '++id, fromId, toId',
  chunks: '++id, noteId, date, done',
  pixels: '[x+y], noteId, openedAt',
})

db.version(3).stores({
  notes: '++id, dimension, updatedAt',
  settings: 'key',
  links: '++id, fromId, toId',
  chunks: '++id, noteId, date, done',
  pixels: '[x+y], noteId, openedAt',
  dimensions: 'id',
})

db.version(4).stores({
  notes: '++id, dimension, updatedAt',
  settings: 'key',
  links: '++id, fromId, toId',
  chunks: '++id, noteId, date, done',
  pixels: '[x+y], noteId, openedAt',
  dimensions: 'id',
  events: 'id, date',
})

// v5: закрепление заметок и событий + два формата заметки (текст / холст).
// upgrade() доводит старые записи до нового вида, ничего не удаляя.
db.version(5)
  .stores({
    notes: '++id, dimension, updatedAt, is_pinned, note_type',
    settings: 'key',
    links: '++id, fromId, toId',
    chunks: '++id, noteId, date, done',
    pixels: '[x+y], noteId, openedAt',
    dimensions: 'id',
    events: 'id, date, is_pinned',
  })
  .upgrade(async (tx) => {
    await tx.table('notes').toCollection().modify((n) => {
      n.is_pinned = n.is_pinned ? 1 : 0
      if (n.note_type !== 'canvas') n.note_type = 'text'
      if (typeof n.updatedAt === 'string') n.updatedAt = Date.parse(n.updatedAt) || Date.now()
      if (typeof n.updatedAt !== 'number' || !isFinite(n.updatedAt)) n.updatedAt = Date.now()
      if (typeof n.estimateHours !== 'number') n.estimateHours = Number(n.estimateHours) || 0
    })
    await tx.table('events').toCollection().modify((e) => {
      e.is_pinned = e.is_pinned ? 1 : 0
      if (typeof e.deleted === 'undefined') e.deleted = 0
      if (typeof e.updatedAt !== 'number') e.updatedAt = Date.now()
    })
  })

// === НОРМАЛИЗАЦИЯ ===

export const nowTs = () => Date.now()

export const isPinned = (n) => !!(n && n.is_pinned)

// Сортировка по требованию: закреплённые сверху, дальше — свежие.
export function sortNotes(list) {
  return list.sort(
    (a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0)
  )
}

export function normalizeNote(n) {
  if (!n) return n
  return {
    ...n,
    is_pinned: n.is_pinned ? 1 : 0,
    deleted: n.deleted ? 1 : 0,
    note_type: n.note_type === 'canvas' ? 'canvas' : 'text',
    updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : Date.parse(n.updatedAt) || 0,
    estimateHours: Number(n.estimateHours) || 0,
  }
}

// === ЗАМЕТКИ ===

export async function listNotes() {
  const all = await db.notes.toArray()
  return sortNotes(all.map(normalizeNote).filter((n) => !n.deleted))
}

// все заметки, включая удалённые (для синка и пересчёта плана)
export async function allNotesRaw() {
  return db.notes.toArray()
}

export async function getPinnedNotes() {
  const all = await listNotes()
  return all.filter((n) => n.is_pinned)
}

export async function createNote({ title = 'Новая заметка', body = '', dimension, note_type = 'text' } = {}) {
  const dims = await db.dimensions.toArray()
  const dim = dimension || dims[0]?.id || 'ya'
  const row = {
    title,
    body,
    dimension: dim,
    estimateHours: 0,
    is_pinned: 0,
    deleted: 0,
    note_type,
    canvas_data: note_type === 'canvas' ? emptyCanvas() : null,
    draw_data: null,
    updatedAt: nowTs(),
  }
  return db.notes.add(row)
}

export async function updateNote(id, patch) {
  const next = { ...patch }
  if (next.updatedAt === undefined) next.updatedAt = nowTs()
  if (next.is_pinned !== undefined) next.is_pinned = next.is_pinned ? 1 : 0
  await db.notes.update(id, next)
  return db.notes.get(id)
}

// Возвращает новое состояние флага (0/1), чтобы UI не гадал.
export async function togglePin(id) {
  const note = await db.notes.get(id)
  if (!note) return null
  const next = note.is_pinned ? 0 : 1
  await db.notes.update(id, { is_pinned: next, updatedAt: nowTs() })
  return next
}

// Мягкое удаление: ставим deleted=1 вместо физического удаления строки.
// Иначе удаление не уезжает на другое устройство (и теряется, если в момент
// удаления не было сети) — облако просто не знает, что заметку убрали.
export async function deleteNoteDeep(id) {
  await db.transaction('rw', [db.notes, db.links, db.chunks, db.pixels], async () => {
    await db.notes.update(id, { deleted: 1, is_pinned: 0, updatedAt: nowTs() })
    await db.links.where('fromId').equals(id).delete()
    await db.links.where('toId').equals(id).delete()
    await db.chunks.where('noteId').equals(id).delete()
    // пиксели оставляем: карта — след истории, но ссылку на заметку убираем
    await db.pixels.where('noteId').equals(id).modify({ noteId: null })
  })
}

export function emptyCanvas() {
  return { version: 1, elements: [] }
}

// === СОБЫТИЯ КАЛЕНДАРЯ ===

export async function addEvent({ date, title, dimension = null, is_pinned = 0 }) {
  const id = `ev${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
  await db.events.add({
    id,
    date,
    title: title || '',
    dimension: dimension || null,
    is_pinned: is_pinned ? 1 : 0,
    deleted: 0,
    updatedAt: nowTs(),
  })
  return id
}

export async function toggleEventPin(id) {
  const ev = await db.events.get(id)
  if (!ev) return null
  const next = ev.is_pinned ? 0 : 1
  await db.events.update(id, { is_pinned: next, updatedAt: nowTs() })
  return next
}

// soft-delete: флаг расходится синком, поэтому событие не воскресает
export async function deleteEvent(id) {
  await db.events.update(id, { deleted: 1, updatedAt: nowTs() })
}

// === СИДЫ ===

export async function seedDimensions() {
  const count = await db.dimensions.count()
  if (count > 0) return
  await db.dimensions.bulkAdd(DIMENSIONS.map((d) => ({ ...d })))
}

// Приводит набор измерений к трём базовым (Я, Учёба, Работа).
export async function normalizeDimensions() {
  const baseIds = DIMENSIONS.map((d) => d.id)
  const all = await db.dimensions.toArray()
  const extra = all.filter((d) => !baseIds.includes(d.id))
  const fallback = DIMENSIONS[0].id

  if (extra.length) {
    await db.transaction('rw', [db.notes, db.events, db.dimensions], async () => {
      for (const d of extra) {
        await db.notes.where('dimension').equals(d.id).modify({ dimension: fallback, updatedAt: nowTs() })
        // у events нет индекса по dimension — фильтруем по коллекции
        await db.events
          .filter((e) => e.dimension === d.id)
          .modify({ dimension: fallback })
        await db.dimensions.delete(d.id)
      }
    })
  }

  for (const d of DIMENSIONS) {
    const ex = await db.dimensions.get(d.id)
    if (!ex) await db.dimensions.add({ ...d })
  }
  return extra.length
}

export async function seedIfEmpty() {
  const count = await db.notes.count()
  if (count > 0) return
  const now = nowTs()
  await db.notes.bulkAdd([
    {
      title: 'Добро пожаловать',
      body: '# Привет\n\nЭто Not: заметки + холст + календарь + граф + карта.\n\n- [ ] Создать заметку в измерении Учёба\n- [ ] Написать `дедлайн: 30.09` и `оценка: 6ч` в тексте\n- [x] Открыть календарь\n\nСвязь с релизом: [[MVP релиз]]\n\nдедлайн: 30.09',
      dimension: 'ya',
      estimateHours: 6,
      is_pinned: 1,
      note_type: 'text',
      canvas_data: null,
      updatedAt: now,
    },
    {
      title: 'Купить продукты',
      body: '## Список\n\n- [ ] Молоко\n- [ ] Хлеб\n\nдедлайн: 26.09',
      dimension: 'study',
      estimateHours: 1,
      is_pinned: 0,
      note_type: 'text',
      canvas_data: null,
      updatedAt: now,
    },
    {
      title: 'MVP релиз',
      body: '# Проекты\n\nДоделать каркас и показать на планшете по Wi-Fi.\n\n**дедлайн: 28.09**',
      dimension: 'work',
      estimateHours: 4,
      is_pinned: 0,
      note_type: 'text',
      canvas_data: null,
      updatedAt: now,
    },
    {
      title: 'Схема: как всё устроено',
      body: 'Холст: рисуй стилусом схемы, стрелки и обводки.',
      dimension: 'study',
      estimateHours: 0,
      is_pinned: 0,
      note_type: 'canvas',
      canvas_data: {
        version: 1,
        elements: [
          { id: 's1', type: 'rect', x: 60, y: 60, w: 170, h: 80, color: '#3b82f6', width: 3 },
          { id: 't1', type: 'text', x: 82, y: 108, text: 'Идея', color: '#e8e8ea', size: 22 },
          { id: 'a1', type: 'arrow', x1: 230, y1: 100, x2: 330, y2: 100, color: '#22c55e', width: 3 },
          { id: 's2', type: 'rect', x: 330, y: 60, w: 190, h: 80, color: '#8b5cf6', width: 3 },
          { id: 't2', type: 'text', x: 352, y: 108, text: 'Заметка', color: '#e8e8ea', size: 22 },
        ],
      },
      updatedAt: now,
    },
  ])
}

// === НАСТРОЙКИ ===

export async function getSetting(key, fallback) {
  const row = await db.settings.get(key)
  return row ? row.value : fallback
}

export async function setSetting(key, value) {
  await db.settings.put({ key, value })
}

export function pixelCoord(n) {
  return { x: n % MAP_W, y: Math.floor(n / MAP_W) % MAP_H }
}
