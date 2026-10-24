// Сдвиг рисунка при правке текста.
//
// Штрихи лежат в координатах страницы. Если вставить текст ВЫШЕ рисунка,
// сам текст уезжает вниз, а штрихи остаются на месте. Здесь считаем, на
// сколько пикселей сместилась точка правки, и двигаем всё, что ниже неё.
//
// measureY(text, index) — сколько пикселей занимает текст до указанного
// символа. В приложении это делает скрытый div с теми же стилями, что у
// textarea (тогда учитывается перенос строк). В тестах подставляется простая
// функция.

export function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/**
 * @returns {{fromY:number, deltaY:number}|null} null — двигать нечего
 */
export function computeShift(prev, next, measureY) {
  if (prev === next) return null

  const p = commonPrefixLen(prev, next)

  // дописали в конец — выше ничего не сдвинулось
  if (p === prev.length && next.length > prev.length) return null

  // общий хвост: всё, что после правки, осталось прежним
  let s = 0
  const maxSuffix = Math.min(prev.length, next.length) - p
  while (
    s < maxSuffix &&
    prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)
  )
    s++

  // measureY(text, i) возвращает высоту текста до i-го символа вместе с
  // «строкой-маркером», поэтому вычитаем высоту одной строки
  const lineH = measureY(prev, 0) || 0
  const fromY = Math.max(0, measureY(prev, p) - lineH)
  const oldEnd = measureY(prev, prev.length - s) - lineH
  const newEnd = measureY(next, next.length - s) - lineH
  const deltaY = newEnd - oldEnd

  if (!isFinite(deltaY) || Math.abs(deltaY) < 1) return null
  return { fromY, deltaY }
}

// Двигает точки штрихов, которые находятся ниже fromY.
export function shiftStrokes(elements, fromY, deltaY) {
  let changed = false
  const out = elements.map((el) => {
    const pts = el.points || []
    if (!pts.some((p) => p[1] >= fromY)) return el
    changed = true
    return {
      ...el,
      points: pts.map(([x, y]) => [x, y >= fromY ? Math.max(0, y + deltaY) : y]),
    }
  })
  return changed ? out : null
}
