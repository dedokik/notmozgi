import { useEffect, useRef, useState } from 'react'

const COLORS = [
  { c: '#e8e8ea', n: 'белый' },
  { c: '#3b82f6', n: 'синий' },
  { c: '#fb923c', n: 'оранжевый' },
  { c: '#22c55e', n: 'зелёный' },
  { c: '#ef4444', n: 'красный' },
  { c: '#8b5cf6', n: 'фиолетовый' },
]
const WIDTHS = [2, 4, 8, 16]
const BG = '#141418'

// Блок-холст внутри заметки: стилус работает как карандаш/маркер.
// Результат вставляется в текст заметки как картинка (markdown).
export default function HandwritingPad({ onSave, onClose }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const drawing = useRef(false)
  const last = useRef(null)
  const strokes = useRef([])
  const redo = useRef(null)

  const [color, setColor] = useState(COLORS[0].c)
  const [width, setWidth] = useState(4)
  const [eraser, setEraser] = useState(false)

  // холст всегда подгоняется под контейнер и перерисовывается при ресайзе
  useEffect(() => {
    const c = canvasRef.current
    const wrap = wrapRef.current
    if (!c || !wrap) return
    const fit = () => {
      const r = wrap.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const old = strokes.current
      c.width = Math.max(1, Math.round(r.width * dpr))
      c.height = Math.max(1, Math.round(r.height * dpr))
      const ctx = c.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = BG
      ctx.fillRect(0, 0, r.width, r.height)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      redraw(old)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  const redraw = (list) => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    const r = c.getBoundingClientRect()
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, r.width, r.height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of list) {
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.beginPath()
      const p0 = s.points[0]
      if (!p0) continue
      ctx.moveTo(p0.x, p0.y)
      for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y)
      if (s.points.length === 1) ctx.lineTo(p0.x + 0.1, p0.y)
      ctx.stroke()
    }
  }

  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const start = (e) => {
    e.preventDefault()
    const c = canvasRef.current
    try { c.setPointerCapture(e.pointerId) } catch { /* не критично */ }
    drawing.current = true
    const p = pos(e)
    last.current = p
    strokes.current.push({
      color: eraser ? BG : color,
      width: eraser ? width * 4 : width,
      points: [p],
    })
    redo.current = null
  }

  const move = (e) => {
    if (!drawing.current) return
    e.preventDefault()
    const c = canvasRef.current
    const ctx = c.getContext('2d')
    const s = strokes.current[strokes.current.length - 1]
    if (!s) return
    // сглаживание: stylus шлёт события чаще, чем кадры — берём coalesced-точки
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]
    for (const ev of evs) {
      const p = pos(ev)
      s.points.push(p)
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.beginPath()
      ctx.moveTo(last.current.x, last.current.y)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      last.current = p
    }
  }

  const end = () => { drawing.current = false; last.current = null }

  const undoStroke = () => {
    const s = strokes.current.pop()
    if (!s) return
    if (!redo.current) redo.current = []
    redo.current.push(s)
    redraw(strokes.current)
  }

  const redoStroke = () => {
    if (!redo.current || !redo.current.length) return
    const s = redo.current.pop()
    strokes.current.push(s)
    redraw(strokes.current)
  }

  const clearAll = () => {
    strokes.current = []
    redo.current = null
    redraw(strokes.current)
  }

  // вставляем в заметку PNG ограниченного размера (чтобы не раздувать базу)
  const save = () => {
    const c = canvasRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    const maxW = 1280
    const scale = Math.min(1, maxW / r.width)
    const out = document.createElement('canvas')
    out.width = Math.round(r.width * scale)
    out.height = Math.round(r.height * scale)
    const ctx = out.getContext('2d')
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(c, 0, 0, out.width, out.height)
    onSave(out.toDataURL('image/png'))
  }

  return (
    <div className="modal-backdrop" style={{ padding: 12 }}>
      <div className="modal-card" style={{ width: 'min(1000px, 100%)', height: '92vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <b className="text-lg">Схема</b>
          <span className="text-xs opacity-50">пиши стилусом</span>
          <div className="flex-1" />
          <button onClick={onClose} className="px-3 py-2 rounded panel text-sm">Закрыть</button>
          <button onClick={save} className="px-4 py-2 rounded accent-bg text-black font-bold text-sm">Вставить в заметку</button>
        </div>

        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {COLORS.map((x) => (
            <button
              key={x.c}
              onClick={() => { setColor(x.c); setEraser(false) }}
              title={x.n}
              className="w-9 h-9 rounded-full shrink-0"
              style={{
                background: x.c,
                border: color === x.c && !eraser ? '2px solid var(--text)' : '1px solid var(--border)',
              }}
            />
          ))}
          <div className="w-px h-6 mx-1" style={{ background: 'var(--border)' }} />
          {WIDTHS.map((w) => (
            <button
              key={w}
              onClick={() => setWidth(w)}
              className="rounded panel px-3 py-2 flex items-center justify-center"
              style={width === w ? { borderColor: 'var(--accent)' } : {}}
            >
              <span className="rounded-full inline-block" style={{ width: w + 4, height: w + 4, background: 'var(--text)' }} />
            </button>
          ))}
          <button
            onClick={() => setEraser(!eraser)}
            className="px-3 py-2 rounded panel text-sm"
            style={eraser ? { borderColor: 'var(--accent)' } : {}}
          >
            Ластик
          </button>
          <div className="w-px h-6 mx-1" style={{ background: 'var(--border)' }} />
          <button onClick={undoStroke} className="px-3 py-2 rounded panel text-sm">↶</button>
          <button onClick={redoStroke} className="px-3 py-2 rounded panel text-sm">↷</button>
          <button onClick={clearAll} className="px-3 py-2 rounded panel text-sm">Очистить</button>
        </div>

        <div ref={wrapRef} className="flex-1 min-h-0">
          <canvas
            ref={canvasRef}
            className="pad-canvas"
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onPointerLeave={end}
          />
        </div>
      </div>
    </div>
  )
}
