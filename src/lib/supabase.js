// Supabase Cloud + Offline: двусторонний синк заметок/событий, чанки/пиксели — push.
// Без VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY работает чисто локально (Dexie).
//
// Совместимость: если в облаке ещё старая схема (нет is_pinned / note_type /
// canvas_data), синк НЕ падает — он один раз пишет подсказку в журнал и
// продолжает работать с базовыми полями. Полная схема — supabase/schema.sql.
import { createClient } from '@supabase/supabase-js'
import { db, getSetting, setSetting, DIMENSIONS as BASE_DIMS } from './db.js'

// id базовых измерений — только они допустимы к синку
const BASE_DIM_IDS = BASE_DIMS.map((d) => d.id)

// Ключи берём из двух мест:
//  1) .env при сборке через Vite (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)
//  2) public/config.js — чтобы вписать ключи руками и запушить,
//     без пересборки (файл попадает в dist как /config.js).
const runtimeCfg = (typeof window !== 'undefined' && window.__NOT_CONFIG__) || {}
const URL = import.meta.env.VITE_SUPABASE_URL || runtimeCfg.supabaseUrl || ''
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || runtimeCfg.supabaseAnonKey || ''

export const cloudEnabled = Boolean(URL && KEY)

let client = null

// fetch с таймаутом: без него зависший запрос (сеть режет supabase тишиной)
// висит вечно — флаг syncing застревает в true НАВСЕГДА, и все последующие
// синки молча пропускаются до перезагрузки.
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

// Облако поддерживает поля v2? Проверяется один раз по факту ошибки.
let cloudV2 = true

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
  } catch {
    /* журнал не должен ронять синк */
  }
}

// Короткий хэш строки (canvas_data может быть большим — в настройках держим только хэш)
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const canvasKey = (n) => (n && n.canvas_data ? hashStr(JSON.stringify(n.canvas_data)) : '-')
const drawKey = (n) => (n && n.draw_data ? hashStr(JSON.stringify(n.draw_data)) : '-')

// Хэш содержимого: одинаковое не заливаем, иначе каждый фоновый опрос
// перезаписывал бы всё и спамил журнал + облако.
export const hashNote = (n) =>
  [
    n.title || '',
    n.body || '',
    n.dimension || '',
    Number(n.estimateHours) || 0,
    n.is_pinned ? 1 : 0,
    n.deleted ? 1 : 0,
    n.note_type || 'text',
    canvasKey(n),
    drawKey(n),
  ].join('|')

export async function markPushed(localId, note) {
  const h = await getSetting('pushedHash', {})
  h[localId] = hashNote(note)
  await setSetting('pushedHash', h)
}

// true, если ошибка — «такой колонки нет» (старая схема в облаке)
function isMissingColumn(err) {
  if (!err) return false
  const t = `${err.code || ''} ${err.message || ''} ${err.details || ''}`
  return /(is_pinned|note_type|canvas_data|draw_data|deleted)/i.test(t) && /(column|schema cache|does not exist|PGRST204|42703)/i.test(t)
}

function noteRow(n, withV2) {
  const row = {
    title: n.title || '',
    body: n.body || '',
    dimension: n.dimension,
    estimate_hours: Number(n.estimateHours) || 0,
    updated_at: new Date(n.updatedAt || Date.now()).toISOString(),
  }
  if (withV2) {
    row.is_pinned = !!n.is_pinned
    row.deleted = !!n.deleted
    row.note_type = n.note_type === 'canvas' ? 'canvas' : 'text'
    row.canvas_data = n.canvas_data || null
    row.draw_data = n.draw_data || null
  }
  return row
}

// upsert одной заметки с откатом на базовые поля, если колонок v2 нет
async function sendNote(sb, existingId, note) {
  const attempt = async (useV2) => {
    const row = noteRow(note, useV2)
    if (existingId) {
      const upd = await sb.from('notes').update(row).eq('id', existingId).select('id')
      if (upd.error) return { error: upd.error }
      if (upd.data && upd.data.length) return { id: existingId }
      // облачной строки уже нет (удалена) — создаём заново вместо зомби-маппинга
      const ins = await sb.from('notes').insert(row).select('id').single()
      if (ins.error) return { error: ins.error }
      return { id: ins.data?.id, recreated: true }
    }
    const ins = await sb.from('notes').insert(row).select('id').single()
    if (ins.error) return { error: ins.error }
    return { id: ins.data?.id }
  }

  let res = await attempt(cloudV2)
  if (res.error && cloudV2 && isMissingColumn(res.error)) {
    cloudV2 = false
    await logSync('облако: нет колонок v2 → синк базовых полей. Выполни supabase/schema.sql')
    res = await attempt(false)
  }
  if (res.error) throw new Error(`push: ${res.error.message}`)
  return res
}

