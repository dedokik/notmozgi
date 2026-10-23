import { useMemo } from 'react'
import { ReactFlow, MiniMap, Controls, Background, MarkerType } from '@xyflow/react'
// стили react-flow подключены в src/index.css (один общий app.css)
import { buildEdges } from '../lib/links.js'

// Эго-граф одной заметки: центр + прямые соседи (входящие и исходящие связи).
export default function GraphView({ notes, manualLinks, dims, enabledDims, activeId, onSelect, onOpen }) {
  const dimById = useMemo(() => Object.fromEntries(dims.map((d) => [d.id, d])), [dims])
  const center = notes.find((n) => n.id === activeId) || null

  const { nodes, edges } = useMemo(() => {
    if (!center) return { nodes: [], edges: [] }
    const byId = new Map(notes.map((n) => [n.id, n]))
    const rel = buildEdges(notes, manualLinks).filter((e) => e.from === center.id || e.to === center.id)
    const nbIds = [...new Set(rel.flatMap((e) => [e.from, e.to]))].filter((id) => id !== center.id)
    const visNb = nbIds.map((id) => byId.get(id)).filter((n) => n && enabledDims.has(n.dimension))
    const visSet = new Set(visNb.map((n) => n.id))

    const nodeStyle = (n, isCenter) => ({
      background: 'var(--panel-2)',
      color: 'var(--text)',
      border: `${isCenter ? 2 : 1}px solid ${dimById[n.dimension]?.color || 'var(--border)'}`,
      borderRadius: 6,
      padding: 8,
      fontSize: 12,
      width: isCenter ? 250 : 210,
    })

    const nodes = [{
      id: String(center.id),
      position: { x: 0, y: 0 },
      data: { label: center.title || 'Без названия' },
      style: nodeStyle(center, true),
    }]
    visNb.forEach((n, i) => {
      const a = (i / Math.max(visNb.length, 1)) * Math.PI * 2 - Math.PI / 2
      nodes.push({
        id: String(n.id),
        position: { x: Math.cos(a) * 300 - 105, y: Math.sin(a) * 220 - 20 },
        data: { label: n.title || 'Без названия' },
        style: nodeStyle(n, false),
      })
    })

    const star = rel.filter((e) =>
      (e.from === center.id && visSet.has(e.to)) || (e.to === center.id && visSet.has(e.from))
    )
    const edges = star.map((e, i) => ({
      id: `e${i}`,
      source: String(e.from),
      target: String(e.to),
      markerEnd: { type: MarkerType.ArrowClosed },
      style: e.auto
        ? { stroke: dimById[byId.get(e.from)?.dimension]?.color || 'var(--accent)', strokeWidth: 2 }
        : { stroke: 'var(--accent)', strokeWidth: 2, strokeDasharray: '6 4' },
    }))
    return { nodes, edges }
  }, [notes, manualLinks, center, enabledDims, dimById])

  if (!center) return <div className="opacity-50">Выбери заметку, чтобы увидеть её граф.</div>

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 text-sm mb-2 flex-wrap">
        <b className="truncate">Граф: {center.title || 'Без названия'}</b>
        <button className="text-xs px-2 py-1 rounded panel" onClick={() => onOpen(center.id)}>Открыть в редакторе</button>
        <div className="flex-1" />
        <span className="flex items-center gap-1 text-xs opacity-70"><span className="inline-block w-6 border-t-2" /> авто [[связь]</span>
        <span className="flex items-center gap-1 text-xs opacity-70"><span className="inline-block w-6 border-t-2 border-dashed" /> ручная</span>
        <span className="text-xs opacity-50">связей: {edges.length}. Клик по соседу — перейти к нему.</span>
      </div>
      {nodes.length <= 1 ? (
        <div className="panel rounded p-4 text-sm opacity-60">
          Связей нет. Добавь в текст <code>[[Название заметки]]</code> или ручную связь в редакторе — сосед появится здесь.
        </div>
      ) : (
        <div className="flex-1 panel rounded overflow-hidden" style={{ minHeight: 420 }} key={String(center.id)}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodeClick={(_, n) => { const id = Number(n.id); if (id !== center.id) onSelect(id) }}
            colorMode="dark"
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>
      )}
    </div>
  )
}
