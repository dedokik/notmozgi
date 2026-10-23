import { parseDeadlines } from './dates.js'
import { getSetting, setSetting } from './db.js'

// Локальные напоминания о дедлайнах и событиях. Сервер не нужен: срабатывают,
// пока приложение открыто (вкладка/установленное PWA). Разрешение — по кнопке.

const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function daysLeft(date) {
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return Math.round((d - t) / 86400000)
}

export async function checkDeadlines(notes) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return 0
  const done = await getSetting('notifiedDeadlines', {})
  const todayKey = dayKey(new Date())
  let n = 0

  for (const note of notes || []) {
    const dl = parseDeadlines(`${note.title || ''}\n${note.body || ''}`)[0]
    if (!dl) continue
    const left = daysLeft(dl.date)
    // напоминаем за день, в день дедлайна и неделю после — дальше это спам
    if (left > 1 || left < -7) continue
    const key = `${note.id}:${dayKey(dl.date)}`
    if (done[key] === todayKey) continue // сегодня уже напоминали
    const title =
      left === 0
        ? `Дедлайн сегодня: ${note.title}`
        : left === 1
          ? `Дедлайн завтра: ${note.title}`
          : `Просрочено ${-left} дн.: ${note.title}`
    try {
      new Notification(title, { body: (note.body || '').slice(0, 120), tag: key })
      done[key] = todayKey
      n++
    } catch {
      /* заблокировано браузером */
    }
  }

  const keys = Object.keys(done)
  if (keys.length > 100) {
    const fresh = {}
    for (const k of keys.slice(-100)) fresh[k] = done[k]
    await setSetting('notifiedDeadlines', fresh)
  } else if (n) {
    await setSetting('notifiedDeadlines', done)
  }
  return n
}

// Напоминания о событиях календаря (сегодня / завтра).
// ВАЖНО: e.date хранится как 'YYYY-MM-DD', поэтому сравнивать с toDateString()
// нельзя — раньше из-за этого события не напоминали никогда.
export async function checkCalendarEvents(events) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return 0
  const done = await getSetting('notifiedEvents', {})
  const today = new Date()
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const todayKey = dayKey(today)
  const tomorrowKey = dayKey(tomorrow)
  let n = 0

  for (const e of events || []) {
    if (e.deleted) continue
    const isToday = e.date === todayKey
    const isTomorrow = e.date === tomorrowKey
    if (!isToday && !isTomorrow) continue
    const key = `${e.id}:${e.date}`
    if (done[key] === todayKey) continue
    const title = isToday ? `Событие сегодня: ${e.title}` : `Событие завтра: ${e.title}`
    try {
      new Notification(title, { body: 'Календарь · ' + e.title, tag: key })
      done[key] = todayKey
      n++
    } catch {
      /* заблокировано браузером */
    }
  }

  const keys = Object.keys(done)
  if (keys.length > 100) {
    const fresh = {}
    for (const k of keys.slice(-100)) fresh[k] = done[k]
    await setSetting('notifiedEvents', fresh)
  } else if (n) {
    await setSetting('notifiedEvents', done)
  }
  return n
}
