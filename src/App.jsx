import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  db,
  DIMENSIONS as DEFAULT_DIMS,
  openProfileDb,
  seedDimensions,
  normalizeDimensions,
  getSetting,
  setSetting,
  listNotes,
  sortNotes,
  normalizeNote,
  togglePin,
  createNote as createNoteRow,
  updateNote,
  deleteNoteDeep,
  addEvent as addEventRow,
  toggleEventPin,
  deleteEvent as deleteEventRow,
} from './lib/db.js'
import { parseDeadlines, firstDeadline, fmtDate } from './lib/dates.js'
import { parseWikiLinks } from './lib/links.js'
import { buildPlan, recalcMissed, toggleChunk, toggleHabit, todayISO, isHabit, parseEffort } from './lib/chunks.js'
import * as pixelsLib from './lib/pixels.js'
import { cloudEnabled, syncNow, cleanupDuplicates, authSession } from './lib/cloud.js'
import { CLOUD, currentAccount, createAccount, loginAccount, logoutAccount, hasAccounts } from './lib/auth.js'
import MapView from './components/MapView.jsx'
import DrawLayer from './components/DrawLayer.jsx'
import EventModal from './components/EventModal.jsx'
import NoteCard from './components/NoteCard.jsx'
import { computeShift } from './lib/textshift.js'
import { makeNoteCache } from './lib/noteindex.js'

// тяжёлое грузим отдельными кусками: первый экран открывается быстрее
const GraphView = lazy(() => import('./components/GraphView.jsx'))
const SyncDiag = lazy(() => import('./components/SyncDiag.jsx'))
const CanvasBoard = lazy(() => import('./components/CanvasBoard.jsx'))
const ReactMarkdown = lazy(() => import('react-markdown'))
import { useViewportShift, useCoarsePointer } from './hooks/tablet.js'
import { checkDeadlines, checkCalendarEvents, notifyDigest } from './lib/notify.js'

function getTasks(body) {
  return (body || '')
    .split('\n')
    .map((line, idx) => {
      const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(.*)$/)
      return m ? { idx, checked: m[1].toLowerCase() === 'x', text: m[2] } : null
    })
    .filter(Boolean)
}

function toggleTaskLine(body, lineIdx) {
  const lines = (body || '').split('\n')
  const line = lines[lineIdx]
  if (!line) return body
  if (line.includes('[ ]')) lines[lineIdx] = line.replace('[ ]', '[x]')
  else if (/\[x\]/i.test(line)) lines[lineIdx] = line.replace(/\[x\]/i, '[ ]')
  return lines.join('\n')
}

// суммы часов без мусора типа 0.30000000000000004
const f1 = (x) => Math.round(x * 10) / 10

// превью очень длинной заметки: markdown-разбор 200 КБ текста подвешивает
// планшет, поэтому показываем начало (текст и сохранение — целиком)
const PREVIEW_LIMIT = 40000

const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// измерения всегда в одном порядке: Я, Учёба, Работа, дальше — остальные
const DIM_ORDER = DEFAULT_DIMS.map((d) => d.id)
const sortDims = (list) =>
  [...list].sort((a, b) => {
    const ia = DIM_ORDER.indexOf(a.id)
    const ib = DIM_ORDER.indexOf(b.id)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })

// дешёвая подпись состояния списка: перерисовываем только при реальных изменениях
const notesSig = (arr) =>
  arr
    .map(
      (n) =>
        `${n.id}:${n.updatedAt}:${n.is_pinned}:${n.note_type}:${n.dimension}:${(n.title || '').length}:${(n.body || '').length}`
    )
    .join(',')

// черновик совпадает с тем, что уже в базе? (чтобы не дёргать updatedAt зря)
function sameContent(a, b) {
  if (!a || !b) return false
  if (
    a.title !== b.title ||
    a.body !== b.body ||
    a.dimension !== b.dimension ||
    (Number(a.estimateHours) || 0) !== (Number(b.estimateHours) || 0) ||
    (a.note_type || 'text') !== (b.note_type || 'text')
  )
    return false
  if (a.canvas_data === b.canvas_data && a.draw_data === b.draw_data) return true
  return (
    JSON.stringify(a.canvas_data || null) === JSON.stringify(b.canvas_data || null) &&
    JSON.stringify(a.draw_data || null) === JSON.stringify(b.draw_data || null)
  )
}

