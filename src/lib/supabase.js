// Supabase Cloud + Offline: двухсторонний синк заметок/связей, чанки/пиксели — push.
// Без VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY работает чисто локально (Dexie).
import { createClient } from '@supabase/supabase-js'
import { db, getSetting, setSetting, DIMENSIONS as BASE_DIMS } from './db.js'

// id базовых измерений — только они допустимы к синку
const BASE_DIM_IDS = BASE_DIMS.map((d) => d.id)

const URL = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const cloudEnabled = Boolean(URL && KEY)

let client = null
// fetch с таймаутом: БЕЗ него зависший запрос (сеть режет supabase тишиной,
// VPN выключен и т.п.) висит вечно — флаг syncing застревает в true НАВСЕГДА,
// и все последующие синки (авто и кнопка!) молча пропускаются до перезагрузки.
// Именно так синк "умирает после первого раза", а ручная диагностика работает.
function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t))
}
export function cloud() {
  if (!cloudEnabled) return null
  if (!client) client = createClient(URL, KEY, { global: { fetch: (u, o) => fetchWithTimeout(u, o, 15000) } })
  return client
}

async function cloudIdFor(localId) {
  const map = await getSetting('cloudIds', {})
  return map[localId] || null
}
async function rememberCloudId(localId, cloudId) {
  const map = await getSetting('cloudIds', {})
  map[localId] = cloudId
  await setSetting('cloudIds', map)
}

// Журнал синка (последние 40 строк, переживает перезагрузку) — видно в Диагностике.
export async function logSync(msg) {
  try {
    const log = await getSetting('syncLog', [])
    log.push(`${new Date().toLocaleTimeString('ru-RU')} ${msg}`)
    while (log.length > 40) log.shift()
    await setSetting('syncLog', log)
  } catch { /* журнал не должен ронять синк */ }
}

// Push только изменённого: хэш содержимого храним локально, идентичное не заливаем.
// Иначе каждый фоновый опрос перезаписывал бы всё и спамил журнал + облако.
const hashNote = (n) => `${n.title || ''}|${n.body || ''}|${n.dimension || ''}|${Number(n.estimateHours) || 0}`

export async function markPushed(localId, note) {
  const h = await getSetting('pushedHash', {})
  h[localId] = hashNote(note)
  await setSetting('pushedHash', h)
}

// Push заметки: upsert по cloudId, локально запоминаем соответствие.
// Ошибки (напр. RLS) бросаем наружу — тихий "Ок" при незалитых данных хуже ошибки.
async function pushNotes(sb) {
  const notes = await db.notes.toArray()
  const pushed = await getSetting('pushedHash', {})
  const seen = await getSetting('seenHash', {})
  for (const n of notes) {
    if (pushed[`note:${n.id}`] === hashNote(n)) continue // не менялась — пропускаем
    const existing = await cloudIdFor(`note:${n.id}`)
    const row = {
      title: n.title,
      body: n.body,
      dimension: n.dimension,
      estimate_hours: Number(n.estimateHours) || 0,
      updated_at: new Date(n.updatedAt).toISOString(),
    }
    if (existing) {
      const { data, error } = await sb.from('notes').update(row).eq('id', existing).select('id')
      if (error) throw new Error(`push: ${error.message}`)
      if (!data || !data.length) {
        // облачной строки уже нет (удалена) — создаём заново вместо зомби-маппинга
        const ins = await sb.from('notes').insert(row).select('id').single()
        if (ins.error) throw new Error(`push: ${ins.error.message}`)
        if (ins.data) await rememberCloudId(`note:${n.id}`, ins.data.id)
        await logSync(`push recreate note:${n.id}`)
      } else {
        await logSync(`push upd note:${n.id}`)
      }
    } else {
      const { data, error } = await sb.from('notes').insert(row).select('id').single()
      if (error) throw new Error(`push: ${error.message}`)
      if (data) await rememberCloudId(`note:${n.id}`, data.id)
      await logSync(`push +note:${n.id}`)
    }
    await markPushed(`note:${n.id}`, n)
    // только что залитое — уже "виденное", иначе следующий pull примет своё же за чужое
    const cid = await cloudIdFor(`note:${n.id}`)
    if (cid) seen[cid] = `${row.title}||${row.body}||${row.dimension}||${Number(row.estimate_hours) || 0}`
  }
  await setSetting('seenHash', seen)
}

