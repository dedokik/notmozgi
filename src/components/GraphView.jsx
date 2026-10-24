import { useEffect, useMemo, useRef, useState } from 'react'
import { buildEdges } from '../lib/links.js'

// Граф всех заметок сразу (не «эго-граф» одной заметки).
// Каждое измерение — свой узел-хаб: все заметки измерения соединены с ним,
// поэтому видно, что они уже связаны, даже без [[ссылок]].
// Поверх графа можно рисовать маркером (стрелки между блоками, обводки).

const NODE_R = 24
const HUB_R = 32
const MIN_Z = 0.25
const MAX_Z = 2.5
const PEN_COLORS = ['#e8e8ea', '#3b82f6', '#22c55e', '#fb923c', '#ef4444', '#8b5cf6']
const PEN_WIDTHS = [2, 4, 8]

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const uid = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

// Раскладка без физики: хабы измерений по кругу, заметки — кольцами вокруг хаба.
// Детерминированная, поэтому рисунок поверх графа остаётся на месте.
// Раскладка: хабы измерений по кругу, заметки — спиралью Фибоначчи вокруг
// своего хаба. Спираль равномерно заполняет площадь, поэтому 10 заметок и 200
// выглядят одинаково аккуратно (кольца при 50+ наезжали друг на друга).
const GOLDEN = 2.399963229728653
const SPACING = 58

function computeLayout(notes, dimsList) {
  const out = {}
  const n = dimsList.length || 1
  const perDim = dimsList.map((d) => notes.filter((x) => x.dimension === d.id))

  // радиус, который занимает самое большое измерение
  const maxExtent = perDim.reduce((m, list) => Math.max(m, SPACING * Math.sqrt(list.length + 1) + 70), 90)
  const hubRing = n === 1 ? 0 : Math.max(340, maxExtent + 120)

  dimsList.forEach((d, di) => {
    const a = n === 1 ? 0 : (di / n) * Math.PI * 2 - Math.PI / 2
    const hx = Math.cos(a) * hubRing
    const hy = Math.sin(a) * hubRing
    out[`dim:${d.id}`] = [hx, hy]

    perDim[di].forEach((note, i) => {
      const ang = i * GOLDEN
      const r = SPACING * Math.sqrt(i + 0.55)
      out[`note:${note.id}`] = [hx + Math.cos(ang) * r, hy + Math.sin(ang) * r]
    })
  })
  return out
}

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