export default function App() {
  const [notes, setNotes] = useState([])
  const [links, setLinks] = useState([])
  const [chunks, setChunks] = useState([])
  const [pixelRows, setPixelRows] = useState([])
  const [events, setEvents] = useState([])
  const [dims, setDims] = useState(DEFAULT_DIMS)

  const [evTitle, setEvTitle] = useState('')
  const [evDim, setEvDim] = useState('')
  const [activeId, setActiveId] = useState(null)
  const [enabledDims, setEnabledDims] = useState(new Set(DEFAULT_DIMS.map((d) => d.id)))
  const [menuOpen, setMenuOpen] = useState(false)
  const [tab, setTab] = useState('notes') // notes | calendar | graph | map | diag
  const [preview, setPreview] = useState(false)
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [listLimit, setListLimit] = useState(60)
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  const [selectedDay, setSelectedDay] = useState(null)
  const [calView, setCalView] = useState('month')
  const [weekAnchor, setWeekAnchor] = useState(() => new Date())
  const [syncMsg, setSyncMsg] = useState('')
  // Аккаунт обязателен: у каждого своя база, поэтому без входа не видно ничего.
  const [account, setAccount] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authNotice, setAuthNotice] = useState('')
  const [authMode, setAuthMode] = useState('in') // 'in' | 'up'
  const [authEmail, setAuthEmail] = useState('')
  const [authPass, setAuthPass] = useState('')
  const [anyAccount, setAnyAccount] = useState(true)
  const [lastSyncAt, setLastSyncAt] = useState('')
  const [notifState, setNotifState] = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  )

  // --- планшет/стилус ---
  const [hwMode, setHwMode] = useState(false)
  const [drawMode, setDrawMode] = useState(false)
  const [graphDim, setGraphDim] = useState('all') // 'all' или id измерения
  const [graphPos, setGraphPos] = useState({}) // { [scope]: { 'note:1': [x, y] } }
  const [graphDraw, setGraphDraw] = useState({}) // { [scope]: { version, elements } }
  const [evModalDay, setEvModalDay] = useState(null)
  const bodyRef = useViewportShift()
  const drawRef = useRef(null)
  const measureRef = useRef(null)
  const coarse = useCoarsePointer()

  const [draft, setDraft] = useState(null)
  const [linkTarget, setLinkTarget] = useState('')
  const [editingDimId, setEditingDimId] = useState(null)

  const notesRef = useRef([])
  // производные данные (поисковый текст, дедлайны) считаются один раз
  // на версию заметки, а не заново по всему списку на каждый рендер
  const noteCacheRef = useRef(null)
  if (!noteCacheRef.current) noteCacheRef.current = makeNoteCache()
  const searchOf = (n) =>
    noteCacheRef.current(n, 'search', (x) => `${x.title || ''}\n${x.body || ''}`.toLowerCase())
  const deadlinesOf = (n) =>
    noteCacheRef.current(n, 'deadlines', (x) => parseDeadlines(`${x.title || ''}\n${x.body || ''}`))
  notesRef.current = notes
  const eventsRef = useRef([])
  eventsRef.current = events
  const notesSigRef = useRef('')
  const knownDims = useRef(new Set(DEFAULT_DIMS.map((d) => d.id)))
  const syncing = useRef(false)
  const autoPushTimer = useRef(null)

  const markSynced = () =>
    setLastSyncAt(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))

  // ---------- загрузка / обновление ----------

  const applyNotes = (arr) => {
    const s = notesSig(arr)
    if (s === notesSigRef.current) return
    notesSigRef.current = s
    setNotes(arr)
  }

  // Точечное обновление одной заметки. После каждой правки refresh() читал
  // из IndexedDB ВСЕ заметки с полными текстами — на 300 заметках по 50 КБ
  // это десятки мегабайт на одно нажатие. Теперь обновляем только изменённую.
  const patchNote = (row) => {
    if (!row) return
    const next = normalizeNote(row)
    const arr = notesRef.current.slice()
    const i = arr.findIndex((n) => n.id === next.id)
    if (i < 0) arr.push(next)
    else arr[i] = next
    const sorted = sortNotes(arr)
    notesSigRef.current = notesSig(sorted)
    setNotes(sorted)
  }

  const setIfChanged = (setter) => (next) => {
    setter((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  }

  const refresh = async () => {
    const [all, al, ac, ap, ad, ae] = await Promise.all([
      listNotes(),
      db.links.toArray(),
      db.chunks.toArray(),
      db.pixels.toArray(),
      db.dimensions.toArray(),
      db.events.toArray(),
    ])
    applyNotes(all)
    setIfChanged(setLinks)(al)
    setIfChanged(setChunks)(ac)
    setIfChanged(setPixelRows)(ap)
    setIfChanged(setEvents)(ae)
    if (ad.length) {
      setIfChanged(setDims)(sortDims(ad))
      setEnabledDims((prev) => {
        const next = new Set(prev)
        let changed = false
        for (const d of ad) {
          if (!knownDims.current.has(d.id)) {
            next.add(d.id)
            knownDims.current.add(d.id)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
    return all
  }

  // автопуш в облако через 8 сек после последнего изменения (тихо, без спама статусами)
  const scheduleAutoPush = () => {
    if (!cloudEnabled) return
    if (autoPushTimer.current) clearTimeout(autoPushTimer.current)
    autoPushTimer.current = setTimeout(async () => {
      if (syncing.current || document.visibilityState !== 'visible') return
      syncing.current = true
      try {
        const r = await syncNow({ quiet: true })
        if (r.ok) await refresh()
        // тихо: не выкидываем человека из редактора, но причину показываем
        else if (r.needLogin) setSyncMsg(r.reason)
      } finally {
        syncing.current = false
      }
    }, 8000)
  }

  const enableNotif = async () => {
    if (typeof Notification === 'undefined') return
    try {
      const p = await Notification.requestPermission()
      setNotifState(p)
      if (p === 'granted') checkDeadlines(notesRef.current)
    } catch {
      /* ignore */
    }
  }

  // Загрузка данных текущего аккаунта: вызывается при старте (если сессия есть)
  // и сразу после входа.
  const initData = async () => {
    await seedDimensions()
    await normalizeDimensions()
    const ad = sortDims(await db.dimensions.toArray())
    if (ad.length) {
      setDims(ad)
      setEnabledDims(new Set(ad.map((d) => d.id)))
      ad.forEach((d) => knownDims.current.add(d.id))
    }
    // граф: сохранённое измерение, позиции узлов и рисунок
    const rawPos = await getSetting('graphPos', {})
    const firstPos = Object.values(rawPos || {})[0]
    setGraphPos(Array.isArray(firstPos) ? { all: rawPos } : rawPos || {})
    const rawDraw = await getSetting('graphDraw', {})
    setGraphDraw(Array.isArray(rawDraw?.elements) ? { all: rawDraw } : rawDraw || {})
    const savedDim = await getSetting('graphDim', 'all')
    if (typeof savedDim === 'string' && savedDim) setGraphDim(savedDim)

    const all = (await db.notes.toArray()).filter((n) => !n.deleted)
    await recalcMissed(all)
    const freshNotes = await refresh()
    // браузер не будит закрытое приложение — показываем накопившееся при запуске
    try {
      const freshEvents = (await db.events.toArray()).filter((e) => !e.deleted)
      await notifyDigest(freshNotes, freshEvents)
    } catch {
      /* уведомления не критичны */
    }
    // облако (если когда-нибудь настроят ключи) требует отдельного входа
    if (cloudEnabled) {
      const started = await authSession()
      if (started) {
        const r = await syncNow({ quiet: true })
        if (r.ok) {
          await normalizeDimensions()
          await refresh()
          markSynced()
        } else if (r.needLogin) {
          // вход протух: показываем форму входа, а не сырую ошибку базы
          setSyncMsg(r.reason)
          offerLogin(r.reason)
          return
        }
      }
    }
    // ярлык «Новая заметка» с иконки приложения (manifest shortcut → ?new=1)
    try {
      const q = new URLSearchParams(window.location.search)
      if (q.get('new') === '1') {
        window.history.replaceState({}, '', window.location.pathname)
        const id = await createNoteRow({ title: 'Новая заметка', body: 'дедлайн: ' })
        await refresh()
        setActiveId(id)
      }
    } catch {
      /* не критично */
    }
  }

  // Старт: есть ли аккаунт на устройстве и сохранённая сессия
  useEffect(() => {
    ;(async () => {
      const any = await hasAccounts()
      setAnyAccount(any)
      const acc = await currentAccount()
      if (!acc) {
        setAuthChecked(true)
        return
      }
      await openProfileDb(acc.dbName)
      setAccount(acc)
      setAuthChecked(true)
      await initData()
    })()
  }, [])

  const doAuth = async () => {
    setAuthBusy(true)
    setAuthError('')
    setAuthNotice('')
    try {
      // на первом запуске аккаунтов нет — сразу создаём, иначе входим
      const creating = !anyAccount || authMode === 'up'
      const res = creating
        ? await createAccount(authEmail, authPass)
        : await loginAccount(authEmail, authPass)
      if (res && res.needsConfirm) {
        setAuthNotice('Аккаунт создан. Подтверди почту по ссылке из письма и войди.')
        return
      }
      const acc = res
      await openProfileDb(acc.dbName)
      setAccount(acc)
      setAnyAccount(true)
      setAuthPass('')
      await initData()
    } catch (e) {
      setAuthError(e.message)
    } finally {
      setAuthBusy(false)
    }
  }

  const doSignOut = async () => {
    await logoutAccount()
    setAccount(null)
    setAuthMode('in')
    setAuthError('')
    setAuthNotice('')
    setAuthEmail('')
    setAuthPass('')
    // состояние чистим, чтобы заметки одного аккаунта не мелькали в другом
    setNotes([])
    notesSigRef.current = ''
    setActiveId(null)
    setDraft(null)
    setDims([])
    setEnabledDims(new Set())
    knownDims.current = new Set()
    setEvents([])
    setLinks([])
    setChunks([])
    setPixelRows([])
    setSyncMsg('')
  }

  // напоминания: раз в минуту + через 5 сек после старта
  useEffect(() => {
    const tick = async () => {
      try {
        await checkDeadlines(notesRef.current)
      } catch {
        /* ignore */
      }
      try {
        await checkCalendarEvents(eventsRef.current)
      } catch {
        /* ignore */
      }
    }
    const id = setInterval(tick, 60000)
    const t = setTimeout(tick, 5000)
    return () => {
      clearInterval(id)
      clearTimeout(t)
    }
  }, [])

  // автосинк при возврате на вкладку + периодический фоновый опрос
  const bgSyncRef = useRef(null)
  bgSyncRef.current = async () => {
    if (!cloudEnabled || syncing.current || document.visibilityState !== 'visible') return
    syncing.current = true
    try {
      const r = await syncNow({ quiet: true })
      if (r.ok) {
        await refresh()
        markSynced()
      } else if (r.needLogin) {
        setSyncMsg(r.reason)
      }
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

  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState !== 'visible' || !cloudEnabled || syncing.current) return
      syncing.current = true
      try {
        const r = await syncNow({ quiet: true })
        const all2 = (await db.notes.toArray()).filter((n) => !n.deleted)
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

  // поиск с небольшой задержкой: не фильтруем список на каждую букву
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(queryInput)
      setListLimit(60)
    }, 200)
    return () => clearTimeout(t)
  }, [queryInput])

  const active = useMemo(() => notes.find((n) => n.id === activeId) || null, [notes, activeId])

  // задачи и даты открытой заметки: считаем при изменении текста, а не на
  // каждый рендер (иначе большая заметка пересканируется на каждое движение)
  const draftTasks = useMemo(() => (draft ? getTasks(draft.body) : []), [draft?.body])
  const draftDates = useMemo(
    () => (draft ? parseDeadlines(`${draft.title || ''}\n${draft.body || ''}`) : []),
    [draft?.title, draft?.body]
  )

  useEffect(() => {
    setDraft(active ? { ...active } : null)
    setPreview(false)
    setDrawMode(false)
    setLinkTarget('')
  }, [activeId])

  // textarea растягивается под текст: рисунок поверх привязан к странице,
  // а не к внутренней прокрутке поля
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const apply = () => {
      el.style.height = 'auto'
      el.style.height = `${Math.max(240, el.scrollHeight)}px`
    }
    // на большой заметке пересчёт высоты — это полный reflow поля, поэтому
    // делаем его не чаще одного раза за кадр
    if (typeof requestAnimationFrame !== 'function') {
      apply()
      return
    }
    const raf = requestAnimationFrame(apply)
    return () => cancelAnimationFrame(raf)
  }, [draft?.body, draft?.id, hwMode, preview, drawMode])

  // сколько пикселей занимает текст до позиции idx (с учётом переносов строк):
  // меряем скрытым div с теми же стилями, что у textarea
  const measureY = (text, idx) => {
    const ta = bodyRef.current
    if (!ta) return 0
    let el = measureRef.current
    if (!el) {
      el = document.createElement('div')
      el.setAttribute('aria-hidden', 'true')
      document.body.appendChild(el)
      measureRef.current = el
    }
    const cs = getComputedStyle(ta)
    el.style.position = 'absolute'
    el.style.left = '-9999px'
    el.style.top = '0'
    el.style.visibility = 'hidden'
    el.style.pointerEvents = 'none'
    el.style.whiteSpace = 'pre-wrap'
    el.style.overflowWrap = 'break-word'
    el.style.fontFamily = cs.fontFamily
    el.style.fontSize = cs.fontSize
    el.style.lineHeight = cs.lineHeight
    el.style.letterSpacing = cs.letterSpacing
    el.style.padding = cs.padding
    el.style.boxSizing = cs.boxSizing
    el.style.width = `${ta.clientWidth}px`
    el.textContent = text.slice(0, idx) + '\u200b'
    return el.scrollHeight
  }

  // правка текста: если что-то изменилось ВЫШЕ рисунка — двигаем штрихи,
  // чтобы они остались привязанными к своим строкам
  const handleBodyChange = (next) => {
    if (!draft) return
    // замеры раскладки (три полных прохода по тексту) нужны только когда
    // на заметке реально что-то нарисовано — в обычной заметке их пропускаем
    const hasStrokes = (draft.draw_data?.elements?.length || 0) > 0
    if (hasStrokes) {
      const shift = computeShift(draft.body, next, measureY)
      if (shift) drawRef.current?.shift(shift.fromY, shift.deltaY)
    }
    setDraft({ ...draft, body: next })
  }

  // автосохранение черновика (текст и холст — одинаково).
  // Перед записью сверяемся с базой: открытие заметки не должно менять updatedAt
  // и поднимать её в списке «самых свежих».
  useEffect(() => {
    if (!draft) return
    const cur = notesRef.current.find((n) => n.id === draft.id)
    if (cur && sameContent(cur, draft)) return
    const t = setTimeout(async () => {
      const saved = await updateNote(draft.id, {
        title: draft.title,
        body: draft.body,
        dimension: draft.dimension,
        estimateHours: Number(draft.estimateHours) || 0,
        note_type: draft.note_type === 'canvas' ? 'canvas' : 'text',
        canvas_data: draft.canvas_data || null,
        draw_data: draft.draw_data || null,
      })
      // список, календарь и граф берут данные из состояния: полный refresh
      // здесь не нужен, достаточно заменить одну строку
      patchNote(saved)
      scheduleAutoPush()
    }, 500)
    return () => clearTimeout(t)
  }, [draft?.id, draft?.title, draft?.body, draft?.dimension, draft?.estimateHours, draft?.note_type, draft?.canvas_data, draft?.draw_data])

  // ---------- измерения ----------

  const dimById = useMemo(() => Object.fromEntries(dims.map((d) => [d.id, d])), [dims])

  const toggleDim = (id) => {
    setEnabledDims((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const changeDimColor = async (id, color) => {
    setDims((prev) => prev.map((d) => (d.id === id ? { ...d, color } : d)))
    const row = await db.dimensions.get(id)
    if (row) await db.dimensions.put({ ...row, color })
    scheduleAutoPush()
  }
  const renameDimLive = (id, name) => setDims((prev) => prev.map((d) => (d.id === id ? { ...d, name } : d)))
  const saveDimName = async (id) => {
    const row = await db.dimensions.get(id)
    const cur = dims.find((d) => d.id === id)
    if (row && cur && cur.name.trim()) await db.dimensions.put({ ...row, name: cur.name.trim() })
    else if (row && cur) setDims((prev) => prev.map((d) => (d.id === id ? { ...d, name: row.name } : d)))
    scheduleAutoPush()
  }

  // ---------- список заметок ----------

  const visible = useMemo(() => {
    const base = notes.filter((n) => enabledDims.has(n.dimension))
    const q = query.trim().toLowerCase()
    if (!q) return base
    return base.filter((n) => searchOf(n).includes(q))
  }, [notes, enabledDims, query])
  const pinnedList = useMemo(() => visible.filter((n) => n.is_pinned), [visible])
  const otherList = useMemo(() => visible.filter((n) => !n.is_pinned), [visible])
  const shownList = pinnedOnly ? pinnedList : visible
  const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])

  const planOf = (noteId) => {
    const rows = chunks.filter((c) => c.noteId === noteId && !c.habit)
    return {
      done: rows.filter((c) => c.done).reduce((s, c) => s + c.hours, 0),
      total: rows.reduce((s, c) => s + c.hours, 0),
    }
  }

  const openNote = (id) => {
    setActiveId(id)
    setTab('notes')
    setMenuOpen(false)
  }

  const createNew = async (note_type = 'text') => {
    const firstDim = [...enabledDims][0] || dims[0]?.id || 'ya'
    const id = await createNoteRow({
      title: note_type === 'canvas' ? 'Новая доска' : 'Новая заметка',
      body: note_type === 'canvas' ? '' : 'дедлайн: ',
      dimension: firstDim,
      note_type,
    })
    await refresh()
    setActiveId(id)
    setTab('notes')
    setMenuOpen(false)
    scheduleAutoPush()
  }

  const onTogglePin = async (id) => {
    const next = await togglePin(id)
    if (next === null) return
    setDraft((d) => (d && d.id === id ? { ...d, is_pinned: next } : d))
    await refresh()
    scheduleAutoPush()
  }

  const onDeleteNote = async (id, title) => {
    if (!window.confirm(`Удалить «${title || 'Без названия'}»?`)) return
    // мягкое удаление (deleted=1): флаг уедет в облако и на другие устройства,
    // даже если сейчас нет сети
    await deleteNoteDeep(id)
    if (activeId === id) setActiveId(null)
    await refresh()
    scheduleAutoPush()
  }

  // ---------- синк ----------

  // Вход в облако протух (токен не обновился): показываем форму входа.
  // Заметки при этом остаются в базе на устройстве — ничего не теряется.
  const offerLogin = (notice) => {
    setAccount(null)
    setAuthChecked(true)
    setAuthMode('in')
    setAuthError(notice || '')
    setAuthNotice('')
  }

  const doSync = async () => {
    if (syncing.current) {
      setSyncMsg('Синк уже идёт, подожди…')
      return
    }
    syncing.current = true
    setSyncMsg('Синк…')
    try {
      const r = await syncNow()
      if (r.needLogin) {
        setSyncMsg(r.reason)
        offerLogin(r.reason)
        return
      }
      setSyncMsg(
        r.ok
          ? `Ок: заметок ${r.pulled}, чанков ${r.pulledChunks || 0}, событий ${r.pulledEvents || 0}`
          : `Ошибка: ${r.reason}`
      )
      if (r.ok) {
        await refresh()
        markSynced()
      }
    } finally {
      syncing.current = false
    }
  }

  // бэкап: всё, что лежит в браузере, одним JSON-файлом
  const exportAll = async () => {
    try {
      const data = {
        app: 'notmozgi',
        version: 1,
        exportedAt: new Date().toISOString(),
        notes: await db.notes.toArray(),
        events: await db.events.toArray(),
        links: await db.links.toArray(),
        chunks: await db.chunks.toArray(),
        dimensions: await db.dimensions.toArray(),
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `notmozgi-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 3000)
      setSyncMsg(`Экспорт: ${data.notes.filter((n) => !n.deleted).length} заметок, ${data.events.length} событий`)
    } catch (e) {
      setSyncMsg(`Экспорт не удался: ${e.message}`)
    }
  }

  const cleanup = async () => {
    if (!window.confirm('Удалить дубликаты заметок с одинаковым названием? Останется самая свежая (закреплённая важнее).'))
      return
    const r = await cleanupDuplicates()
    const parts = []
    if (r.removed) parts.push(`дублей убрано: ${r.removed}`)
    if (r.merged) parts.push(`облачных дублей схлопнуто: ${r.merged}`)
    if (r.adopted) parts.push(`подобрано пропущенных: ${r.adopted}`)
    setSyncMsg(
      parts.length
        ? `${parts.join(', ')}. Нажми Синк и повтори на втором устройстве.`
        : 'Дубликатов нет'
    )
    await refresh()
  }

  const saveNow = async () => {
    if (!draft) return
    await updateNote(draft.id, {
      title: draft.title,
      body: draft.body,
      dimension: draft.dimension,
      estimateHours: Number(draft.estimateHours) || 0,
      note_type: draft.note_type === 'canvas' ? 'canvas' : 'text',
      canvas_data: draft.canvas_data || null,
      draw_data: draft.draw_data || null,
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
      if (r.ok) {
        await refresh()
        markSynced()
      }
    } finally {
      syncing.current = false
    }
  }

  // ---------- связи ----------

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

  // ---------- чанки ----------

  const rebuildPlan = async () => {
    if (!draft) return
    const total = Number(draft.estimateHours) || parseEffort(`${draft.title}\n${draft.body}`)
    const patch = {
      title: draft.title,
      body: draft.body,
      dimension: draft.dimension,
      estimateHours: total || 0,
    }
    await updateNote(draft.id, patch)
    setDraft({ ...draft, ...patch })
    const fresh = await db.notes.get(draft.id)
    const r = await buildPlan(fresh)
    setSyncMsg(r.ok ? '' : `План: ${r.reason}`)
    await refresh()
    scheduleAutoPush()
  }
  const onToggleChunk = async (c) => {
    await toggleChunk(c, pixelsLib)
    await refresh()
    scheduleAutoPush()
  }

  // ---------- календарь ----------

  const notesWithDates = useMemo(
    () =>
      visible
        .flatMap((n) => deadlinesOf(n).map((dl) => ({ note: n, dl })))
        .sort((a, b) => a.dl.date - b.dl.date),
    [visible]
  )

  const monthCells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1)
    const startDay = (first.getDay() + 6) % 7 // понедельник = 0
    const cells = []
    for (let i = 0; i < 42; i++) cells.push(new Date(cursor.y, cursor.m, 1 - startDay + i))
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
      if (c.habit) continue
      const n = noteById.get(c.noteId)
      if (!n || !enabledDims.has(n.dimension)) continue
      if (!map[c.date]) map[c.date] = []
      map[c.date].push({ chunk: c, note: n })
    }
    for (const k of Object.keys(map)) map[k].sort((a, b) => a.note.title.localeCompare(b.note.title))
    return map
  }, [chunks, noteById, enabledDims])

  const eventsByDate = useMemo(() => {
    const map = {}
    for (const e of events) {
      if (e.deleted) continue
      if (e.dimension && !enabledDims.has(e.dimension)) continue
      if (!map[e.date]) map[e.date] = []
      map[e.date].push(e)
    }
    // закреплённые события — первыми
    for (const k of Object.keys(map))
      map[k].sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0))
    return map
  }, [events, enabledDims])

  // «закреплённые даты»: пин события ИЛИ дедлайн закреплённой заметки
  const pinnedDays = useMemo(() => {
    const s = new Set()
    for (const e of events) if (!e.deleted && e.is_pinned) s.add(e.date)
    for (const { note, dl } of notesWithDates) if (note.is_pinned) s.add(dayKey(dl.date))
    return s
  }, [events, notesWithDates])

  // счётчик на иконке приложения (Android/PWA): сколько висит на сегодня
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.setAppBadge) return
    const today = todayISO()
    const due = notesWithDates.filter(({ dl }) => dayKey(dl.date) <= today).length
    const evs = events.filter((e) => !e.deleted && e.date === today).length
    const n = due + evs
    try {
      if (n > 0) navigator.setAppBadge(n).catch(() => {})
      else navigator.clearAppBadge?.().catch(() => {})
    } catch {
      /* не поддерживается — не критично */
    }
  }, [notesWithDates, events])

  const focusDay = selectedDay || new Date()
  const focusKey = dayKey(focusDay)
  const focusChunks = chunksByDate[focusKey] || []
  const focusEvents = eventsByDate[focusKey] || []

  const habitItems = useMemo(
    () =>
      visible.filter(isHabit).map((note) => {
        const row = chunks.find((c) => c.noteId === note.id && c.date === focusKey && c.habit)
        return {
          chunk: row || { id: `habit-${note.id}`, noteId: note.id, date: focusKey, hours: 0, done: 0, habit: 1 },
          note,
        }
      }),
    [visible, chunks, focusKey]
  )

  const onToggleHabit = async (noteId, date) => {
    await toggleHabit(noteId, date, pixelsLib)
    await refresh()
    scheduleAutoPush()
  }

  const addEventFor = async (title, dimension, isPinned) => {
    if (!evModalDay) return
    await addEventRow({ date: dayKey(evModalDay), title, dimension, is_pinned: isPinned ? 1 : 0 })
    setEvModalDay(null)
    await refresh()
    scheduleAutoPush()
  }

  const addEventQuick = async () => {
    const title = evTitle.trim()
    if (!title) return
    await addEventRow({ date: focusKey, title, dimension: evDim || null, is_pinned: 0 })
    setEvTitle('')
    await refresh()
    scheduleAutoPush()
  }

  const onToggleEventPin = async (id) => {
    await toggleEventPin(id)
    await refresh()
    scheduleAutoPush()
  }

  const onDeleteEvent = async (id) => {
    await deleteEventRow(id)
    await refresh()
    scheduleAutoPush()
  }

  // у «Все» и у каждого измерения — свои позиции узлов и свой рисунок
  const onGraphPositions = (next) => {
    setGraphPos((prev) => {
      const map = { ...prev, [graphDim]: next }
      setSetting('graphPos', map).catch(() => {})
      return map
    })
  }

  const onGraphDraw = (next) => {
    setGraphDraw((prev) => {
      const map = { ...prev, [graphDim]: next }
      setSetting('graphDraw', map).catch(() => {})
      return map
    })
  }

  const onGraphDim = (next) => {
    setGraphDim(next)
    setSetting('graphDim', next).catch(() => {})
  }

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
        if (m < 0) {
          m = 11
          y--
        } else if (m > 11) {
          m = 0
          y++
        }
        return { y, m }
      })
    } else {
      setWeekAnchor((a) => {
        const d = new Date(a)
        d.setDate(d.getDate() + dir * 7)
        return d
      })
    }
  }
  const switchCalView = (v) => {
    setCalView(v)
    if (v === 'week') setWeekAnchor(selectedDay || new Date())
  }

  const today = new Date()
  const monthName = new Date(cursor.y, cursor.m, 1).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })
  const draftPinned = !!notes.find((n) => n.id === draft?.id)?.is_pinned

  const renderCard = (n) => {
    const dl = firstDeadline(`${n.title}\n${n.body}`)
    const plan = planOf(n.id)
    return (
      <NoteCard
        key={n.id}
        note={n}
        dim={dimById[n.dimension]}
        active={n.id === activeId}
        deadline={dl ? fmtDate(dl.date) : null}
        daysLeft={dl ? Math.ceil((dl.date - today) / 86400000) : undefined}
        doneHours={plan.done}
        totalHours={plan.total}
        onOpen={openNote}
        onDelete={onDeleteNote}
        onTogglePin={onTogglePin}
      />
    )
  }

  // Без входа показываем только форму: ни заметок, ни измерений не видно.
  if (!account) {
    if (!authChecked) {
      return (
        <div className="h-full flex items-center justify-center opacity-60" style={{ background: 'var(--bg)' }}>
          Загрузка…
        </div>
      )
    }
    const creating = !anyAccount || authMode === 'up'
    return (
      <div className="h-full flex items-center justify-center p-4" style={{ background: 'var(--bg)' }}>
        <div className="panel rounded p-5 w-full" style={{ maxWidth: 420 }}>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-sm accent-bg" />
            <b className="text-lg">NotMozgi</b>
          </div>
          <div className="text-sm opacity-60 mb-4">
            {CLOUD
              ? creating
                ? 'Аккаунт в облаке: он же открывается на других устройствах, заметки синхронизируются.'
                : 'Войди в аккаунт — заметки подтянутся из облака на это устройство.'
              : !anyAccount
                ? 'Первый запуск на этом устройстве. Создай аккаунт — заметки, которые уже есть в браузере, станут твоими.'
                : creating
                  ? 'Новый аккаунт на этом устройстве. Он будет пустым: свои заметки и свои измерения.'
                  : 'Войди в свой аккаунт. Без входа заметок не видно.'}
          </div>

          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="почта"
            value={authEmail}
            onChange={(e) => setAuthEmail(e.target.value)}
            className="w-full rounded px-3 py-3 text-base mb-2"
          />
          <input
            type="password"
            autoComplete={creating ? 'new-password' : 'current-password'}
            placeholder={creating ? 'пароль (минимум 4 символа)' : 'пароль'}
            value={authPass}
            onChange={(e) => setAuthPass(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doAuth()
            }}
            className="w-full rounded px-3 py-3 text-base mb-3"
          />

          {authError && <div className="text-sm danger-text mb-2">{authError}</div>}
          {authNotice && (
            <div className="text-sm mb-2" style={{ color: '#86efac' }}>
              {authNotice}
            </div>
          )}

          <button
            onClick={doAuth}
            disabled={authBusy || !authEmail.trim() || authPass.length < 4}
            className="w-full py-3 rounded accent-bg text-black font-bold"
            style={authBusy || !authEmail.trim() || authPass.length < 4 ? { opacity: 0.5 } : undefined}
          >
            {authBusy ? 'Подожди…' : creating ? 'Создать аккаунт' : 'Войти'}
          </button>

          {anyAccount && (
            <div className="flex items-center justify-between mt-3 text-sm">
              <button
                onClick={() => {
                  setAuthMode(creating ? 'in' : 'up')
                  setAuthError('')
                  setAuthNotice('')
                }}
                className="underline opacity-70"
              >
                {creating ? 'У меня уже есть аккаунт' : 'Создать ещё аккаунт'}
              </button>
            </div>
          )}

          <div className="text-xs opacity-40 mt-4">
            {CLOUD
              ? 'Заметки хранятся в облаке (Supabase), доступ есть только у владельца аккаунта. У каждого аккаунта свои записи.'
              : 'Синхронизация между устройствами выключена: не вписаны ключи Supabase. Аккаунт и пароль хранятся только здесь, восстановить пароль нельзя — запиши его. У каждого аккаунта свои заметки.'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      {/* ---------- верхняя панель ---------- */}
      <header className="app-header panel">
        <button className="md:hidden icon-btn" onClick={() => setMenuOpen(true)} title="Меню">
          ☰
        </button>
        <div className="w-3 h-3 rounded-sm accent-bg" />
        <b>Not</b>
        <span className="opacity-50 text-sm hidden sm:inline">Minimal Dark OS</span>

        <div className="flex-1" />

        {['notes', 'calendar', 'graph', 'map', 'diag'].map((t) => (
          <button
            key={t}
            className="tab-btn"
            style={tab === t ? { borderColor: 'var(--accent)' } : {}}
            onClick={() => setTab(t)}
          >
            {t === 'notes'
              ? 'Заметки'
              : t === 'calendar'
                ? 'Календарь'
                : t === 'graph'
                  ? 'Граф'
                  : t === 'map'
                    ? 'Карта'
                    : 'Диагностика'}
          </button>
        ))}

        <button
          onClick={doSignOut}
          className="tab-btn"
          title={`Выйти из аккаунта ${account?.email || ''}`}
        >
          ⎋ {account?.email?.split('@')[0] || 'выйти'}
        </button>
        <button
          onClick={() => {
            if (!cloudEnabled) {
              setSyncMsg('Облако не настроено: впиши ключи в public/config.js')
              return
            }
            doSync()
          }}
          className="tab-btn"
          title={cloudEnabled ? 'Синхронизация с Supabase' : 'Данные хранятся на этом устройстве'}
        >
          {cloudEnabled ? 'Синк' : 'Локально'}
        </button>
        {cloudEnabled && lastSyncAt && (
          <span className="text-[11px] opacity-50 hidden sm:inline" title="Последний успешный синк">
            · {lastSyncAt}
          </span>
        )}
        <button
          onClick={enableNotif}
          className="tab-btn"
          style={notifState === 'granted' ? { borderColor: 'var(--accent)' } : {}}
          title={notifState === 'granted' ? 'Напоминания включены' : 'Включить напоминания'}
        >
          {notifState === 'granted' ? '🔔 вкл' : notifState === 'denied' ? '🔕 блок' : '🔔'}
        </button>
      </header>

      {syncMsg && (
        <div className="text-xs px-4 py-1 opacity-70 border-b" style={{ borderColor: 'var(--border)' }}>
          {syncMsg}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* ---------- сайдбар ---------- */}
        {menuOpen && (
          <div
            className="fixed inset-0 z-30 md:hidden"
            style={{ background: 'rgba(0,0,0,0.55)' }}
            onClick={() => setMenuOpen(false)}
          />
        )}

        <aside
          className={`app-sidebar panel flex flex-col fixed inset-y-0 left-0 z-40 md:static md:z-auto transition-transform ${
            menuOpen ? 'translate-x-0' : '-translate-x-full'
          } md:translate-x-0`}
        >
          <div className="p-3 border-b" style={{ borderColor: 'var(--border)' }}>
            <input
              type="text"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="Поиск по заметкам…"
              className="w-full rounded px-3 py-2 text-sm mb-3"
              aria-label="Поиск по заметкам"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQueryInput('')
              }}
            />
            <div className="text-xs uppercase opacity-50 mb-2">Измерения</div>
            {dims.map((d) => (
              <div key={d.id} className="flex items-center gap-2 py-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={enabledDims.has(d.id)}
                  onChange={() => toggleDim(d.id)}
                  title="Показать/скрыть слой"
                  className="w-5 h-5 shrink-0 cursor-pointer"
                />
                <input
                  type="color"
                  value={d.color}
                  title="Цвет измерения"
                  onChange={(e) => changeDimColor(d.id, e.target.value)}
                  className="shrink-0"
                  style={{ width: 34, height: 28, padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}
                />
                {editingDimId === d.id ? (
                  <input
                    autoFocus
                    type="text"
                    value={d.name}
                    onChange={(e) => renameDimLive(d.id, e.target.value)}
                    onBlur={() => {
                      saveDimName(d.id)
                      setEditingDimId(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'Escape') e.target.blur()
                    }}
                    className="flex-1 min-w-0 rounded px-2 py-1 text-sm"
                  />
                ) : (
                  <button
                    onClick={() => toggleDim(d.id)}
                    title="Показать/скрыть слой"
                    className="flex-1 min-w-0 text-left truncate rounded px-2 py-1.5 cursor-pointer select-none"
                    style={enabledDims.has(d.id) ? {} : { opacity: 0.4 }}
                  >
                    {d.name}
                  </button>
                )}
                <button
                  className="opacity-50 hover:opacity-100 px-1 text-sm shrink-0 tiny"
                  title="Переименовать"
                  onClick={() => setEditingDimId(editingDimId === d.id ? null : d.id)}
                >
                  ✎
                </button>
              </div>
            ))}

            <div className="flex gap-2 mt-3">
              <button onClick={() => createNew('text')} className="flex-1 text-sm py-2 rounded accent-bg text-black font-semibold">
                + Заметка
              </button>
              <button onClick={() => createNew('canvas')} className="flex-1 text-sm py-2 rounded panel" title="Создать доску">
                🎨 Доска
              </button>
            </div>

            <div className="flex gap-2 mt-2">
              <button
                onClick={() => setPinnedOnly((v) => !v)}
                className="flex-1 text-xs py-1.5 rounded panel"
                style={pinnedOnly ? { borderColor: 'var(--accent)', fontWeight: 700 } : {}}
                title="Показать только закреплённые"
              >
                📌 Только закреплённые
              </button>
              <button
                onClick={cleanup}
                className="text-xs py-1.5 px-2 rounded panel opacity-70"
                title="Удалить заметки-дубликаты с одинаковым названием"
              >
                Дубли
              </button>
            </div>

            <button
              onClick={exportAll}
              className="w-full mt-2 text-xs py-1.5 rounded panel opacity-70"
              title="Скачать все данные в JSON (бэкап)"
            >
              ⤓ Экспорт данных
            </button>
          </div>

          <div className="flex-1 overflow-auto p-2">
            {pinnedOnly ? (
              <>
                {pinnedList.length === 0 && <div className="text-sm opacity-50 p-2">Закреплённых заметок нет.</div>}
                {pinnedList.map(renderCard)}
              </>
            ) : (
              <>
                {pinnedList.length > 0 && (
                  <>
                    <div className="list-section">📌 Закреплённые · {pinnedList.length}</div>
                    {pinnedList.map(renderCard)}
                    {otherList.length > 0 && <div className="list-section">Все заметки · {otherList.length}</div>}
                  </>
                )}
                {otherList.slice(0, listLimit).map(renderCard)}
                {otherList.length > listLimit && (
                  <button
                    onClick={() => setListLimit((v) => v + 100)}
                    className="w-full text-xs py-2 rounded panel opacity-70 mt-1"
                  >
                    Показать ещё · осталось {otherList.length - listLimit}
                  </button>
                )}
                {shownList.length === 0 && (
                  <div className="text-sm opacity-50 p-2">
                    {query.trim() ? `По запросу «${query.trim()}» ничего не найдено.` : 'Нет заметок. Включи измерения или создай новую.'}
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        {/* ---------- контент ---------- */}
        <main className="flex-1 min-w-0 p-4 overflow-auto pad-bottom">
          <Suspense fallback={<div className="opacity-50 p-4">Загрузка…</div>}>
          {tab === 'notes' ? (
            !draft ? (
              <div className="opacity-50">Выбери заметку слева или создай новую.</div>
            ) : (
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    className="flex-1 min-w-0 text-xl font-bold px-3 py-2 rounded"
                    placeholder="Название"
                  />
                  <button
                    type="button"
                    onClick={() => onTogglePin(draft.id)}
                    className={`pin-btn pin-btn-lg ${draftPinned ? 'is-on' : ''}`}
                    title={draftPinned ? 'Открепить' : 'Закрепить'}
                    aria-pressed={draftPinned}
                  >
                    {draftPinned ? '📌' : '📍'}
                  </button>
                </div>

                <div className="flex items-center gap-2 mb-3 text-sm flex-wrap">
                  {dims
                    .filter((d) => enabledDims.has(d.id))
                    .map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setDraft({ ...draft, dimension: d.id })}
                        aria-pressed={draft.dimension === d.id}
                        className="chip"
                        style={
                          draft.dimension === d.id
                            ? { borderColor: d.color, background: d.color + '22', fontWeight: 700 }
                            : {}
                        }
                      >
                        <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: d.color }} />
                        {d.name}
                      </button>
                    ))}

                  <div className="flex-1" />

                  <div className="seg">
                    <button
                      type="button"
                      className={`seg-btn ${draft.note_type !== 'canvas' ? 'is-on' : ''}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          note_type: 'text',
                        })
                      }
                    >
                      📄 Текст
                    </button>
                    <button
                      type="button"
                      className={`seg-btn ${draft.note_type === 'canvas' ? 'is-on' : ''}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          note_type: 'canvas',
                          canvas_data: draft.canvas_data || { version: 1, elements: [] },
                        })
                      }
                    >
                      🎨 Доска
                    </button>
                  </div>
                </div>

                {draft.note_type === 'canvas' ? (
                  <CanvasBoard
                    key={draft.id}
                    value={draft.canvas_data}
                    onChange={(next) => setDraft((d) => (d ? { ...d, canvas_data: next } : d))}
                  />
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <button
                        onClick={() => {
                          setHwMode((v) => !v)
                          setPreview(false)
                        }}
                        className="chip"
                        style={hwMode ? { borderColor: 'var(--accent)', fontWeight: 700 } : {}}
                        title="Рукописный режим: крупный текст, удобно писать стилусом"
                      >
                        ✍ Рукопись
                      </button>
                      <button
                        onClick={() => {
                          setDrawMode((v) => !v)
                          setPreview(false)
                        }}
                        className="chip"
                        style={drawMode ? { borderColor: 'var(--accent)', fontWeight: 700 } : {}}
                        title="Рисовать прямо поверх текста"
                      >
                        ✏️ Рисовать
                      </button>
                      <button onClick={saveNow} className="px-4 py-2 rounded accent-bg text-black font-semibold text-sm">
                        Сохранить
                      </button>
                      <button onClick={() => setPreview(!preview)} className="chip">
                        {preview ? 'Редактировать' : 'Превью'}
                      </button>
                    </div>

                    {preview ? (
                      <div className="panel rounded p-4 md">
                        <ReactMarkdown>{draft.body.slice(0, PREVIEW_LIMIT)}</ReactMarkdown>
                        {draft.body.length > PREVIEW_LIMIT && (
                          <div className="text-xs opacity-60 mt-3">
                            Превью показано для первых {PREVIEW_LIMIT.toLocaleString('ru-RU')} символов из{' '}
                            {draft.body.length.toLocaleString('ru-RU')}: разбор markdown на очень длинном
                            тексте подвешивает планшет. Сам текст и сохранение работают целиком.
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="draw-page">
                        <textarea
                          ref={bodyRef}
                          value={draft.body}
                          onChange={(e) => handleBodyChange(e.target.value)}
                          readOnly={drawMode}
                          rows={hwMode ? 20 : 12}
                          className={`draw-page-text w-full rounded p-3 font-mono text-sm ${hwMode ? 'hw-textarea' : ''}`}
                          placeholder={
                            hwMode
                              ? 'Пиши стилусом — текст распознается и попадает в заметку'
                              : '# Заголовок\n\n- [ ] задача\n\nСвязь: [[Другая заметка]]\n\nдедлайн: 30.09'
                          }
                        />
                        <DrawLayer
                          ref={drawRef}
                          key={draft.id}
                          active={drawMode}
                          value={draft.draw_data}
                          onChange={(next) => setDraft((d) => (d ? { ...d, draw_data: next } : d))}
                        />
                      </div>
                    )}

                    {(() => {
                      const tasks = draftTasks
                      if (!tasks.length) return null
                      return (
                        <div className="panel rounded p-3 mt-3">
                          <div className="text-xs uppercase opacity-50 mb-2">
                            Задачи ({tasks.filter((t) => t.checked).length}/{tasks.length})
                          </div>
                          {tasks.map((t) => (
                            <label key={t.idx} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
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

                    <div className="panel rounded p-3 mt-3">
                      <div className="text-xs uppercase opacity-50 mb-2">План (auto-chunking)</div>
                      <div className="flex items-center gap-2 text-sm flex-wrap">
                        <label className="flex items-center gap-1">
                          Оценка, ч:
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={draft.estimateHours ?? 0}
                            onChange={(e) => setDraft({ ...draft, estimateHours: parseFloat(e.target.value) || 0 })}
                            className="w-20 rounded px-2 py-1"
                          />
                        </label>
                        <button onClick={rebuildPlan} className="px-3 py-1.5 rounded accent-bg text-black font-semibold text-sm">
                          Разбить на чанки
                        </button>
                        <span className="text-xs opacity-50">трудоёмкость / дни до дедлайна</span>
                      </div>
                      <div className="text-xs opacity-40 mt-1">
                        Привычка: напиши «ежедневно» — чекбокс появится на каждый день.
                      </div>
                      {chunks.filter((c) => c.noteId === draft.id && !c.habit).length > 0 && (
                        <div className="mt-2">
                          {chunks
                            .filter((c) => c.noteId === draft.id && !c.habit)
                            .sort((a, b) => (a.date < b.date ? -1 : 1))
                            .map((c) => (
                              <label key={c.id} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                                <input type="checkbox" checked={!!c.done} onChange={() => onToggleChunk(c)} />
                                <span className="opacity-60 text-xs">{c.date}</span>
                                <span style={c.done ? { textDecoration: 'line-through', opacity: 0.5 } : {}}>
                                  {c.hours} ч.
                                </span>
                              </label>
                            ))}
                        </div>
                      )}
                    </div>

                    <div className="panel rounded p-3 mt-3">
                      <div className="text-xs uppercase opacity-50 mb-2">Связи</div>
                      {parseWikiLinks(`${draft.title}\n${draft.body}`).map((name) => {
                        const t = notes.find((n) => (n.title || '').trim().toLowerCase() === name.toLowerCase())
                        return t ? (
                          <div key={name} className="flex items-center gap-2 text-sm py-1">
                            <span className="w-2 h-2 rounded-sm" style={{ background: dimById[t.dimension]?.color }} />
                            <span>[[{name}]]</span>
                            <button className="text-xs underline opacity-60" onClick={() => openNote(t.id)}>
                              открыть
                            </button>
                          </div>
                        ) : (
                          <div key={name} className="text-sm py-1 opacity-40">
                            [[{name}]] — нет такой заметки
                          </div>
                        )
                      })}
                      {links
                        .filter((l) => l.fromId === draft.id)
                        .map((l) => {
                          const t = noteById.get(l.toId)
                          if (!t) return null
                          return (
                            <div key={l.id} className="flex items-center gap-2 text-sm py-1">
                              <span className="text-xs opacity-50">ручная →</span>
                              <b>{t.title}</b>
                              <button className="text-xs underline opacity-60" onClick={() => openNote(t.id)}>
                                открыть
                              </button>
                              <button className="text-xs opacity-40 hover:opacity-100" onClick={() => removeLink(l.id)}>
                                ✕
                              </button>
                            </div>
                          )
                        })}
                      <div className="flex items-center gap-2 mt-2">
                        <select
                          value={linkTarget}
                          onChange={(e) => setLinkTarget(e.target.value)}
                          className="flex-1 rounded px-2 py-2 text-sm"
                        >
                          <option value="">+ ручная связь…</option>
                          {notes
                            .filter((n) => n.id !== draft.id)
                            .map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.title || 'Без названия'}
                              </option>
                            ))}
                        </select>
                        <button onClick={addLink} className="px-3 py-2 rounded panel text-sm">
                          Связать
                        </button>
                      </div>
                      <div className="text-xs opacity-40 mt-2">Авто-связи: напиши [[Название заметки]] в тексте.</div>
                    </div>

                    {(() => {
                      const dls = draftDates
                      if (!dls.length)
                        return (
                          <div className="text-xs opacity-40 mt-2">
                            Подсказка: напиши «дедлайн: 30.09» — дата появится в календаре.
                          </div>
                        )
                      return (
                        <div className="text-xs mt-2 danger-text">
                          Найдено дат: {dls.map((d) => fmtDate(d.date)).join(', ')}
                        </div>
                      )
                    })()}
                  </>
                )}
              </div>
            )
          ) : tab === 'calendar' ? (
            <div className="max-w-4xl mx-auto split-cols">
              <div>
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <button className="panel rounded px-3 py-2 text-sm" onClick={() => stepCal(-1)}>
                    ←
                  </button>
                  <b className="capitalize">{calView === 'month' ? monthName : `Неделя ${weekTitle}`}</b>
                  <button className="panel rounded px-3 py-2 text-sm" onClick={() => stepCal(1)}>
                    →
                  </button>
                  <div className="flex-1" />
                  <button
                    className="text-xs px-2 py-1 rounded panel"
                    style={calView === 'month' ? { borderColor: 'var(--accent)' } : {}}
                    onClick={() => switchCalView('month')}
                  >
                    Месяц
                  </button>
                  <button
                    className="text-xs px-2 py-1 rounded panel"
                    style={calView === 'week' ? { borderColor: 'var(--accent)' } : {}}
                    onClick={() => switchCalView('week')}
                  >
                    Неделя
                  </button>
                </div>
                <div className="text-xs opacity-50 mb-2">
                  даты из текста: «дедлайн: 30.09», «завтра», «в пятницу». Тап по дню — быстрое событие.
                </div>
                <div className="grid grid-cols-7 gap-1 text-xs opacity-50 mb-1">
                  {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => (
                    <div key={d} className="text-center">
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {cells.map((d, i) => {
                    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
                    const items = byDay[k] || []
                    const dayChunks = chunksByDate[dayKey(d)] || []
                    const leftH = dayChunks.filter((x) => !x.chunk.done).reduce((s, x) => s + x.chunk.hours, 0)
                    const dayEvents = eventsByDate[dayKey(d)] || []
                    const isPinnedDay = pinnedDays.has(dayKey(d))
                    const inMonth = calView === 'month' ? d.getMonth() === cursor.m : true
                    const isToday = d.toDateString() === today.toDateString()
                    return (
                      <div
                        key={i}
                        onClick={() => {
                          setSelectedDay(d)
                          if (coarse) setEvModalDay(d) // на планшете тап сразу открывает модалку
                        }}
                        className={`panel rounded p-1 cal-cell cursor-pointer ${isPinnedDay ? 'is-pinned-day' : ''}`}
                        style={{
                          opacity: inMonth ? 1 : 0.35,
                          borderColor:
                            selectedDay?.toDateString() === d.toDateString() ? 'var(--accent)' : undefined,
                        }}
                      >
                        <div className="flex items-center">
                          <div className="day-num" style={isToday ? { color: 'var(--accent)', fontWeight: 700 } : {}}>
                            {d.getDate()}
                          </div>
                          <div className="flex-1" />
                          {isPinnedDay && <span className="cal-pin" title="Закреплённая дата">📌</span>}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {items.slice(0, 4).map(({ note }, j) => (
                            <span
                              key={j}
                              title={note.title}
                              className="w-2.5 h-2.5 rounded-sm inline-block"
                              style={{ background: dimById[note.dimension]?.color }}
                            />
                          ))}
                        </div>
                        {leftH > 0 && <div className="text-[10px] opacity-70">{f1(leftH)} ч.</div>}
                        {dayEvents.length > 0 && (
                          <div
                            className="text-[10px] opacity-90 truncate"
                            title={dayEvents.map((e) => e.title).join(', ')}
                          >
                            <span
                              className="inline-block w-1.5 h-1.5 rounded-full mr-1"
                              style={{ background: dimById[dayEvents[0].dimension]?.color || 'var(--accent)' }}
                            />
                            {dayEvents[0].title}
                            {dayEvents.length > 1 ? ` +${dayEvents.length - 1}` : ''}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="panel rounded p-3 mt-4">
                  <div className="text-xs uppercase opacity-50 mb-2">
                    {selectedDay ? `На ${fmtDate(selectedDay)}` : 'Ближайшие дедлайны'}
                  </div>
                  {(selectedDay
                    ? byDay[`${selectedDay.getFullYear()}-${selectedDay.getMonth()}-${selectedDay.getDate()}`] || []
                    : notesWithDates.slice(0, 10)
                  ).map(({ note, dl }, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-sm py-1 border-b last:border-0"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: dimById[note.dimension]?.color }} />
                      {!!note.is_pinned && <span title="Закреплённая заметка">📌</span>}
                      <b>{note.title}</b>
                      <span className="opacity-50 text-xs">{dimById[note.dimension]?.name}</span>
                      <span className="flex-1" />
                      <span className="danger-text text-xs">
                        {fmtDate(dl.date)} · {Math.ceil((dl.date - today) / 86400000)} дн.
                      </span>
                      <button className="text-xs underline opacity-60" onClick={() => openNote(note.id)}>
                        открыть
                      </button>
                    </div>
                  ))}
                  {selectedDay && (byDay[`${selectedDay.getFullYear()}-${selectedDay.getMonth()}-${selectedDay.getDate()}`] || []).length === 0 && (
                    <div className="text-sm opacity-50">Дедлайнов нет.</div>
                  )}
                </div>

                <div className="panel rounded p-3 mt-4">
                  <div className="text-xs uppercase opacity-50 mb-2">
                    Чанки и привычки: {fmtDate(focusDay)}
                  </div>
                  {focusChunks.length === 0 && habitItems.length === 0 && (
                    <div className="text-sm opacity-50">На этот день чанков нет.</div>
                  )}
                  {focusChunks.map(({ chunk, note }) => {
                    const overdue = chunk.date < todayISO() && !chunk.done
                    return (
                      <label
                        key={chunk.id}
                        className="flex items-center gap-2 text-sm py-1 cursor-pointer border-b last:border-0"
                        style={{ borderColor: 'var(--border)' }}
                      >
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
                    <label
                      key={chunk.id}
                      className="flex items-center gap-2 text-sm py-1 cursor-pointer border-b last:border-0"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <input type="checkbox" checked={!!chunk.done} onChange={() => onToggleHabit(note.id, focusKey)} />
                      <span className="w-2 h-2 rounded-sm" style={{ background: dimById[note.dimension]?.color }} />
                      <b>{note.title}</b>
                      <span className="flex-1" />
                      <span className="text-xs opacity-60">привычка · ежедневно</span>
                    </label>
                  ))}
                </div>

                <div className="panel rounded p-3 mt-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="text-xs uppercase opacity-50">События: {fmtDate(focusDay)}</div>
                    <div className="flex-1" />
                    <button
                      onClick={() => setEvModalDay(focusDay)}
                      className="px-3 py-2 rounded panel text-sm"
                      title="Добавить событие на этот день"
                    >
                      + событие
                    </button>
                  </div>
                  {focusEvents.length === 0 && <div className="text-sm opacity-50">На этот день ничего не запланировано.</div>}
                  {focusEvents.map((e) => (
                    <div
                      key={e.id}
                      className="flex items-center gap-2 text-sm py-1 border-b last:border-0"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <span
                        className="w-2 h-2 rounded-sm shrink-0"
                        style={{ background: dimById[e.dimension]?.color || 'var(--accent)' }}
                      />
                      <span className="flex-1 truncate">{e.title}</span>
                      <button
                        type="button"
                        className={`pin-btn pin-btn-sm ${e.is_pinned ? 'is-on' : ''}`}
                        title={e.is_pinned ? 'Снять закрепление даты' : 'Закрепить дату'}
                        onClick={() => onToggleEventPin(e.id)}
                      >
                        {e.is_pinned ? '📌' : '📍'}
                      </button>
                      <button
                        className="text-xs opacity-40 hover:opacity-100 shrink-0 tiny"
                        title="Удалить событие"
                        onClick={() => onDeleteEvent(e.id)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 mt-2">
                    <select
                      value={evDim}
                      onChange={(e) => setEvDim(e.target.value)}
                      className="rounded px-1 py-2 text-sm shrink-0"
                      title="Цвет события"
                    >
                      <option value="">•</option>
                      {dims
                        .filter((d) => enabledDims.has(d.id))
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                    </select>
                    <input
                      type="text"
                      value={evTitle}
                      placeholder="Уборка…"
                      onChange={(e) => setEvTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addEventQuick()
                      }}
                      className="flex-1 min-w-0 rounded px-2 py-2 text-sm"
                    />
                    <button onClick={addEventQuick} className="px-3 py-2 rounded accent-bg text-black font-semibold text-sm shrink-0">
                      +
                    </button>
                  </div>
                  <div className="text-xs opacity-40 mt-1">Кликни день в сетке — и подпиши его здесь.</div>
                </div>
              </div>
            </div>
          ) : tab === 'graph' ? (
            <div className="graph-host">
              <GraphView
                key={graphDim}
                notes={notes}
                manualLinks={links}
                dims={dims}
                enabledDims={enabledDims}
                activeId={activeId}
                onOpen={openNote}
                positions={graphPos[graphDim] || {}}
                onPositionsChange={onGraphPositions}
                drawData={graphDraw[graphDim] || { version: 1, elements: [] }}
                onDrawChange={onGraphDraw}
                dimFilter={graphDim}
                onDimFilter={onGraphDim}
              />
            </div>
          ) : tab === 'map' ? (
            <MapView pixelRows={pixelRows} accent="#d1d5db" />
          ) : (
            <div className="max-w-3xl mx-auto">
              <SyncDiag onSynced={refresh} />
            </div>
          )}
          </Suspense>
        </main>
      </div>

      {/* ---------- нижняя панель на телефоне ---------- */}
      <div className="md:hidden panel flex" style={{ borderLeft: 0, borderRight: 0, borderBottom: 0 }}>
        <div className="flex-1 overflow-auto flex gap-1 p-2">
          {shownList.map((n) => (
            <button
              key={n.id}
              onClick={() => openNote(n.id)}
              className="text-xs px-2 py-1 rounded panel whitespace-nowrap"
              style={n.id === activeId ? { borderColor: 'var(--accent)' } : {}}
            >
              {n.is_pinned ? '📌' : dimById[n.dimension]?.name?.[0] || '·'} · {(n.title || '').slice(0, 12)}
            </button>
          ))}
        </div>
        <button onClick={() => createNew('text')} className="m-2 px-3 rounded accent-bg text-black font-bold">
          +
        </button>
      </div>

      {evModalDay && (
        <EventModal
          day={evModalDay}
          dims={dims.filter((d) => enabledDims.has(d.id))}
          onClose={() => setEvModalDay(null)}
          onCreate={addEventFor}
        />
      )}

    </div>
  )
}
