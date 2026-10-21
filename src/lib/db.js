import Dexie from 'dexie'

export const DIMENSIONS = [
  { id: 'ya', name: 'Я', color: '#3b82f6' },
  { id: 'study', name: 'Учеба', color: '#8b5cf6' },
  { id: 'work', name: 'Работа', color: '#f59e0b' },
]

export const MAP_W = 100
export const MAP_H = 50

export const db = new Dexie('not-dark-os')
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

export async function seedDimensions() {
  const count = await db.dimensions.count()
  if (count > 0) return
  await db.dimensions.bulkAdd(DIMENSIONS.map((d) => ({ ...d })))
}

// Приводит набор измерений к трём базовым (Я, Учеба, Работа).
// Все лишние удаляются, а их заметки переезжают в «Я».
// Вызывается при каждом старте — в т.ч. после подтягивания из облака.
export async function normalizeDimensions() {
  const baseIds = DIMENSIONS.map((d) => d.id)
  const all = await db.dimensions.toArray()
  const extra = all.filter((d) => !baseIds.includes(d.id))
  const fallback = DIMENSIONS[0].id // «Я» — куда переезжают чужие заметки

  if (extra.length) {
    await db.transaction('rw', [db.notes, db.dimensions], async () => {
      for (const d of extra) {
        await db.notes.where('dimension').equals(d.id).modify({ dimension: fallback, updatedAt: Date.now() })
        await db.dimensions.delete(d.id)
      }
    })
  }

  // создаём недостающие базовые (с сохранением переименований)
  for (const d of DIMENSIONS) {
    const ex = await db.dimensions.get(d.id)
    if (!ex) await db.dimensions.add({ ...d })
  }
  return extra.length
}

export async function seedIfEmpty() {
  const count = await db.notes.count()
  if (count > 0) return
  const now = Date.now()
  await db.notes.bulkAdd([
    {
      title: 'Добро пожаловать',
      body: '# Привет\n\nЭто Not: заметки + календарь + граф + карта.\n\n- [ ] Создать заметку в измерении Учёба\n- [ ] Написать `дедлайн: 30.09` и `оценка: 6ч` в тексте\n- [x] Открыть календарь\n\nСвязь с релизом: [[MVP релиз]]\n\nдедлайн: 30.09',
      dimension: 'ya',
      estimateHours: 6,
      updatedAt: now,
    },
    {
      title: 'Купить продукты',
      body: '## Список\n\n- [ ] Молоко\n- [ ] Хлеб\n\nдедлайн: 26.09',
      dimension: 'study',
      estimateHours: 1,
      updatedAt: now,
    },
    {
      title: 'MVP релиз',
      body: '# Проекты\n\nДоделать каркас и показать на телефоне по Wi-Fi.\n\n**дедлайн: 28.09**',
      dimension: 'work',
      estimateHours: 4,
      updatedAt: now,
    },
  ])
}

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