// Pull БЕЗ фильтра по дате: часы устройств прыгают (видели скачок ~14 мин на ПК),
// любой временной фильтр рано или поздно теряет чужие правки навсегда.
// Качаем всё (заметок мало) и сравниваем по содержимому:
// seenHash[cloudId] — что уже видели; различие = кто-то поменял.
// Конфликт (поменяли оба) — оставляем локальное, оно уедет следующим push; пишем в журнал.
async function pullNotes(sb) {
  const { data, error } = await sb.from('notes').select('*').order('updated_at', { ascending: true })
  if (error || !data) return 0
  const map = await getSetting('cloudIds', {})
  const seen = await getSetting('seenHash', {})
  const rev = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]))
  const hOf = (t, b, d, e) => `${t || ''}||${b || ''}||${d || ''}||${Number(e) || 0}`
  let n = 0
  for (const r of data) {
    const localKey = rev[r.id]
    const patch = {
      title: r.title,
      body: r.body,
      dimension: r.dimension,
      estimateHours: Number(r.estimate_hours) || 0,
      updatedAt: new Date(r.updated_at).getTime(),
    }
    if (localKey && localKey.startsWith('note:')) {
      const id = Number(localKey.slice(5))
      const local = await db.notes.get(id)
      if (!local) continue
      const h = hOf(r.title, r.body, r.dimension, r.estimate_hours)
      if (seen[r.id] === h) continue // уже видели — ничего нового
      if (seen[r.id] === undefined || hOf(local.title, local.body, local.dimension, local.estimateHours) === seen[r.id]) {
        // облако поменялось, а локальную с прошлого раза не трогали (или видим впервые) — забираем
        await db.notes.update(id, patch)
        await markPushed(`note:${id}`, patch)
        seen[r.id] = h
        await logSync(`pull ~note:${id}`)
        n++
      } else {
        await logSync(`conflict note:${id} kept local`)
      }
    } else {
      // маппинга нет: может, это та же заметка с другого устройства
      // (сиды «Добро пожаловать» есть на обоих!) — ищем локальную без маппинга
      // с ТОЧНО таким же названием и усыновляем её вместо создания дубля
      const mappedLocalIds = new Set(
        Object.keys(map).filter((k) => k.startsWith('note:')).map((k) => Number(k.slice(5)))
      )
      const all = await db.notes.toArray()
      const twin = all.find(
        (l) => !mappedLocalIds.has(l.id) && (l.title || '').trim().toLowerCase() === (r.title || '').trim().toLowerCase()
      )
      if (twin) {
        await rememberCloudId(`note:${twin.id}`, r.id)
        // побеждает более свежая сторона, метку времени берём максимальную
        if (twin.updatedAt >= patch.updatedAt) {
          patch.title = twin.title
          patch.body = twin.body
          patch.dimension = twin.dimension
          patch.estimateHours = twin.estimateHours
          patch.updatedAt = twin.updatedAt
        }
        await db.notes.update(twin.id, patch)
        await markPushed(`note:${twin.id}`, patch)
        seen[r.id] = hOf(patch.title, patch.body, patch.dimension, patch.estimateHours)
        await logSync(`pull adopt note:${twin.id}`)
        n++
      } else {
        const id = await db.notes.add({ ...patch })
        await rememberCloudId(`note:${id}`, r.id)
        await markPushed(`note:${id}`, patch)
        seen[r.id] = hOf(patch.title, patch.body, patch.dimension, patch.estimateHours)
        await logSync(`pull +note:${id}`)
        n++
      }
    }
  }
  await setSetting('seenHash', seen)
  return n
}

// Измерения: upsert по id. Вызывается ПЕРВЫМ — заметки ссылаются на dimensions по FK.
async function pushDimensions(sb) {
  const dims = await db.dimensions.toArray()
  if (dims.length) {
    await sb.from('dimensions').upsert(
      dims.map((d) => ({ id: d.id, name: d.name, color: d.color })),
      { onConflict: 'id' }
    )
  }
}

// Подчистка измерений в облаке. ВАЖНО: вызывается ПОСЛЕ pushNotes, потому что
// notes.dimension — внешний ключ на dimensions(id) без ON DELETE CASCADE:
// сначала переносим ссылки заметок на базовое измерение, потом удаляем лишнее.
async function pruneCloudDimensions(sb) {
  const { data: cloud } = await sb.from('dimensions').select('id')
  const extra = (cloud || []).filter((r) => !BASE_DIM_IDS.includes(r.id))
  if (!extra.length) return 0
  const fallback = BASE_DIM_IDS[0] // «Я»
  for (const r of extra) {
    await sb.from('notes').update({ dimension: fallback }).eq('dimension', r.id)
    await sb.from('events').update({ dimension: fallback }).eq('dimension', r.id)
    await sb.from('dimensions').delete().eq('id', r.id)
  }
  return extra.length
}

