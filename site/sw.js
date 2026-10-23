// Офлайн-кэш приложения. Отдельный файл, без сборщика.
// Меняешь app.js/app.css — подними VERSION, иначе планшет останется на старом кэше.
const VERSION = 'notmozgi-v1'
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './app.css',
  './config.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  // запросы к Supabase и прочим чужим доменам кэшем не трогаем
  if (url.origin !== self.location.origin) return

  // навигация: сначала сеть (свежий index.html), офлайн — из кэша
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(VERSION).then((cache) => cache.put('./index.html', copy))
          return res
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    )
    return
  }

  // статика: из кэша, при промахе — сеть и запоминаем
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
              const copy = res.clone()
              caches.open(VERSION).then((cache) => cache.put(req, copy))
            }
            return res
          })
          .catch(() => hit)
    )
  )
})
