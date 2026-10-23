import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Интерактивная доска заметки: маркер, ластик, прямоугольники, стрелки, текст.
// Данные — обычный JSON (canvas_data), он же уезжает в Supabase и в Dexie.
//
// Почему свой холст, а не tldraw: tldraw тянет ~1 МБ JS и требует лицензию
// (вотермарка в бесплатной версии), а нам нужен ровно этот набор инструментов
// и предсказуемая сериализация. Замена на tldraw — это один компонент.

export const CANVAS_COLORS = ['#e8e8ea', '#3b82f6', '#22c55e', '#fb923c', '#ef4444', '#8b5cf6', '#facc15']
export const CANVAS_WIDTHS = [2, 4, 8, 14]

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const GRID = 24

export function emptyCanvas() {
  return { version: 1, elements: [] }
}

function normalizeDoc(value) {
  if (!value || !Array.isArray(value.elements)) return emptyCanvas()
  return { version: 1, elements: value.elements.filter((el) => el && el.type) }
}

const uid = () => `el${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

function distToSegment(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = clamp(t, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function hitTest(el, p, tol) {
  if (el.type === 'path') {
    const pts = el.points || []
    if (!pts.length) return false
    for (let i = 1; i < pts.length; i++) {
      const d = distToSegment(p, { x: pts[i - 1][0], y: pts[i - 1][1] }, { x: pts[i][0], y: pts[i][1] })
      if (d < tol + (el.width || 2) / 2) return true
    }
    const [x, y] = pts[0]
    return Math.hypot(p.x - x, p.y - y) < tol
  }
  if (el.type === 'rect') {
    return (
      p.x >= Math.min(el.x, el.x + el.w) - tol &&
      p.x <= Math.max(el.x, el.x + el.w) + tol &&
      p.y >= Math.min(el.y, el.y + el.h) - tol &&
      p.y <= Math.max(el.y, el.y + el.h) + tol
    )
  }
  if (el.type === 'arrow') {
    return distToSegment(p, { x: el.x1, y: el.y1 }, { x: el.x2, y: el.y2 }) < tol + (el.width || 2)
  }
  if (el.type === 'text') {
    const size = el.size || 20
    const w = (el.text || '').length * size * 0.56
    return p.x >= el.x - tol && p.x <= el.x + w + tol && p.y >= el.y - size - tol && p.y <= el.y + tol
  }
  return false
}

export default function CanvasBoard({ value, onChange }) {
  const [doc, setDoc] = useState(() => normalizeDoc(value))
  const [tool, setTool] = useState('pen')
  const [color, setColor] = useState(CANVAS_COLORS[1])
  const [width, setWidth] = useState(4)
  const [view, setView] = useState({ x: 48, y: 48, zoom: 1 })
  const [preview, setPreview] = useState(null)
  // Черновик фигуры дублируем в ref: коммит по pointerup не должен зависеть
  // от того, успел ли React перерисоваться между последним move и up.
  const previewRef = useRef(null)
  const showPreview = (el) => {
    previewRef.current = el
    setPreview(el)
  }
  const clearPreview = () => {
    previewRef.current = null
    setPreview(null)
  }
  const [textEdit, setTextEdit] = useState(null)
  const [histTick, setHistTick] = useState(0)

  const svgRef = useRef(null)
  const wrapRef = useRef(null)
  const docRef = useRef(doc)
  docRef.current = doc

  const gesture = useRef(null)
  const pointers = useRef(new Map())
  const pinch = useRef(null)
  const past = useRef([])
  const future = useRef([])

  const commit = useCallback(
    (next, history = true) => {
      if (history) {
        past.current.push(docRef.current)
        if (past.current.length > 80) past.current.shift()
        future.current = []
      }
      docRef.current = next
      setDoc(next)
      setHistTick((t) => t + 1)
      onChange?.(next)
    },
    [onChange]
  )

  const undo = () => {
    if (!past.current.length) return
    const prev = past.current.pop()
    future.current.push(docRef.current)
    docRef.current = prev
    setDoc(prev)
    setHistTick((t) => t + 1)
    onChange?.(prev)
  }

  const redo = () => {
    if (!future.current.length) return
    const next = future.current.pop()
    past.current.push(docRef.current)
    docRef.current = next
    setDoc(next)
    setHistTick((t) => t + 1)
    onChange?.(next)
  }

  const toWorld = useCallback(
    (clientX, clientY) => {
      const r = svgRef.current.getBoundingClientRect()
      return { x: (clientX - r.left - view.x) / view.zoom, y: (clientY - r.top - view.y) / view.zoom }
    },
    [view]
  )

  // колесо — зум вокруг курсора
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      setView((v) => {
        const z = clamp(v.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_ZOOM, MAX_ZOOM)
        const wx = (mx - v.x) / v.zoom
        const wy = (my - v.y) / v.zoom
        return { zoom: z, x: mx - wx * z, y: my - wy * z }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const eraseAt = (p) => {
    const tol = 10 / view.zoom + 4
    const els = docRef.current.elements
    for (let i = els.length - 1; i >= 0; i--) {
      if (hitTest(els[i], p, tol)) {
        commit({ ...docRef.current, elements: els.filter((_, idx) => idx !== i) }, false)
        return
      }
    }
  }

  const startText = (p, clientX, clientY) => {
    const r = wrapRef.current.getBoundingClientRect()
    setTextEdit({
      world: p,
      left: clamp(clientX - r.left - 4, 0, r.width - 200),
      top: clamp(clientY - r.top - 26, 0, r.height - 44),
      value: '',
    })
  }

  const commitText = () => {
    if (!textEdit) return
    const text = textEdit.value.trim()
    if (text) {
      commit({
        ...docRef.current,
        elements: [
          ...docRef.current.elements,
          { id: uid(), type: 'text', x: textEdit.world.x, y: textEdit.world.y, text, color, size: 20 },
        ],
      })
    }
    setTextEdit(null)
  }

  const onPointerDown = (e) => {
    if (e.button === 2) return
    const svg = svgRef.current
    try {
      svg.setPointerCapture(e.pointerId)
    } catch {
      /* не критично */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    // два пальца — пинч-зум, текущий жест отменяем
    if (pointers.current.size === 2) {
      gesture.current = null
      clearPreview()
      const [a, b] = [...pointers.current.values()]
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: { ...view },
      }
      return
    }
    if (textEdit) commitText()

    const p = toWorld(e.clientX, e.clientY)

    if (tool === 'text') {
      startText(p, e.clientX, e.clientY)
      return
    }
    if (tool === 'eraser') {
      // снимок один раз на весь жест: undo вернёт всё стёртое разом
      past.current.push(docRef.current)
      if (past.current.length > 80) past.current.shift()
      future.current = []
      gesture.current = { type: 'erase' }
      eraseAt(p)
      return
    }
    if (tool === 'hand') {
      gesture.current = { type: 'pan', origin: { x: e.clientX, y: e.clientY }, view0: { ...view } }
      return
    }
    if (tool === 'rect') {
      gesture.current = { type: 'rect', id: uid(), start: p }
      showPreview({ id: gesture.current.id, type: 'rect', x: p.x, y: p.y, w: 0, h: 0, color, width })
      return
    }
    if (tool === 'arrow') {
      gesture.current = { type: 'arrow', id: uid(), start: p }
      showPreview({ id: gesture.current.id, type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width })
      return
    }
    // pen
    gesture.current = { type: 'pen', el: { id: uid(), type: 'path', color, width, points: [[p.x, p.y]] } }
    showPreview({ ...gesture.current.el })
  }

  const onPointerMove = (e) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinch.current.dist > 0) {
        const r = svgRef.current.getBoundingClientRect()
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const v0 = pinch.current.view
        const z = clamp((v0.zoom * dist) / pinch.current.dist, MIN_ZOOM, MAX_ZOOM)
        const wx = (pinch.current.mid.x - r.left - v0.x) / v0.zoom
        const wy = (pinch.current.mid.y - r.top - v0.y) / v0.zoom
        setView({ zoom: z, x: mid.x - r.left - wx * z, y: mid.y - r.top - wy * z })
      }
      return
    }

    const g = gesture.current
    if (!g) return

    if (g.type === 'pan') {
      setView({ ...g.view0, x: g.view0.x + (e.clientX - g.origin.x), y: g.view0.y + (e.clientY - g.origin.y) })
      return
    }

    const p = toWorld(e.clientX, e.clientY)

    if (g.type === 'pen') {
      let evs = [e]
      try {
        if (e.getCoalescedEvents) evs = e.getCoalescedEvents()
      } catch {
        evs = [e]
      }
      const pts = g.el.points
      for (const ev of evs) {
        const q = toWorld(ev.clientX, ev.clientY)
        const lastP = pts[pts.length - 1]
        if (Math.hypot(q.x - lastP[0], q.y - lastP[1]) < 0.5) continue
        pts.push([q.x, q.y])
      }
      showPreview({ ...g.el, points: pts.slice() })
      return
    }
    if (g.type === 'erase') {
      eraseAt(p)
      return
    }
    if (g.type === 'rect') {
      showPreview({
        id: g.id,
        type: 'rect',
        x: Math.min(g.start.x, p.x),
        y: Math.min(g.start.y, p.y),
        w: Math.abs(p.x - g.start.x),
        h: Math.abs(p.y - g.start.y),
        color,
        width,
      })
      return
    }
    if (g.type === 'arrow') {
      showPreview({ id: g.id, type: 'arrow', x1: g.start.x, y1: g.start.y, x2: p.x, y2: p.y, color, width })
    }
  }

  const finish = (e) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    const g = gesture.current
    gesture.current = null
    const el = previewRef.current
    if (!g) return

    if (g.type === 'pen' && el && el.points && el.points.length > 1) {
      commit({ ...docRef.current, elements: [...docRef.current.elements, el] })
    } else if (g.type === 'rect' && el && el.w > 3 && el.h > 3) {
      commit({ ...docRef.current, elements: [...docRef.current.elements, el] })
    } else if (g.type === 'arrow' && el && Math.hypot(el.x2 - el.x1, el.y2 - el.y1) > 6) {
      commit({ ...docRef.current, elements: [...docRef.current.elements, el] })
    }
    clearPreview()
  }

  const fit = () => {
    const els = docRef.current.elements
    const r = wrapRef.current.getBoundingClientRect()
    if (!els.length) {
      setView({ x: 48, y: 48, zoom: 1 })
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const acc = (x, y) => {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    for (const el of els) {
      if (el.type === 'path') for (const [x, y] of el.points || []) acc(x, y)
      else if (el.type === 'rect') {
        acc(el.x, el.y)
        acc(el.x + el.w, el.y + el.h)
      } else if (el.type === 'arrow') {
        acc(el.x1, el.y1)
        acc(el.x2, el.y2)
      } else if (el.type === 'text') {
        acc(el.x, el.y - (el.size || 20))
        acc(el.x + (el.text || '').length * (el.size || 20) * 0.56, el.y + 6)
      }
    }
    if (!isFinite(minX)) return
    const pad = 44
    const z = clamp(
      Math.min((r.width - pad * 2) / Math.max(1, maxX - minX), (r.height - pad * 2) / Math.max(1, maxY - minY)),
      MIN_ZOOM,
      MAX_ZOOM
    )
    setView({ zoom: z, x: pad - minX * z, y: pad - minY * z })
  }

  const zoomBy = (k) => {
    const r = wrapRef.current.getBoundingClientRect()
    const mx = r.width / 2
    const my = r.height / 2
    setView((v) => {
      const z = clamp(v.zoom * k, MIN_ZOOM, MAX_ZOOM)
      const wx = (mx - v.x) / v.zoom
      const wy = (my - v.y) / v.zoom
      return { zoom: z, x: mx - wx * z, y: my - wy * z }
    })
  }

  const clearAll = () => {
    if (!docRef.current.elements.length) return
    if (!window.confirm('Очистить холст? Отменить можно кнопкой ↶.')) return
    commit({ ...docRef.current, elements: [] })
  }

  const renderEl = (el) => {
    if (el.type === 'path') {
      const pts = el.points || []
      if (!pts.length) return null
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
      return (
        <path
          key={el.id}
          d={d}
          fill="none"
          stroke={el.color}
          strokeWidth={el.width || 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )
    }
    if (el.type === 'rect') {
      return (
        <rect
          key={el.id}
          x={el.x}
          y={el.y}
          width={Math.max(1, el.w)}
          height={Math.max(1, el.h)}
          rx={10}
          fill="none"
          stroke={el.color}
          strokeWidth={el.width || 2}
        />
      )
    }
    if (el.type === 'arrow') {
      const ang = Math.atan2(el.y2 - el.y1, el.x2 - el.x1)
      const head = 8 + (el.width || 2) * 2.2
      const p1 = [el.x2 - head * Math.cos(ang - 0.42), el.y2 - head * Math.sin(ang - 0.42)]
      const p2 = [el.x2 - head * Math.cos(ang + 0.42), el.y2 - head * Math.sin(ang + 0.42)]
      return (
        <g key={el.id}>
          <line
            x1={el.x1}
            y1={el.y1}
            x2={el.x2}
            y2={el.y2}
            stroke={el.color}
            strokeWidth={el.width || 2}
            strokeLinecap="round"
          />
          <polygon points={`${el.x2},${el.y2} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}`} fill={el.color} />
        </g>
      )
    }
    if (el.type === 'text') {
      return (
        <text
          key={el.id}
          x={el.x}
          y={el.y}
          fill={el.color}
          fontSize={el.size || 20}
          fontFamily="Inter, system-ui, sans-serif"
        >
          {el.text}
        </text>
      )
    }
    return null
  }

  const tools = useMemo(
    () => [
      { id: 'pen', label: '✏️', title: 'Маркер' },
      { id: 'eraser', label: '🧽', title: 'Ластик' },
      { id: 'rect', label: '▭', title: 'Блок' },
      { id: 'arrow', label: '➜', title: 'Стрелка' },
      { id: 'text', label: 'T', title: 'Текст' },
      { id: 'hand', label: '✋', title: 'Двигать холст' },
    ],
    []
  )

  const canUndo = past.current.length > 0
  const canRedo = future.current.length > 0
  void histTick // перерисовка кнопок undo/redo

  return (
    <div className="cb-wrap" ref={wrapRef}>
      <div className="cb-toolbar">
        {tools.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.title}
            onClick={() => setTool(t.id)}
            className={`cb-tool ${tool === t.id ? 'is-active' : ''}`}
          >
            {t.label}
          </button>
        ))}

        <span className="cb-sep" />

        {CANVAS_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => {
              setColor(c)
              if (tool === 'eraser' || tool === 'hand') setTool('pen')
            }}
            className={`cb-swatch ${color === c ? 'is-active' : ''}`}
            style={{ background: c }}
          />
        ))}

        <span className="cb-sep" />

        {CANVAS_WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            title={`${w} px`}
            onClick={() => setWidth(w)}
            className={`cb-tool ${width === w ? 'is-active' : ''}`}
          >
            <span className="cb-dot" style={{ width: w + 3, height: w + 3 }} />
          </button>
        ))}

        <span className="cb-sep" />

        <button type="button" className="cb-tool" onClick={undo} disabled={!canUndo} title="Отменить">
          ↶
        </button>
        <button type="button" className="cb-tool" onClick={redo} disabled={!canRedo} title="Повторить">
          ↷
        </button>
        <button type="button" className="cb-tool" onClick={() => zoomBy(1 / 1.2)} title="Мельче">
          −
        </button>
        <button type="button" className="cb-tool" onClick={() => zoomBy(1.2)} title="Крупнее">
          +
        </button>
        <button type="button" className="cb-tool cb-fit" onClick={fit} title="Показать всё">
          ⤢
        </button>
        <button type="button" className="cb-tool cb-clear" onClick={clearAll} title="Очистить холст">
          Очистить
        </button>
      </div>

      <svg
        ref={svgRef}
        className="cb-svg"
        style={{ cursor: tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <pattern
            id="cb-grid"
            width={GRID}
            height={GRID}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}
          >
            <path d={`M ${GRID} 0 L 0 0 0 ${GRID}`} fill="none" stroke="#26262e" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#cb-grid)" />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          {doc.elements.map(renderEl)}
          {preview && renderEl(preview)}
        </g>
      </svg>

      {textEdit && (
        <input
          autoFocus
          className="cb-text-input"
          style={{ left: textEdit.left, top: textEdit.top }}
          value={textEdit.value}
          onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText()
            if (e.key === 'Escape') setTextEdit(null)
          }}
          onBlur={commitText}
          placeholder="Текст…"
        />
      )}

      {!doc.elements.length && !textEdit && (
        <div className="cb-hint">
          Рисуй стилусом: маркер, блоки, стрелки. Двумя пальцами — масштаб, «✋» — двигать холст.
        </div>
      )}

      <div className="cb-status">{Math.round(view.zoom * 100)}%</div>
    </div>
  )
}