async function pushRest(sb) {
  // связи/чанки/пиксели: wholesale replace (один пользователь)
  const noteMap = await getSetting('cloudIds', {})
  const idOf = (localId) => noteMap[`note:${localId}`] || null

  const links = (await db.links.toArray())
    .map((l) => ({ from_id: idOf(l.fromId), to_id: idOf(l.toId) }))
    .filter((l) => l.from_id && l.to_id)
  const chunks = (await db.chunks.toArray())
    .map((c) => ({ note_id: idOf(c.noteId), day: c.date, hours: c.hours, done: !!c.done, habit: !!c.habit }))
    .filter((c) => c.note_id)
  const pixels = (await db.pixels.toArray())
    .map((p) => ({ x: p.x, y: p.y, note_id: idOf(p.noteId), opened_at: new Date(p.openedAt).toISOString() }))

  await sb.from('links').delete().neq('from_id', '00000000-0000-0000-0000-000000000000')
  await sb.from('chunks').delete().neq('note_id', '00000000-0000-0000-0000-000000000000')
  await sb.from('pixels').delete().neq('x', -1)
  if (links.length) await sb.from('links').insert(links)
  if (chunks.length) await sb.from('chunks').insert(chunks)
  if (pixels.length) await sb.from('pixels').insert(pixels)
}

// Pull связей/чанков/пикселей: облако -> локально (идемпотентно, без дублей).
async function pullRest(sb) {
  const map = await getSetting('cloudIds', {})
  const rev = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]))
  const localNoteId = (cloudUuid) => {
    const k = rev[cloudUuid]
    return k && k.startsWith('note:') ? Number(k.slice(5)) : null
  }
  let links = 0, chunks = 0
  // измерения тянем ПЕРВЫМИ — иначе заметки с кастомным измерением нечем показать
  // Только базовые три: остальные в облаке считаются удалёнными и не возвращаются.
  const { data: rd } = await sb.from('dimensions').select('*')
  for (const r of rd || []) {
    if (!BASE_DIM_IDS.includes(r.id)) continue
    const ex = await db.dimensions.get(r.id)
    if (!ex) await db.dimensions.add({ id: r.id, name: r.name, color: r.color })
    else if (ex.name !== r.name || ex.color !== r.color) await db.dimensions.put({ ...ex, name: r.name, color: r.color })
  }
  const { data: rl } = await sb.from('links').select('*')
  const existingLinks = await db.links.toArray()
  for (const r of rl || []) {
    const f = localNoteId(r.from_id), t = localNoteId(r.to_id)
    if (!f || !t) continue
    if (!existingLinks.some((l) => l.fromId === f && l.toId === t)) {
      const id = await db.links.add({ fromId: f, toId: t })
      existingLinks.push({ id, fromId: f, toId: t })
      links++
    }
  }
  const { data: rc } = await sb.from('chunks').select('*')
  for (const r of rc || []) {
    const nid = localNoteId(r.note_id)
    if (!nid) continue
    const hb = !!r.habit
    const ex = await db.chunks.where('noteId').equals(nid).filter((c) => c.date === r.day && !!c.habit === hb).first()
    if (ex) {
      if (!!ex.done !== !!r.done || Number(ex.hours) !== Number(r.hours)) {
        await db.chunks.update(ex.id, { hours: Number(r.hours), done: r.done ? 1 : 0 })
        chunks++
      }
    } else {
      await db.chunks.add({ noteId: nid, date: r.day, hours: Number(r.hours), done: r.done ? 1 : 0, habit: hb ? 1 : 0 })
      chunks++
    }
  }
  const { data: rp } = await sb.from('pixels').select('*')
  for (const r of rp || []) {
    const ex = await db.pixels.get([r.x, r.y])
    if (!ex) {
      await db.pixels.put({ x: r.x, y: r.y, noteId: localNoteId(r.note_id), openedAt: new Date(r.opened_at).getTime() || Date.now() })
    }
  }
  return { links, chunks }
}

