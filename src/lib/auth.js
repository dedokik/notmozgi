// Локальные аккаунты.
//
// Пароль никуда не уходит: аккаунт живёт в этом браузере, а пароль хранится
// только как хэш с солью (PBKDF2 через WebCrypto, 120 000 итераций).
// У каждого аккаунта своя база заметок, поэтому чужой аккаунт видит пустое
// приложение, а не чужие записи.
import Dexie from 'dexie'
import { dbNameFor } from './db.js'

const authDb = new Dexie('not-auth')
authDb.version(1).stores({ accounts: 'id, email' })

const SESSION_KEY = 'not-session'

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

export async function listAccounts() {
  const all = await authDb.accounts.toArray()
  return all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

export async function hasAccounts() {
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
  const id = readSessionId()
  if (!id) return null
  const acc = await authDb.accounts.get(id)
  return acc || null
}

export async function createAccount(email, pass) {
  const mail = normEmail(email)
  if (!mail.includes('@') || mail.length < 5) throw new Error('Нужна почта вида name@mail.ru')
  if ((pass || '').length < 4) throw new Error('Пароль слишком короткий — минимум 4 символа')

  const same = await authDb.accounts.where('email').equals(mail).first()
  if (same) throw new Error('Аккаунт с такой почтой уже есть на этом устройстве')

  // первый аккаунт забирает уже существующие заметки (они лежат в базовой базе),
  // все следующие получают собственную пустую
  const isFirst = (await authDb.accounts.count()) === 0
  const id = makeId()
  const salt = makeId()
  const acc = {
    id,
    email: mail,
    hash: await hashPassword(pass, salt),
    salt,
    dbName: dbNameFor(id, isFirst),
    createdAt: Date.now(),
  }
  await authDb.accounts.add(acc)
  writeSessionId(id)
  return acc
}

export async function loginAccount(email, pass) {
  const mail = normEmail(email)
  const acc = await authDb.accounts.where('email').equals(mail).first()
  if (!acc) throw new Error('Такого аккаунта на этом устройстве нет')
  const hash = await hashPassword(pass, acc.salt)
  if (hash !== acc.hash) throw new Error('Неверный пароль')
  writeSessionId(acc.id)
  return acc
}

export function logoutAccount() {
  writeSessionId(null)
}
