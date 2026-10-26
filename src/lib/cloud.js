// Тонкая обёртка над облаком.
//
// supabase-js весит ~120 КБ, а нужен только тем, у кого вписаны ключи.
// Здесь мы считаем флаг «облако настроено» без тяжёлого импорта, а сам
// модуль подгружаем лениво — при первом реальном обращении.

import { normalizeSupabaseUrl } from './supabase-url.js'

const cfg = (typeof window !== 'undefined' && window.__NOT_CONFIG__) || {}

const URL = normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL || cfg.supabaseUrl || '')
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || cfg.supabaseAnonKey || ''

export const cloudEnabled = Boolean(URL && KEY)

let mod = null
function load() {
  if (!mod) mod = import('./supabase.js')
  return mod
}

export const syncNow = async (opts) => (await load()).syncNow(opts)
export const cleanupDuplicates = async () => (await load()).cleanupDuplicates()
export const cloudNoteCount = async () => (await load()).cloudNoteCount()
export const pushEverything = async () => (await load()).pushEverything()
export const authSession = async () => (await load()).authSession()
export const authSignIn = async (email, password) => (await load()).authSignIn(email, password)
export const authSignUp = async (email, password) => (await load()).authSignUp(email, password)
export const authSignOut = async () => (await load()).authSignOut()

// Возвращает функцию отписки (асинхронно, потому что модуль грузится лениво)
export async function subscribeAuth(cb) {
  const m = await load()
  return m.onAuthChange(cb)
}
