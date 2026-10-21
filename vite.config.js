import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // Гарантируем, что новый SW вступает в силу сразу и забирает все вкладки.
      // Иначе старая версия продолжает обслуживать навигацию и подсовывает
      // устаревший index.html со ссылками на уже удалённые ассеты.
      workbox: {
        // Навигацию НЕ кешируем как precache: иначе старый index.html
        // (со ссылками на удалённые ассеты) снова окажется на устройстве.
        // Вместо этого — network-first с откатом на кеш (работает офлайн).
        navigateFallback: null,
        // HTML вообще не precache-им: он с хэшем в имени ссылается на ассеты,
        // которые при деплое заменяются. Старый index.html = белый экран.
        globPatterns: ['**/*.{js,css,ico,png,svg,webmanifest}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // HTML всегда из сети, при отсутствии сети — из кеша
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'not-pages',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            // Ассеты с хэшем в имени — неизменяемы, можно держать в кеше надолго
            urlPattern: ({ request }) => request.destination === 'script' || request.destination === 'style' || request.destination === 'font' || request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'not-assets',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'NotMozgi',
        short_name: 'NotMozgi',
        theme_color: '#0d0d10',
        background_color: '#0d0d10',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
        shortcuts: [
          {
            name: 'Новая заметка',
            short_name: 'Новая',
            description: 'Быстро создать заметку',
            url: '/?new=1',
            icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
})
