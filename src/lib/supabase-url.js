// Адрес проекта Supabase.
//
// Люди часто копируют из настроек только ref проекта (например
// `jeehzjznaqwgdjanykcp`), а клиенту нужен полный адрес. Понимаем оба вида,
// чтобы не ловить «Invalid URL» на пустом месте.
export function normalizeSupabaseUrl(raw) {
  const v = (raw || '').trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, '')
  if (/^[a-z0-9][a-z0-9-]{8,}$/i.test(v)) return `https://${v}.supabase.co`
  return v
}
