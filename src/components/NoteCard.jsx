import { memo } from 'react'

// Карточка заметки в списке. Крупные зоны нажатия — под палец и стилус
// (Xiaomi Pad 6): вся карточка открывает заметку, булавка — отдельная
// кнопка 44×44, удаление спрятано за confirm.
function NoteCard({
  note,
  dim,
  active,
  deadline,
  daysLeft,
  doneHours = 0,
  totalHours = 0,
  onOpen,
  onDelete,
  onTogglePin,
}) {
  const pinned = !!note.is_pinned
  const isCanvas = note.note_type === 'canvas'

  return (
    <div
      className={`note-card ${active ? 'is-active' : ''} ${pinned ? 'is-pinned' : ''}`}
      onClick={() => onOpen(note.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(note.id)
        }
      }}
    >
      <div className="note-card-row">
        <span className="note-dot" style={{ background: dim?.color || 'var(--border)' }} />

        <b className="note-title">{note.title || 'Без названия'}</b>

        {isCanvas && (
          <span className="note-badge" title="Холст">
            🎨
          </span>
        )}

        <button
          type="button"
          className={`pin-btn ${pinned ? 'is-on' : ''}`}
          title={pinned ? 'Открепить' : 'Закрепить'}
          aria-pressed={pinned}
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin(note.id)
          }}
        >
          {pinned ? '📌' : '📍'}
        </button>

        <button
          type="button"
          className="del-btn"
          title="Удалить заметку"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(note.id, note.title)
          }}
        >
          ✕
        </button>
      </div>

      <div className="note-snippet">
        {isCanvas ? 'Холст · схема стилусом' : (note.body || '').replace(/[#*`>]/g, '').slice(0, 90) || 'Пусто'}
      </div>

      {deadline && (
        <div className={`note-meta ${daysLeft < 0 ? 'is-overdue' : ''}`}>
          дедлайн {deadline}
          {typeof daysLeft === 'number' && (
            <span> · {daysLeft < 0 ? `просрочено ${-daysLeft} дн.` : daysLeft === 0 ? 'сегодня' : `осталось ${daysLeft} дн.`}</span>
          )}
        </div>
      )}

      {totalHours > 0 && (
        <div className="note-meta">
          план {Math.round(doneHours * 10) / 10}/{Math.round(totalHours * 10) / 10} ч.
        </div>
      )}
    </div>
  )
}

export default memo(NoteCard)
