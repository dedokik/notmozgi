import { useEffect, useRef, useState } from 'react'

// Модалка «новое событие»: вызывается тапом по дню в сетке календаря.
// Все зоны нажатия крупные — попадать стилусом/пальцем.
export default function EventModal({ day, dims, onClose, onCreate }) {
  const [title, setTitle] = useState('')
  const [dim, setDim] = useState(dims[0]?.id || '')
  const [pinned, setPinned] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const submit = () => {
    const v = title.trim()
    if (!v) return
    onCreate(v, dim || null, pinned)
    setTitle('')
  }

  const label = day ? day.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }) : ''

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="text-xs uppercase opacity-50 mb-1">Новое событие</div>
        <div className="text-lg font-bold mb-3 capitalize">{label}</div>

        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="Встреча в 15:00"
          className="w-full text-lg rounded px-4 py-3 mb-3"
        />

        <div className="text-xs uppercase opacity-50 mb-2">Измерение</div>
        <div className="flex flex-wrap gap-2 mb-3">
          {dims.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDim(d.id)}
              className="px-4 py-2.5 rounded panel flex items-center gap-2"
              style={dim === d.id ? { borderColor: d.color, background: d.color + '22', fontWeight: 700 } : {}}
            >
              <span className="w-3 h-3 rounded-sm inline-block" style={{ background: d.color }} />
              {d.name}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setPinned((v) => !v)}
          className="w-full mb-4 px-4 py-3 rounded panel flex items-center justify-center gap-2"
          style={pinned ? { borderColor: 'var(--accent)', fontWeight: 700 } : {}}
          aria-pressed={pinned}
        >
          <span style={{ fontSize: 20 }}>{pinned ? '📌' : '📍'}</span>
          {pinned ? 'Важная дата — будет закреплена' : 'Закрепить как важную дату'}
        </button>

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 px-4 py-3 rounded panel">
            Отмена
          </button>
          <button
            onClick={submit}
            className="flex-1 px-4 py-3 rounded accent-bg text-black font-bold"
            style={!title.trim() ? { opacity: 0.5 } : undefined}
          >
            Добавить
          </button>
        </div>
      </div>
    </div>
  )
}
