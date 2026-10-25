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

// У каждого аккаунта СВОЯ база, поэтому данные разных людей физически не
// пересекаются: вошёл другим аккаунтом — приложение пустое, чужих заметок
// и измерений там нет.
export const BASE_DB = 'not-dark-os'

export function makeDb(name) {
  const d = new Dexie(name)

  // ВАЖНО: is_pinned хранится числом 0/1, а НЕ boolean.
  // IndexedDB не умеет индексировать boolean: запись с true в индексируемом
  // поле отваливается с DataError, и таблица перестаёт открываться.
  d.version(1).stores({
    notes: '++id, dimension, updatedAt',
    settings: 'key',
  })

  d.version(2).stores({
    notes: '++id, dimension, updatedAt',
    settings: 'key',
    links: '++id, fromId, toId',
    chunks: '++id, noteId, date, done',
    pixels: '[x+y], noteId, openedAt',
  })

  d.version(3).stores({
    notes: '++id, dimension, updatedAt',
    settings: 'key',
    links: '++id, fromId, toId',
    chunks: '++id, noteId, date, done',
    pixels: '[x+y], noteId, openedAt',
    dimensions: 'id',
  })

  d.version(4).stores({
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
  d.version(5)
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

  return d
}

// Первый аккаунт на устройстве живёт в уже существующей базе — так старые
// заметки не нужно никуда переносить. Следующие аккаунты получают свою.
export const dbNameFor = (accountId, isFirst) => (isFirst ? BASE_DB : `${BASE_DB}-${accountId}`)

export let db = makeDb(BASE_DB)

// Переключение на базу аккаунта. `db` — живая привязка модуля: все, кто её
// импортировал, дальше работают уже с новой базой.
export async function openProfileDb(name) {
  if (db && db.name === name) {
    if (!db.isOpen()) await db.open()
    return db
  }
  try {
    db.close()
  } catch {
    /* уже закрыта */
  }
  db = makeDb(name)
  await db.open()
  return db
}

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
