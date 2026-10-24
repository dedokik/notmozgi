// Кэш производных данных по заметке.
//
// Поиск и разбор дедлайнов раньше пересчитывались по ВСЕМ заметкам на каждый
// рендер: при 300 заметках по 50 КБ это десятки мегабайт текста на каждое
// нажатие клавиши (автосохранение меняет состояние списка). Здесь результат
// считается один раз на версию заметки: правится одна заметка — пересчёт
// только для неё.

export function makeNoteCache() {
  const store = new Map()

  return function cached(note, key, build) {
    const rev = note.updatedAt || 0
    let entry = store.get(note.id)
    if (!entry || entry.rev !== rev) {
      entry = { rev, values: {} }
      store.set(note.id, entry)
    }
    if (!(key in entry.values)) entry.values[key] = build(note)
    return entry.values[key]
  }
}