// Разовая чистка дубликатов (одинаковое название): остаётся самая свежая,
// остальные удаляются локально и в облаке. Запускать на КАЖДОМ устройстве.
export async function cleanupDuplicates() {
  const sb = cloud()
  const all = await db.notes.toArray()
  const byTitle = new Map()
  for (const n of all) {
    const t = (n.title || '').trim().toLowerCase()
    if (!byTitle.has(t)) byTitle.set(t, [])
    byTitle.get(t).push(n)
  }
  const map = await getSetting('cloudIds', {})
  let removed = 0
  for (const [, group] of byTitle) {
    if (group.length < 2) continue
    group.sort((a, b) => b.updatedAt - a.updatedAt)
    const [, ...dups] = group
    for (const d of dups) {
      await db.transaction('rw', [db.notes, db.links, db.chunks], async () => {
        await db.notes.delete(d.id)
        await db.links.where('fromId').equals(d.id).delete()
        await db.links.where('toId').equals(d.id).delete()
        await db.chunks.where('noteId').equals(d.id).delete()
      })
      try {
        const cid = map[`note:${d.id}`]
        if (cid && sb) await sb.from('notes').delete().eq('id', cid)
        delete map[`note:${d.id}`]
      } catch { /* следующий pushRest подчистит остатки */ }
      removed++
    }
  }
  await setSetting('cloudIds', map)
  // облачные сироты: строки без локального маппинга (старые дубли + заметки,
  // пропущенные pull-фильтром по дате). Дубль схлопываем в локальную (побеждает
  // свежий), чужую новую — забираем себе.
  let merged = 0, adopted = 0
  try {
    const { data: allCloud } = await sb.from('notes').select('*')
    for (const r of allCloud || []) {
      const isMapped = Object.values(map).includes(r.id)
      if (isMapped) continue
      const locals = await db.notes.toArray()
      const twin = locals.find(
        (l) => (l.title || '').trim().toLowerCase() === (r.title || '').trim().toLowerCase()
      )
      const rTs = new Date(r.updated_at).getTime() || Date.now()
      if (twin) {
        if (rTs > (twin.updatedAt || 0)) {
          await db.notes.update(twin.id, {
            title: r.title, body: r.body, dimension: r.dimension,
            estimateHours: Number(r.estimate_hours) || 0, updatedAt: rTs,
          })
        }
        await sb.from('notes').delete().eq('id', r.id)
        merged++
      } else {
        const id = await db.notes.add({
          title: r.title, body: r.body, dimension: r.dimension,
          estimateHours: Number(r.estimate_hours) || 0, updatedAt: rTs,
        })
        map[`note:${id}`] = r.id
        adopted++
      }
    }
    await setSetting('cloudIds', map)
  } catch { /* облако недоступно — локальная чистка уже сделана */ }
  return { removed, merged, adopted }
}

// События календаря: стабильные текстовые id на всех устройствах, upsert по id
// (без wholesale-удаления), удаление — только soft-delete флагом, поэтому
// никогда не воскресает. Терпим к отсутствию таблицы (старый облачный SQL).
async function pushEvents(sb) {
  try {
    const evs = await db.events.toArray()
    if (!evs.length) return 0
    const { error } = await sb.from('events').upsert(
      evs.map((e) => ({
        id: e.id, day: e.date, title: e.title || '', dimension: e.dimension || null,
        deleted: !!e.deleted, updated_at: new Date(e.updatedAt).toISOString(),
      })),
      { onConflict: 'id' }
    )
    if (error) throw error
    return evs.length
  } catch (e) {
    await logSync(`events push skip: ${String(e.message || e).slice(0, 100)}`)
    return 0
  }
}

async function pullEvents(sb) {
  try {
    const { data, error } = await sb.from('events').select('*')
    if (error) throw error
    let n = 0
    for (const r of data || []) {
      const patch = {
        id: r.id, date: r.day, title: r.title || '', dimension: r.dimension || null,
        deleted: !!r.deleted, updatedAt: new Date(r.updated_at).getTime() || Date.now(),
      }
      const ex = await db.events.get(r.id)
      if (!ex) {
        await db.events.add(patch)
        n++
      } else if (ex.date !== patch.date || ex.title !== patch.title ||
          (ex.dimension || null) !== patch.dimension || !!ex.deleted !== patch.deleted) {
        await db.events.put(patch)
        n++
      }
    }
    return n
  } catch (e) {
    await logSync(`events pull skip: ${String(e.message || e).slice(0, 100)}`)
    return 0
  }
}

export async function syncNow(opts = {}) {
  const sb = cloud()
  if (!sb) return { ok: false, reason: 'Нет VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (.env)' }
  try {
    await pushDimensions(sb)
    await pushNotes(sb)
    await pushEvents(sb)
    // подчистка лишних измерений в облаке — после пуша заметок (иначе FK)
    await pruneCloudDimensions(sb)
    const pulled = await pullNotes(sb)
    const rest = await pullRest(sb)
    const pulledEvents = await pullEvents(sb)
    await pushRest(sb)
    await setSetting('lastSync', new Date().toISOString())
    // тихие фоновые синки пишут итог только если что-то реально приехало/уехало
    if (!opts.quiet || pulled || rest.links || rest.chunks || pulledEvents) {
      await logSync(`ok pulled=${pulled} links=${rest.links} chunks=${rest.chunks} events=${pulledEvents}`)
    }
    return { ok: true, pulled, pulledLinks: rest.links, pulledChunks: rest.chunks, pulledEvents }
  } catch (e) {
    await logSync(`FAIL ${String(e.message || e).slice(0, 140)}`)
    return { ok: false, reason: String(e.message || e) }
  }
}
