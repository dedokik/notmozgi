import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { db, DIMENSIONS as DEFAULT_DIMS, seedIfEmpty, seedDimensions, getSetting, setSetting } from './lib/db.js'
import { parseDeadlines, firstDeadline, fmtDate } from './lib/dates.js'
import { parseWikiLinks } from './lib/links.js'
import { buildPlan, recalcMissed, toggleChunk, toggleHabit, todayISO, isHabit, parseEffort } from './lib/chunks.js'
import * as pixelsLib from './lib/pixels.js'
import { cloudEnabled, syncNow, cloud, cleanupDuplicates } from './lib/supabase.js'
import GraphView from './components/GraphView.jsx'
import MapView from './components/MapView.jsx'
import SyncDiag from './components/SyncDiag.jsx'
import { checkDeadlines, checkCalendarEvents } from './lib/notify.js'

function getTasks(body) {
  const lines = (body || '').split('\n')
  return lines
    .map((line, idx) => {
      const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(.*)$/)
      return m ? { idx, checked: m[1].toLowerCase() === 'x', text: m[2] } : null
    })
    .filter(Boolean)
}

function toggleTaskLine(body, lineIdx) {
  const lines = (body || '').split('\n')
  const line = lines[lineIdx]
  if (line.includes('[ ]')) lines[lineIdx] = line.replace('[ ]', '[x]')
  else if (/\[x\]/i.test(line)) lines[lineIdx] = line.replace(/\[x\]/i, '[ ]')
  return lines.join('\n')
}

// суммы часов без мусора типа 0.30000000000000004
const f1 = (x) => Math.round(x * 10) / 10

function useDebouncedSave(note, onSaved) {
  useEffect(() => {
    if (!note) return
    const t = setTimeout(async () => {
      await db.notes.update(note.id, {
        title: note.title,
        body: note.body,
        dimension: note.dimension,
        estimateHours: Number(note.estimateHours) || 0,
        updatedAt: Date.now(),
      })
      onSaved()
    }, 400)
    return () => clearTimeout(t)
  }, [note?.id, note?.title, note?.body, note?.dimension, note?.estimateHours])
}