async function pushNotes(sb) {
  const notes = await db.notes.toArray()
  const pushed = await getSetting('pushedHash', {})
  const seen = await getSetting('seenHash', {})
  for (const n of notes) {
    const key = `note:${n.id}`
    const h = hashNote(n)
    if (pushed[key] === h) continue // не менялась — пропускаем

    const existing = await cloudIdFor(key)
    const res = await sendNote(sb, existing, n)
    if (res.id) await rememberCloudId(key, res.id)
    await markPushed(key, n)
    await logSync(`push ${existing ? (res.recreated ? 'recreate' : 'upd') : '+'}${key}`)

    // только что залитое — уже «виденное», иначе следующий pull примет своё же за чужое
    const cid = await cloudIdFor(key)
    if (cid) seen[cid] = h
  }
  await setSetting('seenHash', seen)
}

// Pull БЕЗ фильтра по дате: часы устройств прыгают, любой временной фильтр
// рано или поздно теряет чужие правки навсегда. Качаем всё и сравниваем
// по содержимому: seenHash[cloudId] — что уже видели; различие = кто-то поменял.
// Конфликт (поменяли оба) — оставляем локальное, оно уедет следующим push.
async function pullNotes(sb) {
  const { data, error } = await sb.from('notes').select('*').order('updated_at', { ascending: true })
  if (error || !data) return 0

  const map = await getSetting('cloudIds', {})
  const seen = await getSetting('seenHash', {})
  const rev = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]))

  const patchOf = (r) => ({
    title: r.title || '',
    body: r.body || '',
    dimension: r.dimension,
    estimateHours: Number(r.estimate_hours) || 0,
    is_pinned: r.is_pinned ? 1 : 0,
    deleted: r.deleted ? 1 : 0,
    note_type: r.note_type === 'canvas' ? 'canvas' : 'text',
    canvas_data: r.canvas_data || null,
    draw_data: r.draw_data || null,
    updatedAt: new Date(r.updated_at).getTime() || Date.now(),
  })
  const hashOf = (p) => hashNote(p)

  let n = 0
  for (const r of data) {
    const localKey = rev[r.id]
    const patch = patchOf(r)

    // удалили на другом устройстве — удаляем и здесь, спорить не о чем
    if (patch.deleted) {
      if (localKey && localKey.startsWith('note:')) {
        const id = Number(localKey.slice(5))
        const local = await db.notes.get(id)
        if (local && !local.deleted) {
          await db.notes.update(id, { deleted: 1, updatedAt: patch.updatedAt })
          await logSync(`pull -note:${id} (удалена на другом устройстве)`)
          n++
        }
      }
      continue
    }

    if (localKey && localKey.startsWith('note:')) {
      const id = Number(localKey.slice(5))
      const local = await db.notes.get(id)
      if (!local) continue
      const h = hashOf(patch)
      if (seen[r.id] === h) continue // уже видели — ничего нового
      const localHash = hashNote(local)
      if (seen[r.id] === undefined || localHash === seen[r.id]) {
        // облако поменялось, а локальную с прошлого раза не трогали — забираем
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
      // (сиды есть на обоих) — усыновляем локальную с таким же названием
      const mappedLocalIds = new Set(
        Object.keys(map)
          .filter((k) => k.startsWith('note:'))
          .map((k) => Number(k.slice(5)))
      )
      const all = await db.notes.toArray()
      const twin = all.find(
        (l) =>
          !mappedLocalIds.has(l.id) &&
          (l.title || '').trim().toLowerCase() === (r.title || '').trim().toLowerCase()
      )
      if (twin) {
        await rememberCloudId(`note:${twin.id}`, r.id)
        // побеждает более свежая сторона, метку времени берём максимальную
        if ((twin.updatedAt || 0) >= patch.updatedAt) {
          Object.assign(patch, {
            title: twin.title,
            body: twin.body,
            dimension: twin.dimension,
            estimateHours: twin.estimateHours || 0,
            is_pinned: twin.is_pinned ? 1 : 0,
            note_type: twin.note_type === 'canvas' ? 'canvas' : 'text',
            canvas_data: twin.canvas_data || null,
            draw_data: twin.draw_data || null,
            updatedAt: twin.updatedAt,
          })
        }
        await db.notes.update(twin.id, patch)
        await markPushed(`note:${twin.id}`, patch)
        seen[r.id] = hashOf(patch)
        await logSync(`pull adopt note:${twin.id}`)
        n++
      } else {
        const id = await db.notes.add(patch)
        await rememberCloudId(`note:${id}`, r.id)
        await markPushed(`note:${id}`, patch)
        seen[r.id] = hashOf(patch)
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
  if (!dims.length) return
  const { error } = await sb
    .from('dimensions')
    .upsert(
      dims.map((d) => ({ id: d.id, name: d.name, color: d.color })),
      { onConflict: 'id' }
    )
  if (error) throw new Error(`dimensions: ${error.message}`)
}

// Подчистка измерений в облаке. ВАЖНО: вызывается ПОСЛЕ pushNotes, потому что
// notes.dimension — внешний ключ на dimensions(id) без ON DELETE CASCADE:
// сначала переносим ссылки заметок на базовое измерение, потом удаляем лишнее.
async function pruneCloudDimensions(sb) {
  const { data: cloudDims } = await sb.from('dimensions').select('id')
  const extra = (cloudDims || []).filter((r) => !BASE_DIM_IDS.includes(r.id))
  if (!extra.length) return 0
  const fallback = BASE_DIM_IDS[0] // «Я»
  for (const r of extra) {
    await sb.from('notes').update({ dimension: fallback }).eq('dimension', r.id)
    // events может отсутствовать в старой базе: ошибку намеренно игнорируем,
    // чтобы не ронять весь синк из-за одной таблицы
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
    .map((c) => ({
      note_id: idOf(c.noteId),
      day: c.date,
      hours: c.hours,
      done: !!c.done,
      habit: !!c.habit,
    }))
    .filter((c) => c.note_id)
  const pixels = (await db.pixels.toArray()).map((p) => ({
    x: p.x,
    y: p.y,
    note_id: idOf(p.noteId),
    opened_at: new Date(p.openedAt || Date.now()).toISOString(),
  }))

  const ZERO = '00000000-0000-0000-0000-000000000000'
  await sb.from('links').delete().neq('from_id', ZERO)
  await sb.from('chunks').delete().neq('note_id', ZERO)
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
  let links = 0
  let chunks = 0

  // измерения тянем ПЕРВЫМИ — иначе заметки с кастомным измерением нечем показать.
  // Только базовые три: остальные в облаке считаются удалёнными и не возвращаются.
  const { data: rd } = await sb.from('dimensions').select('*')
  for (const r of rd || []) {
    if (!BASE_DIM_IDS.includes(r.id)) continue
    const ex = await db.dimensions.get(r.id)
    if (!ex) await db.dimensions.add({ id: r.id, name: r.name, color: r.color })
    else if (ex.name !== r.name || ex.color !== r.color)
      await db.dimensions.put({ ...ex, name: r.name, color: r.color })
  }

  const { data: rl } = await sb.from('links').select('*')
  const existingLinks = await db.links.toArray()
  for (const r of rl || []) {
    const f = localNoteId(r.from_id)
    const t = localNoteId(r.to_id)
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
    const ex = await db.chunks
      .where('noteId')
      .equals(nid)
      .filter((c) => c.date === r.day && !!c.habit === hb)
      .first()
    if (ex) {
      if (!!ex.done !== !!r.done || Number(ex.hours) !== Number(r.hours)) {
        await db.chunks.update(ex.id, { hours: Number(r.hours), done: r.done ? 1 : 0 })
        chunks++
      }
    } else {
      await db.chunks.add({
        noteId: nid,
        date: r.day,
        hours: Number(r.hours),
        done: r.done ? 1 : 0,
        habit: hb ? 1 : 0,
      })
      chunks++
    }
  }

  const { data: rp } = await sb.from('pixels').select('*')
  for (const r of rp || []) {
    const ex = await db.pixels.get([r.x, r.y])
    if (!ex) {
      await db.pixels.put({
        x: r.x,
        y: r.y,
        noteId: localNoteId(r.note_id),
        openedAt: new Date(r.opened_at).getTime() || Date.now(),
      })
    }
  }
  return { links, chunks }
}

// События календаря: стабильные текстовые id на всех устройствах, upsert по id,
// удаление — только soft-delete флагом, поэтому никогда не воскресает.
// Терпим к отсутствию таблицы (старый облачный SQL).
async function pushEvents(sb) {
  try {
    const evs = await db.events.toArray()
    if (!evs.length) return 0
    const rows = evs.map((e) => ({
      id: e.id,
      day: e.date,
      title: e.title || '',
      dimension: e.dimension || null,
      deleted: !!e.deleted,
      is_pinned: !!e.is_pinned,
      updated_at: new Date(e.updatedAt || Date.now()).toISOString(),
    }))
    let { error } = await sb.from('events').upsert(rows, { onConflict: 'id' })
    if (error && /is_pinned/i.test(error.message || '')) {
      // в облаке ещё нет колонки закрепления событий — шлём без неё
      const base = rows.map(({ is_pinned, ...rest }) => rest)
      ;({ error } = await sb.from('events').upsert(base, { onConflict: 'id' }))
    }
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
        id: r.id,
        date: r.day,
        title: r.title || '',
        dimension: r.dimension || null,
        deleted: r.deleted ? 1 : 0,
        is_pinned: r.is_pinned ? 1 : 0,
        updatedAt: new Date(r.updated_at).getTime() || Date.now(),
      }
      const ex = await db.events.get(r.id)
      if (!ex) {
        await db.events.add(patch)
        n++
      } else if (
        ex.date !== patch.date ||
        ex.title !== patch.title ||
        (ex.dimension || null) !== patch.dimension ||
        !!ex.deleted !== !!patch.deleted ||
        !!ex.is_pinned !== !!patch.is_pinned
      ) {
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

// Разовая чистка дубликатов (одинаковое название): остаётся самая свежая,
// остальные удаляются локально и в облаке. Запускать на КАЖДОМ устройстве.
export async function cleanupDuplicates() {
  const sb = cloud()
  const all = (await db.notes.toArray()).filter((n) => !n.deleted)
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
    // закреплённая важнее свежей: не теряем пин при схлопывании
    group.sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
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
      } catch {
        /* следующий pushRest подчистит остатки */
      }
      removed++
    }
  }
  await setSetting('cloudIds', map)

  // облачные сироты: строки без локального маппинга (старые дубли + заметки,
  // пропущенные старым pull-фильтром по дате). Дубль схлопываем в локальную
  // (побеждает свежий), чужую новую — забираем себе.
  let merged = 0
  let adopted = 0
  try {
    const { data: allCloud } = await sb.from('notes').select('*')
    for (const r of allCloud || []) {
      const isMapped = Object.values(map).includes(r.id)
      if (isMapped) continue
      const locals = (await db.notes.toArray()).filter((l) => !l.deleted)
      const twin = locals.find(
        (l) => (l.title || '').trim().toLowerCase() === (r.title || '').trim().toLowerCase()
      )
      const rTs = new Date(r.updated_at).getTime() || Date.now()
      if (twin) {
        if (rTs > (twin.updatedAt || 0)) {
          await db.notes.update(twin.id, {
            title: r.title,
            body: r.body,
            dimension: r.dimension,
            estimateHours: Number(r.estimate_hours) || 0,
            is_pinned: r.is_pinned ? 1 : 0,
            note_type: r.note_type === 'canvas' ? 'canvas' : 'text',
            canvas_data: r.canvas_data || null,
            draw_data: r.draw_data || null,
            updatedAt: rTs,
          })
        }
        await sb.from('notes').delete().eq('id', r.id)
        merged++
      } else {
        const id = await db.notes.add({
          title: r.title,
          body: r.body,
          dimension: r.dimension,
          estimateHours: Number(r.estimate_hours) || 0,
          is_pinned: r.is_pinned ? 1 : 0,
          note_type: r.note_type === 'canvas' ? 'canvas' : 'text',
          canvas_data: r.canvas_data || null,
          draw_data: r.draw_data || null,
          updatedAt: rTs,
        })
        map[`note:${id}`] = r.id
        adopted++
      }
    }
    await setSetting('cloudIds', map)
  } catch {
    /* облако недоступно — локальная чистка уже сделана */
  }
  return { removed, merged, adopted }
}
