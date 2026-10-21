import { useEffect, useRef, useState } from 'react'

// Панель рукописного ввода (Gboard / stylus) перекрывает низ экрана.
// visualViewport — единственный надёжный способ узнать, сколько места заняла панель.
// Держим активное поле над ней, чтобы было видно, что именно пишешь.
export function useViewportShift() {
  const ref = useRef(null)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let raf = 0
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
        document.documentElement.style.setProperty('--kb', `${overlap}px`)
        const el = ref.current
        if (!el || overlap < 60) return
        const r = el.getBoundingClientRect()
        if (r.bottom > vv.height - 12) {
          el.scrollIntoView({ block: 'end', behavior: 'smooth' })
        }
      })
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      cancelAnimationFrame(raf)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.documentElement.style.setProperty('--kb', '0px')
    }
  }, [])

  return ref
}

// Планшет/стилус или мышь+клавиатура — от этого зависят размеры зон нажатия.
export function useCoarsePointer() {
  const [coarse, setCoarse] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(pointer: coarse)').matches
      : false
  )
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia('(pointer: coarse)')
    const on = (e) => setCoarse(e.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return coarse
}
