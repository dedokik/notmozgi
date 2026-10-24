import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { shiftStrokes } from '../lib/textshift.js'

// Слой рисования поверх текста заметки: текст остаётся видимым,
// сверху можно писать стилусом (пометки, обводки, стрелки).
// Штрихи хранятся в координатах страницы, поэтому привязаны к тексту.

const COLORS = ['#e8e8ea', '#3b82f6', '#22c55e', '#fb923c', '#ef4444', '#8b5cf6']
const WIDTHS = [2, 4, 8]

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const uid = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

function distToSegment(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function strokeHit(el, p, tol) {
  const pts = el.points || []
  for (let i = 1; i < pts.length; i++) {
    const d = distToSegment(p, { x: pts[i - 1][0], y: pts[i - 1][1] }, { x: pts[i][0], y: pts[i][1] })
    if (d < tol + (el.width || 2) / 2) return true
  }
  if (pts.length === 1) return Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) < tol
  return false
}

const DrawLayer = forwardRef(function DrawLayer({ active, value, onChange }, ref) {
  const [elements, setElements] = useState(() => (value?.elements ? value.elements : []))
  const [color, setColor] = useState(COLORS[1])
  const [width, setWidth] = useState(4)
  const [eraser, setEraser] = useState(false)
  const [draft, setDraft] = useState(null)
  const [tick, force] = useState(0)

  const svgRef = useRef(null)
  const drawing = useRef(false)
  const draftRef = useRef(null)
  const elsRef = useRef(elements)
  elsRef.current = elements
  const past = useRef([])
  const future = useRef([])

  const save = (next) => {
    setElements(next)
    elsRef.current = next
    onChange?.({ version: 1, elements: next })
  }

  // сдвиг рисунка, когда текст выше изменился (см. lib/textshift.js)
  useImperativeHandle(ref, () => ({
    shift(fromY, deltaY) {
      const next = shiftStrokes(elsRef.current, fromY, deltaY)
      if (next) save(next)
    },
  }))

  const snapshot = () => {
    past.current.push(elsRef.current)
    if (past.current.length > 60) past.current.shift()
    future.current = []
  }

  const undo = () => {
    if (!past.current.length) return
    const prev = past.current.pop()
    future.current.push(elsRef.current)
    save(prev)
    force((v) => v + 1)
  }

  const redo = () => {
    if (!future.current.length) return
    const next = future.current.pop()
    past.current.push(elsRef.current)
    save(next)
    force((v) => v + 1)
  }

  const clearAll = () => {
    if (!elsRef.current.length) return
    if (!window.confirm('Стереть весь рисунок на этой заметке?')) return
    snapshot()
    save([])
    force((v) => v + 1)
  }

  const pos = (e) => {
    const r = svgRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const eraseAt = (p) => {
    const list = elsRef.current
    for (let i = list.length - 1; i >= 0; i--) {
      if (strokeHit(list[i], p, 10)) {
        save(list.filter((_, k) => k !== i))
        return
      }
    }
  }

  const onDown = (e) => {
    if (!active || e.button === 2) return
    e.preventDefault()
    try {
      svgRef.current.setPointerCapture(e.pointerId)
    } catch {
      /* не критично */
    }
    drawing.current = true
    snapshot()

    const p = pos(e)
    if (eraser) {
      eraseAt(p)
      force((v) => v + 1)
      return
    }
    const el = { id: uid(), type: 'path', color, width, points: [[p.x, p.y]] }
    draftRef.current = el
    setDraft({ ...el })
  }

  const onMove = (e) => {
    if (!drawing.current) return
    e.preventDefault()
    const p = pos(e)

    if (eraser) {
      eraseAt(p)
      force((v) => v + 1)
      return
    }
    const el = draftRef.current
    if (!el) return
    let evs = [e]
    try {
      if (e.getCoalescedEvents) evs = e.getCoalescedEvents()
    } catch {
      evs = [e]
    }
    for (const ev of evs) {
      const q = pos(ev)
      const last = el.points[el.points.length - 1]
      if (Math.hypot(q.x - last[0], q.y - last[1]) < 0.6) continue
      el.points.push([q.x, q.y])
    }
    setDraft({ ...el, points: el.points.slice() })
  }

  const onUp = () => {
    if (!drawing.current) return
    drawing.current = false
    const el = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (el && el.points.length > 1) {
      save([...elsRef.current, el])
      force((v) => v + 1)
    }
  }

  const renderPath = (el) => {
    const pts = el.points || []
    if (!pts.length) return null
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
    return (
      <path
        key={el.id}
        d={d}
        fill="none"
        stroke={el.color}
        strokeWidth={el.width}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )
  }

  const canUndo = past.current.length > 0
  const canRedo = future.current.length > 0
  void tick

  return (
    <div className={`draw-layer ${active ? 'is-active' : ''}`}>
      <svg
        ref={svgRef}
        className="draw-svg"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {elements.map(renderPath)}
        {draft && renderPath(draft)}
      </svg>

      {active && (
        <div className="draw-tools">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`cb-swatch ${!eraser && color === c ? 'is-active' : ''}`}
              style={{ background: c }}
              onClick={() => {
                setColor(c)
                setEraser(false)
              }}
              title={c}
            />
          ))}
          <span className="cb-sep" />
          {WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              className={`cb-tool ${width === w && !eraser ? 'is-active' : ''}`}
              onClick={() => setWidth(w)}
              title={`${w} px`}
            >
              <span className="cb-dot" style={{ width: w + 3, height: w + 3 }} />
            </button>
          ))}
          <span className="cb-sep" />
          <button
            type="button"
            className={`cb-tool ${eraser ? 'is-active' : ''}`}
            onClick={() => setEraser((v) => !v)}
            title="Ластик"
          >
            🧽
          </button>
          <button type="button" className="cb-tool" onClick={undo} disabled={!canUndo} title="Отменить">
            ↶
          </button>
          <button type="button" className="cb-tool" onClick={redo} disabled={!canRedo} title="Повторить">
            ↷
          </button>
          <button type="button" className="cb-tool cb-clear" onClick={clearAll} title="Стереть рисунок">
            Стереть
          </button>
        </div>
      )}
    </div>
  )
})

export default DrawLayer