const shortTitle = (t, max = 20) => {
  const s = (t || 'Без названия').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export default function GraphView({
  notes,
  manualLinks,
  dims,
  enabledDims,
  activeId,
  onOpen,
  positions,
  onPositionsChange,
  drawData,
  onDrawChange,
  dimFilter,
  onDimFilter,
}) {
  const [tool, setTool] = useState('select') // select | pen | eraser
  const [color, setColor] = useState(PEN_COLORS[1])
  const [width, setWidth] = useState(4)
  const [view, setView] = useState({ x: 0, y: 0, zoom: 0.85 })
  const [dimLinks, setDimLinks] = useState(true)
  const [strokes, setStrokes] = useState(() => (drawData?.elements ? drawData.elements : []))
  const [draftStroke, setDraftStroke] = useState(null)
  const [pos, setPos] = useState(() => ({ ...(positions || {}) }))
  const [tick, force] = useState(0)

  const svgRef = useRef(null)
  const wrapRef = useRef(null)
  const strokesRef = useRef(strokes)
  strokesRef.current = strokes
  const posRef = useRef(pos)
  posRef.current = pos
  const draftRef = useRef(null)
  const past = useRef([])
  const future = useRef([])
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const pinch = useRef(null)

  // 'all' — все измерения, иначе показываем только одно (свой цвет = своё измерение)
  const scope = dimFilter && dimFilter !== 'all' ? dimFilter : null
  const visible = useMemo(
    () => notes.filter((n) => enabledDims.has(n.dimension) && (!scope || n.dimension === scope)),
    [notes, enabledDims, scope]
  )
  const dimsList = useMemo(
    () =>
      dims.filter(
        (d) => enabledDims.has(d.id) && (!scope || d.id === scope) && visible.some((n) => n.dimension === d.id)
      ),
    [dims, enabledDims, visible, scope]
  )
  const computed = useMemo(() => computeLayout(visible, dimsList), [visible, dimsList])

  // чем больше заметок, тем мельче узлы и подписи — иначе граф превращается в кашу
  const density = visible.length
  const nodeR = density > 90 ? 11 : density > 50 ? 14 : density > 24 ? 18 : NODE_R
  const showLabels = density <= 45
  const labelSize = density > 30 ? 10 : 12
  const at = (key) => pos[key] || computed[key] || [0, 0]

  // настройки графа читаются из базы асинхронно: если граф успел открыться
  // раньше, подхватываем сохранённые позиции и рисунок один раз
  const syncedPos = useRef(false)
  useEffect(() => {
    if (syncedPos.current || !positions) return
    if (!Object.keys(positions).length) return
    syncedPos.current = true
    setPos({ ...positions })
  }, [positions])

  const syncedDraw = useRef(false)
  useEffect(() => {
    if (syncedDraw.current) return
    const els = drawData?.elements
    if (!els || !els.length) return
    syncedDraw.current = true
    if (strokesRef.current.length) return
    setStrokes(els)
    strokesRef.current = els
  }, [drawData])

  const edges = useMemo(() => buildEdges(visible, manualLinks), [visible, manualLinks])

  const toWorld = (clientX, clientY) => {
    const r = svgRef.current.getBoundingClientRect()
    return { x: (clientX - r.left - view.x) / view.zoom, y: (clientY - r.top - view.y) / view.zoom }
  }

  const saveStrokes = (next) => {
    setStrokes(next)
    strokesRef.current = next
    onDrawChange?.({ version: 1, elements: next })
  }

  const commitStroke = (el) => {
    past.current.push(strokesRef.current)
    if (past.current.length > 60) past.current.shift()
    future.current = []
    saveStrokes([...strokesRef.current, el])
    force((v) => v + 1)
  }

  const undo = () => {
    if (!past.current.length) return
    const prev = past.current.pop()
    future.current.push(strokesRef.current)
    saveStrokes(prev)
    force((v) => v + 1)
  }

  const redo = () => {
    if (!future.current.length) return
    const next = future.current.pop()
    past.current.push(strokesRef.current)
    saveStrokes(next)
    force((v) => v + 1)
  }

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
        const z = clamp(v.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_Z, MAX_Z)
        const wx = (mx - v.x) / v.zoom
        const wy = (my - v.y) / v.zoom
        return { zoom: z, x: mx - wx * z, y: my - wy * z }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const hitNode = (p) => {
    for (const d of dimsList) {
      const [x, y] = at(`dim:${d.id}`)
      if (Math.hypot(p.x - x, p.y - y) <= HUB_R) return { kind: 'dim', id: d.id }
    }
    for (const n of visible) {
      const [x, y] = at(`note:${n.id}`)
      if (Math.hypot(p.x - x, p.y - y) <= nodeR) return { kind: 'note', id: n.id }
    }
    return null
  }

  const eraseAt = (p) => {
    const tol = 10 / view.zoom + 4
    const list = strokesRef.current
    for (let i = list.length - 1; i >= 0; i--) {
      if (strokeHit(list[i], p, tol)) {
        saveStrokes(list.filter((_, k) => k !== i))
        return
      }
    }
  }

  const onPointerDown = (e) => {
    if (e.button === 2) return
    try {
      svgRef.current.setPointerCapture(e.pointerId)
    } catch {
      /* не критично */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.current.size === 2) {
      gesture.current = null
      draftRef.current = null
      setDraftStroke(null)
      const [a, b] = [...pointers.current.values()]
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: { ...view },
      }
      return
    }

    const p = toWorld(e.clientX, e.clientY)

    if (tool === 'pen') {
      const el = { id: uid(), type: 'path', color, width, points: [[p.x, p.y]] }
      draftRef.current = el
      setDraftStroke({ ...el })
      return
    }
    if (tool === 'eraser') {
      past.current.push(strokesRef.current)
      if (past.current.length > 60) past.current.shift()
      future.current = []
      gesture.current = { type: 'erase' }
      eraseAt(p)
      force((v) => v + 1)
      return
    }

    const hit = hitNode(p)
    if (hit && hit.kind === 'note') {
      const [nx, ny] = at(`note:${hit.id}`)
      gesture.current = { type: 'drag', id: hit.id, dx: p.x - nx, dy: p.y - ny, moved: 0 }
    } else {
      gesture.current = { type: 'pan', origin: { x: e.clientX, y: e.clientY }, view0: { ...view } }
    }
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
        const z = clamp((v0.zoom * dist) / pinch.current.dist, MIN_Z, MAX_Z)
        const wx = (pinch.current.mid.x - r.left - v0.x) / v0.zoom
        const wy = (pinch.current.mid.y - r.top - v0.y) / v0.zoom
        setView({ zoom: z, x: mid.x - r.left - wx * z, y: mid.y - r.top - wy * z })
      }
      return
    }

    const p = toWorld(e.clientX, e.clientY)

    if (draftRef.current) {
      const el = draftRef.current
      const last = el.points[el.points.length - 1]
      if (Math.hypot(p.x - last[0], p.y - last[1]) > 0.6) {
        el.points.push([p.x, p.y])
        setDraftStroke({ ...el, points: el.points.slice() })
      }
      return
    }

    const g = gesture.current
    if (!g) return

    if (g.type === 'pan') {
      setView({ ...g.view0, x: g.view0.x + (e.clientX - g.origin.x), y: g.view0.y + (e.clientY - g.origin.y) })
      return
    }
    if (g.type === 'erase') {
      eraseAt(p)
      return
    }
    if (g.type === 'drag') {
      const key = `note:${g.id}`
      const [startX, startY] = at(key)
      const nx = p.x - g.dx
      const ny = p.y - g.dy
      g.moved = Math.max(g.moved, Math.hypot(nx - startX, ny - startY))
      setPos((prev) => ({ ...prev, [key]: [nx, ny] }))
    }
  }

  const finish = (e) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null

    const el = draftRef.current
    draftRef.current = null
    setDraftStroke(null)
    if (el && el.points.length > 1) commitStroke(el)

    const g = gesture.current
    gesture.current = null
    if (!g) return

    if (g.type === 'drag') {
      if (g.moved < 4) {
        // это был тап, а не перетаскивание — открываем заметку
        onOpen?.(g.id)
      } else {
        onPositionsChange?.({ ...posRef.current })
      }
    }
  }

  const fit = () => {
    const pts = [...dimsList.map((d) => at(`dim:${d.id}`)), ...visible.map((n) => at(`note:${n.id}`))]
    if (!pts.length) return
    const r = wrapRef.current.getBoundingClientRect()
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const minX = Math.min(...xs) - 120
    const maxX = Math.max(...xs) + 120
    const minY = Math.min(...ys) - 120
    const maxY = Math.max(...ys) + 120
    const z = clamp(Math.min(r.width / (maxX - minX), r.height / (maxY - minY)), MIN_Z, MAX_Z)
    setView({
      zoom: z,
      x: (r.width - (maxX - minX) * z) / 2 - minX * z,
      y: (r.height - (maxY - minY) * z) / 2 - minY * z,
    })
  }

  // при смене измерения (и при изменении числа заметок) вписываем граф в экран
  useEffect(() => {
    if (!visible.length) return
    const t = setTimeout(() => fit(), 80)
    return () => clearTimeout(t)
  }, [scope, visible.length])

  const zoomBy = (k) => {
    const r = wrapRef.current.getBoundingClientRect()
    const mx = r.width / 2
    const my = r.height / 2
    setView((v) => {
      const z = clamp(v.zoom * k, MIN_Z, MAX_Z)
      const wx = (mx - v.x) / v.zoom
      const wy = (my - v.y) / v.zoom
      return { zoom: z, x: mx - wx * z, y: my - wy * z }
    })
  }

  const clearDraw = () => {
    if (!strokesRef.current.length) return
    if (!window.confirm('Стереть весь рисунок поверх графа?')) return
    past.current.push(strokesRef.current)
    future.current = []
    saveStrokes([])
    force((v) => v + 1)
  }

  const dimById = useMemo(() => Object.fromEntries(dims.map((d) => [d.id, d])), [dims])
  const byId = useMemo(() => new Map(visible.map((n) => [n.id, n])), [visible])

  const renderStroke = (el) => {
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
  void tick // перерисовка кнопок undo/redo

  return (
    <div className="gv-wrap" ref={wrapRef}>
      <div className="gv-toolbar">
        <button
          className={`cb-tool ${tool === 'select' ? 'is-active' : ''}`}
          onClick={() => setTool('select')}
          title="Двигать граф и заметки"
        >
          ✋
        </button>
        <button
          className={`cb-tool ${tool === 'pen' ? 'is-active' : ''}`}
          onClick={() => setTool('pen')}
          title="Рисовать поверх графа"
        >
          ✏️
        </button>
        <button
          className={`cb-tool ${tool === 'eraser' ? 'is-active' : ''}`}
          onClick={() => setTool('eraser')}
          title="Ластик"
        >
          🧽
        </button>

        {tool !== 'select' && (
          <>
            <span className="cb-sep" />
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                className={`cb-swatch ${color === c ? 'is-active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={c}
              />
            ))}
            <span className="cb-sep" />
            {PEN_WIDTHS.map((w) => (
              <button
                key={w}
                className={`cb-tool ${width === w ? 'is-active' : ''}`}
                onClick={() => setWidth(w)}
                title={`${w} px`}
              >
                <span className="cb-dot" style={{ width: w + 3, height: w + 3 }} />
              </button>
            ))}
            <span className="cb-sep" />
            <button className="cb-tool" onClick={undo} disabled={!canUndo} title="Отменить">
              ↶
            </button>
            <button className="cb-tool" onClick={redo} disabled={!canRedo} title="Повторить">
              ↷
            </button>
            <button className="cb-tool cb-clear" onClick={clearDraw} title="Стереть рисунок">
              Стереть
            </button>
          </>
        )}

        <span className="cb-sep" />
        <button
          className="cb-tool"
          style={dimLinks ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
          onClick={() => setDimLinks((v) => !v)}
          title="Показывать связи внутри измерений"
        >
          ⇄
        </button>
        <button className="cb-tool" onClick={() => zoomBy(1 / 1.2)} title="Мельче">
          −
        </button>
        <button className="cb-tool" onClick={() => zoomBy(1.2)} title="Крупнее">
          +
        </button>
        <button className="cb-tool cb-fit" onClick={fit} title="Показать всё">
          ⤢
        </button>

        <span className="cb-sep" />
        <div className="gv-dims">
          <button
            type="button"
            className={`gv-dim ${!scope ? 'is-on' : ''}`}
            onClick={() => onDimFilter?.('all')}
            title="Все измерения"
          >
            Все
          </button>
          {dims
            .filter((d) => enabledDims.has(d.id))
            .map((d) => (
              <button
                key={d.id}
                type="button"
                className={`gv-dim ${scope === d.id ? 'is-on' : ''}`}
                onClick={() => onDimFilter?.(d.id)}
                style={scope === d.id ? { borderColor: d.color, background: d.color + '22', fontWeight: 700 } : {}}
                title={`Только «${d.name}»`}
              >
                <span className="gv-dim-dot" style={{ background: d.color }} />
                {d.name}
              </button>
            ))}
        </div>
      </div>

      <svg
        ref={svgRef}
        className="gv-svg"
        style={{ cursor: tool === 'select' ? 'grab' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <marker
            id="gv-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
          </marker>
        </defs>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          {/* связи измерений: каждая заметка соединена со своим хабом */}
          {dimLinks &&
            dimsList.map((d) => {
              const [hx, hy] = at(`dim:${d.id}`)
              return visible
                .filter((n) => n.dimension === d.id)
                .map((n) => {
                  const [x, y] = at(`note:${n.id}`)
                  return (
                    <line
                      key={`dl-${d.id}-${n.id}`}
                      x1={hx}
                      y1={hy}
                      x2={x}
                      y2={y}
                      stroke={d.color}
                      strokeWidth={1.5}
                      strokeDasharray="5 5"
                      opacity={0.35}
                    />
                  )
                })
            })}

          {/* явные связи [[..]] и ручные */}
          {edges.map((e, i) => {
            const [x1, y1] = at(`note:${e.from}`)
            const [x2, y2] = at(`note:${e.to}`)
            if (!byId.has(e.from) || !byId.has(e.to)) return null
            return (
              <line
                key={`e${i}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={e.auto ? dimById[byId.get(e.from)?.dimension]?.color || 'var(--accent)' : 'var(--accent)'}
                strokeWidth={2}
                strokeDasharray={e.auto ? undefined : '7 5'}
                markerEnd="url(#gv-arrow)"
                opacity={0.9}
              />
            )
          })}

          {/* рисунок поверх — под узлами, чтобы узлы оставались читаемыми */}
          {strokes.map(renderStroke)}
          {draftStroke && renderStroke(draftStroke)}

          {/* хабы измерений */}
          {dimsList.map((d) => {
            const [x, y] = at(`dim:${d.id}`)
            return (
              <g key={`hub-${d.id}`}>
                <circle cx={x} cy={y} r={HUB_R} fill={d.color} opacity={0.18} />
                <circle cx={x} cy={y} r={HUB_R} fill="none" stroke={d.color} strokeWidth={2} />
                <text x={x} y={y + 5} textAnchor="middle" fontSize={13} fontWeight="700" fill={d.color}>
                  {d.name}
                </text>
              </g>
            )
          })}

          {/* заметки */}
          {visible.map((n) => {
            const [x, y] = at(`note:${n.id}`)
            const c = dimById[n.dimension]?.color || 'var(--border)'
            const isActive = n.id === activeId
            return (
              <g key={`n-${n.id}`}>
                {isActive && (
                  <circle cx={x} cy={y} r={nodeR + 4} fill="none" stroke="var(--accent)" strokeWidth={2} />
                )}
                <circle cx={x} cy={y} r={nodeR} fill={c} opacity={n.is_pinned ? 0.95 : 0.75} />
                {n.note_type === 'canvas' && nodeR > 15 && (
                  <text x={x} y={y + 5} textAnchor="middle" fontSize={14} fill="#0d0d10">
                    🎨
                  </text>
                )}
                {!!n.is_pinned && (
                  <text x={x + nodeR - 2} y={y - nodeR + 4} textAnchor="middle" fontSize={13}>
                    📌
                  </text>
                )}
                {showLabels && (
                  <text
                    x={x}
                    y={y + nodeR + 14}
                    textAnchor="middle"
                    fontSize={labelSize}
                    fill="var(--text)"
                    opacity={0.85}
                  >
                    {shortTitle(n.title, density > 30 ? 14 : 20)}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      {!visible.length && (
        <div className="gv-empty">
          <div>
            {scope ? 'В этом измерении пока нет заметок.' : 'Нет заметок в выбранных измерениях.'}
            {scope && (
              <button type="button" className="chip" style={{ marginLeft: 10 }} onClick={() => onDimFilter?.('all')}>
                Показать все
              </button>
            )}
          </div>
        </div>
      )}

      <div className="gv-legend">
        <span>
          <i className="gv-dash" /> связи внутри измерения
        </span>
        <span>
          <i className="gv-solid" /> [[ссылки]] между заметками
        </span>
        <span className="gv-hint">тап — открыть · тяни — двигать · ✏️ — рисовать</span>
      </div>
    </div>
  )
}
