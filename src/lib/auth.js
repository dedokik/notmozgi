// Аккаунты.
//
// Два режима, один и тот же экран входа:
//  1) облако настроено (ключи Supabase вписаны) — вход через Supabase, данные
//     синхронизируются между устройствами;
//  2) облака нет — аккаунт живёт только на этом устройстве (пароль хранится
//     хэшем PBKDF2, 120 000 итераций, соль).
//
// В обоих режимах у аккаунта СВОЯ база заметок, поэтому чужой аккаунт видит
// пустое приложение, а не чужие записи.
import Dexie from 'dexie'
import { BASE_DB } from './db.js'
import { cloudEnabled, authSession, authSignIn, authSignUp, authSignOut } from './cloud.js'

const authDb = new Dexie('not-auth')
authDb.version(1).stores({ accounts: 'id, email' })
// v2: индекс по базе — нужно, чтобы понимать, кто уже занял базовую
authDb.version(2).stores({ accounts: 'id, email, dbName' })

const SESSION_KEY = 'not-session'

// true — вход через Supabase (данные едут между устройствами)
export const CLOUD = cloudEnabled

const normEmail = (e) => (e || '').trim().toLowerCase()

function makeId() {
  const rnd = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14)
  return `a${Date.now().toString(36)}${rnd}`
}

// PBKDF2, если браузер даёт WebCrypto (https/localhost). Иначе — слабый,
// но всё же не открытый текст запасной вариант для старых движков.
async function hashPassword(pass, salt) {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      const enc = new TextEncoder()
      const key = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits'])
      const bits = await subtle.deriveBits(
        { name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' },
        key,
        256
      )
      return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
    } catch {
      /* переходим к запасному варианту */
    }
  }
  let h = 2166136261
  const src = `${salt}|${pass}`
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `fnv:${(h >>> 0).toString(16)}`
}

// Какую базу отдать аккаунту:
//  - базовая (с уже существующими заметками) достаётся первому аккаунту;
//  - если базовую занял локальный аккаунт с ТОЙ ЖЕ почтой, отдаём её же
//    (человек завёл локальный вход, а потом включил облако — данные не теряются);
//  - все остальные получают свою пустую базу.
async function pickDbName(id, email) {
  const all = await authDb.accounts.toArray()
  const baseOwner = all.find((a) => a.dbName === BASE_DB)
  if (!baseOwner) return BASE_DB
  if (baseOwner.email && baseOwner.email === email) return BASE_DB
  return `${BASE_DB}-${id}`
}

// Запоминаем облачный аккаунт локально: id = id пользователя Supabase
async function rememberCloud(user) {
  const id = user.id
  const email = normEmail(user.email)
  const known = await authDb.accounts.get(id)
  if (known) return known
  const acc = { id, email, dbName: await pickDbName(id, email), cloud: true, createdAt: Date.now() }
  await authDb.accounts.put(acc)
  return acc
}

export async function listAccounts() {
  const all = await authDb.accounts.toArray()
  return all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

export async function hasAccounts() {
  // в облаке аккаунт может существовать на другом устройстве — форму входа
  // показываем всегда, а не «создать первый»
  if (CLOUD) return true
  return (await authDb.accounts.count()) > 0
}

function readSessionId() {
  try {
    return globalThis.localStorage?.getItem(SESSION_KEY) || null
  } catch {
    return null
  }
}

function writeSessionId(id) {
  try {
    if (id) globalThis.localStorage?.setItem(SESSION_KEY, id)
    else globalThis.localStorage?.removeItem(SESSION_KEY)
  } catch {
    /* приватный режим — сессия не сохранится, но работать можно */
  }
}

// Аккаунт, в котором сейчас работаем (или null)
export async function currentAccount() {
  if (CLOUD) {
    const s = await authSession()
    if (!s?.user) return null
    return rememberCloud(s.user)
  }
  const id = readSessionId()
  if (!id) return null
  const acc = await authDb.accounts.get(id)
  return acc || null
}

// Возвращает аккаунт либо { needsConfirm: true } (облако требует подтвердить почту)
export async function createAccount(email, pass) {
  const mail = normEmail(email)
  if (!mail.includes('@') || mail.length < 5) throw new Error('Нужна почта вида name@mail.ru')
  if ((pass || '').length < 4) throw new Error('Пароль слишком короткий — минимум 4 символа')

  if (CLOUD) {
    const r = await authSignUp(mail, pass)
    if (r.needsConfirm) return { needsConfirm: true }
    return rememberCloud(r.session.user)
  }

  const same = await authDb.accounts.where('email').equals(mail).first()
  if (same) throw new Error('Аккаунт с такой почтой уже есть на этом устройстве')

  const id = makeId()
  const salt = makeId()
  const acc = {
    id,
    email: mail,
    hash: await hashPassword(pass, salt),
    salt,
    dbName: await pickDbName(id, mail),
    createdAt: Date.now(),
  }
  await authDb.accounts.add(acc)
  writeSessionId(id)
  return acc
}

export async function loginAccount(email, pass) {
  const mail = normEmail(email)

  if (CLOUD) {
    const s = await authSignIn(mail, pass)
    if (!s?.user) throw new Error('Не удалось войти')
    return rememberCloud(s.user)
  }

  const acc = await authDb.accounts.where('email').equals(mail).first()
  if (!acc) throw new Error('Такого аккаунта на этом устройстве нет')
  const hash = await hashPassword(pass, acc.salt)
  if (hash !== acc.hash) throw new Error('Неверный пароль')
  writeSessionId(acc.id)
  return acc
}

export async function logoutAccount() {
  writeSessionId(null)
  if (CLOUD) {
    try {
      await authSignOut()
    } catch {
      /* уже вышли или нет сети */
    }
  }
}