export default function App() {
  const [notes, setNotes] = useState([])
  const [links, setLinks] = useState([])
  const [chunks, setChunks] = useState([])
  const [pixelRows, setPixelRows] = useState([])
  const [events, setEvents] = useState([])
  const [evTitle, setEvTitle] = useState('')
  const [evDim, setEvDim] = useState('')
  const [dims, setDims] = useState(DEFAULT_DIMS)
  const [activeId, setActiveId] = useState(null)
  const [enabledDims, setEnabledDims] = useState(new Set(DEFAULT_DIMS.map((d) => d.id)))
  const [menuOpen, setMenuOpen] = useState(false)
  const [tab, setTab] = useState('notes') // notes | calendar | graph | map
  const [preview, setPreview] = useState(false)
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() } })
  const [selectedDay, setSelectedDay] = useState(null)
  const [calView, setCalView] = useState('month') // month | week
  const [weekAnchor, setWeekAnchor] = useState(() => new Date())
  const [syncMsg, setSyncMsg] = useState('')
  const [lastSyncAt, setLastSyncAt] = useState('')
  const [notifState, setNotifState] = useState(() => (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'))
  const notesRef = useRef([])
  notesRef.current = notes
  const eventsRef = useRef([])
  eventsRef.current = events
  const markSynced = () => setLastSyncAt(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))
  const enableNotif = async () => {
    if (typeof Notification === 'undefined') return
    try {
      const p = await Notification.requestPermission()
      setNotifState(p)
      if (p === 'granted') checkDeadlines(notesRef.current)
    } catch { /* ignore */ }
  }
  const [linkTarget, setLinkTarget] = useState('')
  const [newDimName, setNewDimName] = useState('')
  const [newDimColor, setNewDimColor] = useState('#a1a1aa')
  const [editingDimId, setEditingDimId] = useState(null)
  const knownDims = useRef(new Set(DEFAULT_DIMS.map((d) => d.id)))
  const syncing = useRef(false)
  const autoPushTimer = useRef(null)

  // автопуш в облако через 8 сек после последнего изменения (тихо, без спама статусами)
  const scheduleAutoPush = () => {
    if (!cloudEnabled) return
    if (autoPushTimer.current) clearTimeout(autoPushTimer.current)
    autoPushTimer.current = setTimeout(async () => {
      if (syncing.current || document.visibilityState !== 'visible') return
      syncing.current = true
      try {
        const r = await syncNow()
        if (r.ok) await refresh()
      } finally {
        syncing.current = false
      }
    }, 8000)
  }

  const dimById = useMemo(() => Object.fromEntries(dims.map((d) => [d.id, d])), [dims])

  // setState только если данные реально изменились — иначе каждый автосейв
  // (раз в 400мс печати) дёргал бы ререндер всего дерева новыми массивами
  const setIfChanged = (setter) => (next) => {
    setter((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  }

  const refresh = async () => {
    const [all, al, ac, ap, ad, ae] = await Promise.all([
      db.notes.orderBy('updatedAt').reverse().toArray(),
      db.links.toArray(),
      db.chunks.toArray(),
      db.pixels.toArray(),
      db.dimensions.toArray(),
      db.events.toArray(),
    ])
    setIfChanged(setNotes)(all)
    setIfChanged(setLinks)(al)
    setIfChanged(setChunks)(ac)
    setIfChanged(setPixelRows)(ap)
    setIfChanged(setEvents)(ae)
    if (ad.length) {
      setIfChanged(setDims)(ad)
      // новые измерения включаем автоматически, выбор пользователя не трогаем
      setEnabledDims((prev) => {
        const next = new Set(prev)
        let changed = false
        for (const d of ad) {
          if (!knownDims.current.has(d.id)) { next.add(d.id); knownDims.current.add(d.id); changed = true }
        }
        return changed ? next : prev
      })
    }
    if (!activeId && all.length) setActiveId(all[0].id)
  }

  useEffect(() => {
    ;(async () => {
      await seedIfEmpty()
      await seedDimensions()
      const ad = await db.dimensions.toArray()
      if (ad.length) {
        setDims(ad)
        setEnabledDims(new Set(ad.map((d) => d.id)))
        ad.forEach((d) => knownDims.current.add(d.id))
      }
      const all = await db.notes.toArray()
      await recalcMissed(all)
      await refresh()
      // тихий автосинк при старте, чтобы с другого устройства всё подтянулось само
      if (cloudEnabled) {
        const r = await syncNow({ quiet: true })
        if (r.ok) { await refresh(); markSynced() }
        else setSyncMsg(`Автосинк: ${r.reason}`)
      }
      // ярлык "Новая заметка" с иконки приложения (manifest shortcuts → ?new=1)
      try {
        const q = new URLSearchParams(window.location.search)
        if (q.get('new') === '1') {
          window.history.replaceState({}, '', window.location.pathname)
          await createNote()
        }
      } catch { /* не критично */ }
    })()
  }, [])

  // напоминания о дедлайнах: раз в минуту + через 5 сек после старта
  useEffect(() => {
    const tick = async () => {
      try { await checkDeadlines(notesRef.current) } catch { /* ignore */ }
      try { await checkCalendarEvents(eventsRef.current) } catch { /* ignore */ }
    }
    const id = setInterval(tick, 60000)
    const t = setTimeout(tick, 5000)
    return () => { clearInterval(id); clearTimeout(t) }
  }, [])
  // автосинк при возврате на вкладку (с телефона пришло — на ПК подтянется само)
  // + периодический фоновый опрос, чтобы открытое приложение тоже подтягивало
  const bgSyncRef = useRef(null)
  bgSyncRef.current = async () => {
    if (!cloudEnabled || syncing.current || document.visibilityState !== 'visible') return
    syncing.current = true
    try {
      const r = await syncNow({ quiet: true })
      if (r.ok) { await refresh(); markSynced() }
    } finally {
      syncing.current = false
    }
  }
  useEffect(() => {
    if (!cloudEnabled) return
    const tick = () => bgSyncRef.current?.()
    const id = setInterval(tick, 30000)
    window.addEventListener('online', tick)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(id)
      window.removeEventListener('online', tick)
      window.removeEventListener('focus', tick)
    }
  }, [])
  // + перерасчёт пропущенных дней (день мог смениться без перезагрузки)
  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState !== 'visible' || !cloudEnabled || syncing.current) return
      syncing.current = true
      try {
        const r = await syncNow({ quiet: true })
        const all2 = await db.notes.toArray()
        const t = await recalcMissed(all2)
        if (r.ok || t) await refresh()
        if (r.ok) markSynced()
      } finally {
        syncing.current = false
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const active = useMemo(() => notes.find((n) => n.id === activeId) || null, [notes, activeId])
  const [draft, setDraft] = useState(null)
  useEffect(() => { setDraft(active ? { ...active } : null); setPreview(false); setLinkTarget('') }, [activeId])

  useDebouncedSave(draft, () => { refresh(); scheduleAutoPush() })

  const toggleDim = (id) => {
    setEnabledDims((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // --- измерения: CRUD ---
  const changeDimColor = async (id, color) => {
    setDims((prev) => prev.map((d) => (d.id === id ? { ...d, color } : d)))
    const row = await db.dimensions.get(id)
    if (row) await db.dimensions.put({ ...row, color })
    scheduleAutoPush()
  }
  const renameDimLive = (id, name) => {
    setDims((prev) => prev.map((d) => (d.id === id ? { ...d, name } : d)))
  }
  const saveDimName = async (id) => {
    const row = await db.dimensions.get(id)
    const cur = dims.find((d) => d.id === id)
    if (row && cur && cur.name.trim()) await db.dimensions.put({ ...row, name: cur.name.trim() })
    else if (row && cur) setDims((prev) => prev.map((d) => (d.id === id ? { ...d, name: row.name } : d)))
    scheduleAutoPush()
  }
  const addDim = async () => {
    const name = newDimName.trim()
    if (!name) return
    const id = `d${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
    try {
      await db.dimensions.add({ id, name, color: newDimColor })
    } catch {
      setSyncMsg('Не удалось создать измерение, попробуй ещё раз')
      return
    }
    knownDims.current.add(id)
    setDims((prev) => [...prev, { id, name, color: newDimColor }])
    setEnabledDims((prev) => new Set(prev).add(id))
    setNewDimName('')
    scheduleAutoPush()
  }
  const deleteDim = async (id) => {
    if (dims.length <= 1) return
    const target = dims.find((d) => d.id !== id)
    await db.transaction('rw', [db.notes, db.dimensions], async () => {
      await db.notes.where('dimension').equals(id).modify({ dimension: target.id, updatedAt: Date.now() })
      await db.dimensions.delete(id)
    })
    setDims((prev) => prev.filter((d) => d.id !== id))
    setEnabledDims((prev) => { const n = new Set(prev); n.delete(id); return n })
    if (draft && draft.dimension === id) setDraft({ ...draft, dimension: target.id })
    await refresh()
    scheduleAutoPush()
  }

  const filtered = useMemo(() => notes.filter((n) => enabledDims.has(n.dimension)), [notes, enabledDims])
  const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])

  const createNote = async () => {
    const firstDim = [...enabledDims][0] || dims[0]?.id || 'study'
    const id = await db.notes.add({ title: 'Новая заметка', body: 'дедлайн: ', dimension: firstDim, estimateHours: 0, updatedAt: Date.now() })
    await refresh()
    setActiveId(id)
    setTab('notes')
    scheduleAutoPush()
  }

  const deleteNote = async (id) => {
    await db.transaction('rw', [db.notes, db.links, db.chunks], async () => {
      await db.notes.delete(id)
      await db.links.where('fromId').equals(id).delete()
      await db.links.where('toId').equals(id).delete()
      await db.chunks.where('noteId').equals(id).delete()
    })
    // иначе удалённая заметка "воскреснет" следующим pull, а её cloudId сломает push пикселей по FK
    try {
      const map = await getSetting('cloudIds', {})
      const cid = map[`note:${id}`]
      if (cid && cloud()) await cloud().from('notes').delete().eq('id', cid)
      if (cid) {
        delete map[`note:${id}`]
        await setSetting('cloudIds', map)
      }
    } catch { /* офлайн — облако подчистится следующим pushRest */ }
    if (activeId === id) setActiveId(null)
    await refresh()
    scheduleAutoPush()
  }

  const doSync = async () => {
    if (syncing.current) { setSyncMsg('Синк уже идёт, подожди…'); return }
    syncing.current = true
    setSyncMsg('Синк…')
    try {
      const r = await syncNow()
      setSyncMsg(r.ok ? `Ок: заметок ${r.pulled}, чанков ${r.pulledChunks || 0}, событий ${r.pulledEvents || 0}` : `Ошибка: ${r.reason}`)
      if (r.ok) { await refresh(); markSynced() }
    } finally {
      syncing.current = false
    }
  }

  // явное «Сохранить»: сразу в локальную БД + синк в облако
  const cleanup = async () => {
    if (!confirm('Удалить дубликаты заметок с одинаковым названием? Останется самая свежая.')) return
    const r = await cleanupDuplicates()
    const parts = []
    if (r.removed) parts.push(`дублей убрано: ${r.removed}`)
    if (r.merged) parts.push(`облачных дублей схлопнуто: ${r.merged}`)
    if (r.adopted) parts.push(`подобрано пропущенных: ${r.adopted}`)
    setSyncMsg(parts.length ? `${parts.join(', ')}. Нажми Синк и повтори на втором устройстве.` : 'Дубликатов нет')
    await refresh()
  }
  const saveNow = async () => {
    if (!draft) return
    await db.notes.update(draft.id, {
      title: draft.title, body: draft.body, dimension: draft.dimension,
      estimateHours: Number(draft.estimateHours) || 0, updatedAt: Date.now(),
    })
    await refresh()
    const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    if (!cloudEnabled) {
      setSyncMsg(`Сохранено локально в ${t} (нет ключей Supabase)`)
      return
    }
    if (syncing.current) {
      setSyncMsg(`Сохранено локально в ${t}, синк уже идёт`)
      return
    }
    syncing.current = true
    setSyncMsg('Сохраняю и синкаю…')
    try {
      const r = await syncNow()
      setSyncMsg(r.ok ? `Сохранено и синкнуто в ${t}` : `Сохранено локально в ${t}. Синк: ${r.reason}`)
      if (r.ok) { await refresh(); markSynced() }
    } finally {
      syncing.current = false
    }
  }

  // --- ручные связи ---
  const addLink = async () => {
    if (!draft || !linkTarget) return
    const toId = Number(linkTarget)
    if (!toId || toId === draft.id) return
    const dup = links.some((l) => l.fromId === draft.id && l.toId === toId)
    if (!dup) await db.links.add({ fromId: draft.id, toId })
    setLinkTarget('')
    await refresh()
    scheduleAutoPush()
  }
  const removeLink = async (id) => {
    await db.links.delete(id)
    await refresh()
    scheduleAutoPush()
  }

  // --- чанки ---
  const rebuildPlan = async () => {
    if (!draft) return
    // оценка может прийти из текста («оценка: 6ч») — подтягиваем её и в поле ввода
    const total = Number(draft.estimateHours) || parseEffort(`${draft.title}\n${draft.body}`)
    const patch = {
      title: draft.title, body: draft.body, dimension: draft.dimension,
      estimateHours: total || 0, updatedAt: Date.now(),
    }
    await db.notes.update(draft.id, patch)
    setDraft({ ...draft, ...patch })
    const fresh = await db.notes.get(draft.id)
    const r = await buildPlan(fresh)
    if (!r.ok) setSyncMsg(`План: ${r.reason}`)
    else setSyncMsg('')
    await refresh()
    scheduleAutoPush()
  }
  const onToggleChunk = async (c) => {
    await toggleChunk(c, pixelsLib)
    await refresh()
    scheduleAutoPush()
  }

  // --- календарь ---
  const notesWithDates = useMemo(() => {
    return filtered.flatMap((n) =>
      parseDeadlines(`${n.title}\n${n.body}`).map((dl) => ({ note: n, dl }))
    ).sort((a, b) => a.dl.date - b.dl.date)
  }, [filtered])

  const monthCells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1)
    let startDay = (first.getDay() + 6) % 7 // понедельник = 0
    const cells = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(cursor.y, cursor.m, 1 - startDay + i)
      cells.push(d)
    }
    return cells
  }, [cursor])

  const byDay = useMemo(() => {
    const map = {}
    for (const { note, dl } of notesWithDates) {
      const k = `${dl.date.getFullYear()}-${dl.date.getMonth()}-${dl.date.getDate()}`
      if (!map[k]) map[k] = []
      map[k].push({ note, dl })
    }
    return map
  }, [notesWithDates])

  const chunksByDate = useMemo(() => {
    const map = {}
    for (const c of chunks) {
      if (c.habit) continue // привычки рисуем отдельно
      const n = noteById.get(c.noteId)
      if (!n || !enabledDims.has(n.dimension)) continue
      if (!map[c.date]) map[c.date] = []
      map[c.date].push({ chunk: c, note: n })
    }
    for (const k of Object.keys(map)) map[k].sort((a, b) => a.note.title.localeCompare(b.note.title))
    return map
  }, [chunks, noteById, enabledDims])

  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const focusDay = selectedDay || new Date()
  const focusKey = dayKey(focusDay)
  const focusChunks = chunksByDate[focusKey] || []
  // привычки: чекбокс на каждый день (строка в БД создаётся в день выполнения)
  const habitItems = useMemo(() => filtered.filter(isHabit).map((note) => {
    const row = chunks.find((c) => c.noteId === note.id && c.date === focusKey && c.habit)
    return { chunk: row || { id: `habit-${note.id}`, noteId: note.id, date: focusKey, hours: 0, done: 0, habit: 1 }, note }
  }), [filtered, chunks, focusKey])
  const onToggleHabit = async (noteId, date) => {
    await toggleHabit(noteId, date, pixelsLib)
    await refresh()
    scheduleAutoPush()
  }

  // --- события календаря (день + подпись, без заметок) ---
  const eventsByDate = useMemo(() => {
    const map = {}
    for (const e of events) {
      if (e.deleted) continue
      if (e.dimension && !enabledDims.has(e.dimension)) continue
      if (!map[e.date]) map[e.date] = []
      map[e.date].push(e)
    }
    return map
  }, [events, enabledDims])
  const focusEvents = eventsByDate[focusKey] || []
  const addEvent = async () => {
    const title = evTitle.trim()
    if (!title) return
    const id = `ev${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
    await db.events.add({ id, date: focusKey, title, dimension: evDim || null, deleted: 0, updatedAt: Date.now() })
    setEvTitle('')
    await refresh()
    scheduleAutoPush()
  }
  const deleteEvent = async (id) => {
    // soft-delete: флаг расходится синком и не воскресает
    await db.events.update(id, { deleted: 1, updatedAt: Date.now() })
    await refresh()
    scheduleAutoPush()
  }

  // неделя: Пн–Вс от якоря
  const weekCells = useMemo(() => {
    const a = new Date(weekAnchor)
    const mon = new Date(a)
    mon.setDate(a.getDate() - ((a.getDay() + 6) % 7))
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon)
      d.setDate(mon.getDate() + i)
      return d
    })
  }, [weekAnchor])
  const weekTitle = `${fmtDate(weekCells[0])} – ${fmtDate(weekCells[6])}`
  const cells = calView === 'month' ? monthCells : weekCells
  const stepCal = (dir) => {
    if (calView === 'month') {
      setCursor((c) => {
        let { y, m } = c
        m += dir
        if (m < 0) { m = 11; y-- } else if (m > 11) { m = 0; y++ }
        return { y, m }
      })
    } else {
      setWeekAnchor((a) => { const d = new Date(a); d.setDate(d.getDate() + dir * 7); return d })
    }
  }
  const switchCalView = (v) => {
    setCalView(v)
    if (v === 'week') setWeekAnchor(selectedDay || new Date())
  }

  const today = new Date()
  const monthName = new Date(cursor.y, cursor.m, 1).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })

  const openNote = (id) => { setActiveId(id); setTab('notes'); setMenuOpen(false) }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      {/* top bar */}
      <header className="flex items-center gap-2 px-4 py-2 panel flex-wrap" style={{ borderLeft: 0, borderRight: 0, borderTop: 0 }}>
        <button className="md:hidden text-lg px-1 leading-none" onClick={() => setMenuOpen(true)} title="Меню">☰</button>
        <div className="w-3 h-3 rounded-sm accent-bg" />
        <b>Not</b>
        <span className="opacity-50 text-sm hidden sm:inline">Minimal Dark OS</span>
        <div className="flex-1" />
        {['notes', 'calendar', 'graph', 'map', 'diag'].map((t) => (
          <button
            key={t}
            className="text-sm px-3 py-1 panel rounded"
            style={tab === t ? { borderColor: 'var(--accent)' } : {}}
            onClick={() => setTab(t)}
          >
            {t === 'notes' ? 'Заметки' : t === 'calendar' ? 'Календарь' : t === 'graph' ? 'Граф' : t === 'map' ? 'Карта' : 'Диагностика'}
          </button>
        ))}
        <button onClick={doSync} className="text-sm px-3 py-1 panel rounded" title="Синхронизация с Supabase">
          {cloudEnabled ? 'Синк' : 'Локально'}
        </button>
        {cloudEnabled && lastSyncAt && (
          <span className="text-[11px] opacity-50 hidden sm:inline" title="Последний успешный синк">· {lastSyncAt}</span>
        )}
        <button
          onClick={enableNotif}
          className="text-sm px-3 py-1 panel rounded"
          style={notifState === 'granted' ? { borderColor: 'var(--accent)' } : {}}
          title={notifState === 'granted' ? 'Напоминания о дедлайнах включены' : 'Включить напоминания о дедлайнах'}
        >
          {notifState === 'granted' ? 'Уведомления: вкл' : notifState === 'denied' ? 'Уведомления: блок' : 'Уведомления'}
        </button>
      </header>
      {syncMsg && <div className="text-xs px-4 py-1 opacity-70 border-b" style={{ borderColor: 'var(--border)' }}>{syncMsg}</div>}

      <div className="flex-1 flex min-h-0">
        {/* sidebar (на телефоне — выдвижной) */}
        {menuOpen && <div className="fixed inset-0 z-30 md:hidden" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={() => setMenuOpen(false)} />}
        <aside className={`panel flex flex-col fixed inset-y-0 left-0 z-40 md:static md:z-auto transition-transform ${menuOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`} style={{ width: 300, borderTop: 0, borderBottom: 0, borderLeft: 0 }}>
          <div className="p-3 border-b" style={{ borderColor: 'var(--border)' }}>
            <div className="text-xs uppercase opacity-50 mb-2">Измерения</div>
            {dims.map((d) => (
              <div key={d.id} className="flex items-center gap-2 py-1.5 text-sm">
                <input
                  type="checkbox" checked={enabledDims.has(d.id)} onChange={() => toggleDim(d.id)} title="Показать/скрыть слой"
                  className="w-5 h-5 shrink-0 cursor-pointer"
                />
                <input
                  type="color" value={d.color} title="Цвет измерения"
                  onChange={(e) => changeDimColor(d.id, e.target.value)}
                  style={{ width: 34, height: 28, padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}
                  className="shrink-0"
                />
                {editingDimId === d.id ? (
                  <input
                    autoFocus
                    type="text" value={d.name}
                    onChange={(e) => renameDimLive(d.id, e.target.value)}
                    onBlur={() => { saveDimName(d.id); setEditingDimId(null) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur() }}
                    className="flex-1 min-w-0 rounded px-2 py-1 text-sm"
                  />
                ) : (
                  <button
                    onClick={() => toggleDim(d.id)} title="Нажми, чтобы показать/скрыть слой"
                    className="flex-1 min-w-0 text-left truncate rounded px-2 py-1.5 cursor-pointer select-none"
                    style={enabledDims.has(d.id) ? {} : { opacity: 0.4 }}
                  >
                    {d.name}
                  </button>
                )}
                <button
                  className="opacity-50 hover:opacity-100 px-1 text-sm shrink-0" title="Переименовать"
                  onClick={() => setEditingDimId(editingDimId === d.id ? null : d.id)}
                >✎</button>
                {dims.length > 1 && (
                  <button className="opacity-40 hover:opacity-100 text-xs shrink-0" title="Удалить измерение (заметки перейдут в другое)" onClick={() => deleteDim(d.id)}>✕</button>
                )}
              </div>
            ))}
            <div className="flex items-center gap-2 mt-2">
              <input
                type="color" value={newDimColor}
                onChange={(e) => setNewDimColor(e.target.value)}
                style={{ width: 26, height: 20, padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}
              />
              <input
                type="text" value={newDimName} placeholder="Новое измерение…"
                onChange={(e) => setNewDimName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addDim() }}
                className="flex-1 min-w-0 rounded px-2 py-1 text-sm"
              />
              <button onClick={addDim} className="px-2 py-1 rounded panel text-sm">+</button>
            </div>
            <button onClick={createNote} className="mt-3 w-full text-sm py-1.5 rounded accent-bg text-black font-semibold">+ Новая заметка</button>
            <button onClick={cleanup} className="mt-2 w-full text-xs py-1 rounded panel opacity-70" title="Удалить заметки-дубликаты с одинаковым названием">Убрать дубликаты</button>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {filtered.map((n) => {
              const dl = firstDeadline(`${n.title}\n${n.body}`)
              const dim = dimById[n.dimension]
              const plan = chunks.filter((c) => c.noteId === n.id)
              const doneH = plan.filter((c) => c.done).reduce((s, c) => s + c.hours, 0)
              const totH = plan.reduce((s, c) => s + c.hours, 0)
              return (
                <div
                  key={n.id}
                  onClick={() => openNote(n.id)}
                  className="p-2 mb-1 rounded cursor-pointer panel"
                  style={n.id === activeId ? { borderColor: 'var(--accent)' } : {}}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-sm" style={{ background: dim?.color }} />
                    <b className="text-sm truncate flex-1">{n.title || 'Без названия'}</b>
                    <button className="opacity-40 hover:opacity-100 text-xs" onClick={(e) => { e.stopPropagation(); deleteNote(n.id) }}>✕</button>
                  </div>
                  <div className="text-xs opacity-50 truncate mt-0.5">{(n.body || '').slice(0, 80)}</div>
                  {dl && (
                    <div className="text-xs mt-1 danger-text">
                      дедлайн {fmtDate(dl.date)} · осталось {Math.ceil((dl.date - today) / 86400000)} дн.
                    </div>
                  )}
                  {totH > 0 && <div className="text-xs mt-0.5 opacity-60">план {f1(doneH)}/{f1(totH)} ч.</div>}
                </div>
              )
            })}
            {filtered.length === 0 && <div className="text-sm opacity-50 p-2">Нет заметок. Включи измерения или создай новую.</div>}
          </div>
        </aside>

        {/* main */}
        <main className="flex-1 min-w-0 p-4 overflow-auto">
          {tab === 'notes' ? (
            !draft ? (
              <div className="opacity-50">Выбери заметку слева или создай новую.</div>
            ) : (
              <div className="max-w-3xl mx-auto">
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  className="w-full text-xl font-bold px-3 py-2 rounded mb-2"
                />
                <div className="flex items-center gap-2 mb-3 text-sm flex-wrap">
                  {dims.filter((d) => enabledDims.has(d.id)).map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setDraft({ ...draft, dimension: d.id })}
                      aria-pressed={draft.dimension === d.id}
                      className="px-3 py-2 rounded panel flex items-center gap-2 cursor-pointer select-none"
                      style={draft.dimension === d.id
                        ? { borderColor: d.color, background: d.color + '22', fontWeight: 700 }
                        : {}}
                    >
                      <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: d.color }} />{d.name}
                    </button>
                  ))}
                  <div className="flex-1" />
                  <button onClick={saveNow} className="px-4 py-1 rounded accent-bg text-black font-semibold text-sm">
                    Сохранить
                  </button>
                  <button onClick={() => setPreview(!preview)} className="px-3 py-1 rounded panel text-sm">
                    {preview ? 'Редактировать' : 'Превью'}
                  </button>
                </div>

                {preview ? (
                  <div className="panel rounded p-4 md">
                    <ReactMarkdown>{draft.body}</ReactMarkdown>
                  </div>
                ) : (
                  <textarea
                    value={draft.body}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    rows={12}
                    className="w-full rounded p-3 font-mono text-sm"
                    placeholder={'# Заголовок\n\n- [ ] задача\n\nСвязь: [[Другая заметка]]\n\nдедлайн: 30.09'}
                  />
                )}

                {(() => {
                  const tasks = getTasks(draft.body)
                  if (!tasks.length) return null
                  return (
                    <div className="panel rounded p-3 mt-3">
                      <div className="text-xs uppercase opacity-50 mb-2">Задачи ({tasks.filter((t) => t.checked).length}/{tasks.length})</div>
                      {tasks.map((t) => (
                        <label key={t.idx} className="flex items-center gap-2 text-sm py-0.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={t.checked}
                            onChange={() => setDraft({ ...draft, body: toggleTaskLine(draft.body, t.idx) })}
                          />
                          <span style={t.checked ? { textDecoration: 'line-through', opacity: 0.5 } : {}}>{t.text}</span>
                        </label>
                      ))}
                    </div>
                  )
                })()}

                {/* оценка + чанки */}
                <div className="panel rounded p-3 mt-3">
                  <div className="text-xs uppercase opacity-50 mb-2">План (auto-chunking)</div>
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <label className="flex items-center gap-1">
                      Оценка, ч:
                      <input
                        type="number" min="0" step="0.5"
                        value={draft.estimateHours ?? 0}
                        onChange={(e) => setDraft({ ...draft, estimateHours: parseFloat(e.target.value) || 0 })}
                        className="w-20 rounded px-2 py-1"
                      />
                    </label>
                    <button onClick={rebuildPlan} className="px-3 py-1 rounded accent-bg text-black font-semibold text-sm">
                      Разбить на чанки
                    </button>
                    <span className="text-xs opacity-50">трудоёмкость / дни до дедлайна</span>
                  </div>
                  <div className="text-xs opacity-40 mt-1">Привычка: напиши «ежедневно» — чекбокс появится на каждый день.</div>
                  {chunks.filter((c) => c.noteId === draft.id && !c.habit).length > 0 && (
                    <div className="mt-2">
                      {chunks.filter((c) => c.noteId === draft.id && !c.habit).sort((a, b) => a.date < b.date ? -1 : 1).map((c) => (
                        <label key={c.id} className="flex items-center gap-2 text-sm py-0.5 cursor-pointer">
                          <input type="checkbox" checked={!!c.done} onChange={() => onToggleChunk(c)} />
                          <span className="opacity-60 text-xs">{c.date}</span>
                          <span style={c.done ? { textDecoration: 'line-through', opacity: 0.5 } : {}}>{c.hours} ч.</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                {/* связи */}
                <div className="panel rounded p-3 mt-3">
                  <div className="text-xs uppercase opacity-50 mb-2">Связи</div>
                  {parseWikiLinks(`${draft.title}\n${draft.body}`).map((name) => {
                    const t = notes.find((n) => (n.title || '').trim().toLowerCase() === name.toLowerCase())
                    return t ? (
                      <div key={name} className="flex items-center gap-2 text-sm py-0.5">
                        <span className="w-2 h-2 rounded-sm" style={{ background: dimById[t.dimension]?.color }} />
                        <span>[[{name}]]</span>
                        <button className="text-xs underline opacity-60" onClick={() => openNote(t.id)}>открыть</button>
                      </div>
                    ) : (
                      <div key={name} className="text-sm py-0.5 opacity-40">[[{name}]] — нет такой заметки</div>
                    )
                  })}
                  {links.filter((l) => l.fromId === draft.id).map((l) => {
                    const t = noteById.get(l.toId)
                    if (!t) return null
                    return (
                      <div key={l.id} className="flex items-center gap-2 text-sm py-0.5">
                        <span className="text-xs opacity-50">ручная →</span>
                        <b>{t.title}</b>
                        <button className="text-xs underline opacity-60" onClick={() => openNote(t.id)}>открыть</button>
                        <button className="text-xs opacity-40 hover:opacity-100" onClick={() => removeLink(l.id)}>✕</button>
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-2 mt-2">
                    <select value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)} className="flex-1 rounded px-2 py-1 text-sm">
                      <option value="">+ ручная связь…</option>
                      {notes.filter((n) => n.id !== draft.id).map((n) => (
                        <option key={n.id} value={n.id}>{n.title || 'Без названия'}</option>
                      ))}
                    </select>
                    <button onClick={addLink} className="px-3 py-1 rounded panel text-sm">Связать</button>
                  </div>
                  <div className="text-xs opacity-40 mt-2">Авто-связи: напиши [[Название заметки]] в тексте.</div>
                </div>

                {(() => {
                  const dls = parseDeadlines(`${draft.title}\n${draft.body}`)
                  if (!dls.length) return <div className="text-xs opacity-40 mt-2">Подсказка: напиши «дедлайн: 30.09» — дата появится в календаре.</div>
                  return (
                    <div className="text-xs mt-2 danger-text">
                      Найдено дат: {dls.map((d) => fmtDate(d.date)).join(', ')}
                    </div>
                  )
                })()}
              </div>
            )
          ) : tab === 'calendar' ? (
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <button className="panel rounded px-2 py-1 text-sm" onClick={() => stepCal(-1)}>←</button>
                <b className="capitalize">{calView === 'month' ? monthName : `Неделя ${weekTitle}`}</b>
                <button className="panel rounded px-2 py-1 text-sm" onClick={() => stepCal(1)}>→</button>
                <div className="flex-1" />
                <button className="text-xs px-2 py-1 rounded panel" style={calView === 'month' ? { borderColor: 'var(--accent)' } : {}} onClick={() => switchCalView('month')}>Месяц</button>
                <button className="text-xs px-2 py-1 rounded panel" style={calView === 'week' ? { borderColor: 'var(--accent)' } : {}} onClick={() => switchCalView('week')}>Неделя</button>
              </div>
              <div className="text-xs opacity-50 mb-2">даты из текста: «дедлайн: 30.09», «завтра», «в пятницу»</div>
              <div className="grid grid-cols-7 gap-1 text-xs opacity-50 mb-1">
                {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => <div key={d} className="text-center">{d}</div>)}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {cells.map((d, i) => {
                  const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
                  const items = byDay[k] || []
                  const dayChunks = chunksByDate[dayKey(d)] || []
                  const leftH = dayChunks.filter((x) => !x.chunk.done).reduce((s, x) => s + x.chunk.hours, 0)
                  const dayEvents = eventsByDate[dayKey(d)] || []
                  const inMonth = calView === 'month' ? d.getMonth() === cursor.m : true
                  const isToday = d.toDateString() === today.toDateString()
                  return (
                    <div
                      key={i}
                      onClick={() => setSelectedDay(d)}
                      className="panel rounded p-1 min-h-[64px] cursor-pointer"
                      style={{
                        opacity: inMonth ? 1 : 0.35,
                        borderColor: selectedDay?.toDateString() === d.toDateString() ? 'var(--accent)' : undefined,
                      }}
                    >
                      <div className="text-xs" style={isToday ? { color: 'var(--accent)', fontWeight: 700 } : {}}>{d.getDate()}</div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {items.slice(0, 4).map(({ note }, j) => (
                          <span key={j} title={note.title} className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: dimById[note.dimension]?.color }} />
                        ))}
                      </div>
                      {leftH > 0 && <div className="text-[10px] opacity-70">{f1(leftH)} ч.</div>}
                      {dayEvents.length > 0 && (
                        <div className="text-[10px] opacity-90 truncate" title={dayEvents.map((e) => e.title).join(', ')}>
                          <span className="inline-block w-1.5 h-1.5 rounded-full mr-1" style={{ background: dimById[dayEvents[0].dimension]?.color || 'var(--accent)' }} />
                          {dayEvents[0].title}{dayEvents.length > 1 ? ` +${dayEvents.length - 1}` : ''}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="panel rounded p-3 mt-4">
                <div className="text-xs uppercase opacity-50 mb-2">
                  {selectedDay ? `На ${fmtDate(selectedDay)}` : 'Ближайшие дедлайны'}
                </div>
                {(selectedDay
                  ? (byDay[`${selectedDay.getFullYear()}-${selectedDay.getMonth()}-${selectedDay.getDate()}`] || [])
                  : notesWithDates.slice(0, 10)
                ).map(({ note, dl }, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm py-1 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: dimById[note.dimension]?.color }} />
                    <b>{note.title}</b>
                    <span className="opacity-50 text-xs">{dimById[note.dimension]?.name}</span>
                    <span className="flex-1" />
                    <span className="danger-text text-xs">{fmtDate(dl.date)} · {Math.ceil((dl.date - today) / 86400000)} дн.</span>
                    <button className="text-xs underline opacity-60" onClick={() => openNote(note.id)}>открыть</button>
                  </div>
                ))}
              </div>

              <div className="panel rounded p-3 mt-4">
                <div className="text-xs uppercase opacity-50 mb-2">Чанки и привычки: {fmtDate(focusDay)} (выполненные открывают пиксели)</div>
                {focusChunks.length === 0 && habitItems.length === 0 && <div className="text-sm opacity-50">На этот день чанков нет.</div>}
                {focusChunks.map(({ chunk, note }) => {
                  const overdue = chunk.date < todayISO() && !chunk.done
                  return (
                    <label key={chunk.id} className="flex items-center gap-2 text-sm py-1 cursor-pointer border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                      <input type="checkbox" checked={!!chunk.done} onChange={() => onToggleChunk(chunk)} />
                      <span className="w-2 h-2 rounded-sm" style={{ background: dimById[note.dimension]?.color }} />
                      <b>{note.title}</b>
                      <span className="flex-1" />
                      <span className={overdue ? 'danger-text text-xs' : 'text-xs opacity-60'}>
                        {chunk.hours} ч.{overdue ? ' · пропуск, часы перераспределены' : ''}
                      </span>
                    </label>
                  )
                })}
                {habitItems.map(({ chunk, note }) => (
                  <label key={chunk.id} className="flex items-center gap-2 text-sm py-1 cursor-pointer border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                    <input type="checkbox" checked={!!chunk.done} onChange={() => onToggleHabit(note.id, focusKey)} />
                    <span className="w-2 h-2 rounded-sm" style={{ background: dimById[note.dimension]?.color }} />
                    <b>{note.title}</b>
                    <span className="flex-1" />
                    <span className="text-xs opacity-60">привычка · ежедневно</span>
                  </label>
                ))}
              </div>

              <div className="panel rounded p-3 mt-4">
                <div className="text-xs uppercase opacity-50 mb-2">События: {fmtDate(focusDay)} (без заметок)</div>
                {focusEvents.length === 0 && <div className="text-sm opacity-50">На этот день ничего не запланировано.</div>}
                {focusEvents.map((e) => (
                  <div key={e.id} className="flex items-center gap-2 text-sm py-1 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                    <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: dimById[e.dimension]?.color || 'var(--accent)' }} />
                    <span className="flex-1 truncate">{e.title}</span>
                    <button className="text-xs opacity-40 hover:opacity-100 shrink-0" onClick={() => deleteEvent(e.id)}>✕</button>
                  </div>
                ))}
                <div className="flex items-center gap-2 mt-2">
                  <select value={evDim} onChange={(e) => setEvDim(e.target.value)} className="rounded px-1 py-1 text-sm shrink-0" title="Цвет события">
                    <option value="">•</option>
                    {dims.filter((d) => enabledDims.has(d.id)).map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                  <input
                    type="text" value={evTitle} placeholder="Уборка…"
                    onChange={(e) => setEvTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addEvent() }}
                    className="flex-1 min-w-0 rounded px-2 py-1 text-sm"
                  />
                  <button onClick={addEvent} className="px-3 py-1 rounded accent-bg text-black font-semibold text-sm shrink-0">+</button>
                </div>
                <div className="text-xs opacity-40 mt-1">Кликни день в сетке — и подпиши его здесь.</div>
              </div>
            </div>
          ) : tab === 'graph' ? (
            <div className="h-full" style={{ minHeight: 480 }}>
              <GraphView
                notes={notes} manualLinks={links} dims={dims} enabledDims={enabledDims}
                activeId={activeId} onSelect={setActiveId} onOpen={openNote}
              />
            </div>
          ) : tab === 'map' ? (
            <MapView pixelRows={pixelRows} accent="#d1d5db" />
          ) : (
            <div className="max-w-3xl mx-auto">
              <SyncDiag onSynced={refresh} />
            </div>
          )}
        </main>
      </div>

      {/* mobile bottom bar */}
      <div className="md:hidden panel flex" style={{ borderLeft: 0, borderRight: 0, borderBottom: 0 }}>
        <div className="flex-1 overflow-auto flex gap-1 p-2">
          {filtered.map((n) => (
            <button key={n.id} onClick={() => openNote(n.id)} className="text-xs px-2 py-1 rounded panel whitespace-nowrap" style={n.id === activeId ? { borderColor: 'var(--accent)' } : {}}>
              {(dimById[n.dimension]?.name || '')[0]} · {(n.title || '').slice(0, 12)}
            </button>
          ))}
        </div>
        <button onClick={createNote} className="m-2 px-3 rounded accent-bg text-black font-bold">+</button>
      </div>
    </div>
  )
}
