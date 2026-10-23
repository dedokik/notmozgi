// Сборка для хостинга: dist/ собирается из уже готовой папки site/.
//
// Почему так, а не `vite build`:
//   site/ — это ровно то, что проверено в браузере (та же сборка, что лежит
//   в репозитории). Копирование не зависит от нативных бинарников, версии
//   Node и настроек Tailwind на стороне CI, поэтому деплой не может
//   неожиданно упасть или отдать пустую страницу.
//
// Нужен классический Vite-пайплайн? `npm run build:vite`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'site')
// BUILD_OUT позволяет собрать в другую папку (локальная проверка)
const out = process.env.BUILD_OUT ? path.resolve(root, process.env.BUILD_OUT) : path.join(root, 'dist')

const required = ['index.html', 'app.js', 'app.css', 'config.js', 'manifest.webmanifest', 'sw.js']
const missing = required.filter((f) => !fs.existsSync(path.join(src, f)))
if (missing.length) {
  console.error(`[build] в site/ не хватает файлов: ${missing.join(', ')}`)
  console.error('[build] пересобери статику (см. README, раздел «если поменял исходники»)')
  process.exit(1)
}

// чистим прошлую сборку, но не падаем, если ФС не даёт удалить —
// тогда просто перезапишем файлы поверх
try {
  fs.rmSync(out, { recursive: true, force: true })
} catch {
  /* ignore */
}

// обычное копирование файл-за-файлом: работает и на сетевых/смонтированных
// путях, где fs.cpSync отваливается с EIO
let count = 0
let bytes = 0
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name)
    const b = path.join(to, entry.name)
    if (entry.isDirectory()) {
      copyDir(a, b)
    } else {
      fs.copyFileSync(a, b)
      count++
      bytes += fs.statSync(b).size
    }
  }
}

copyDir(src, out)
console.log(`[build] dist/ готов: ${count} файлов, ${(bytes / 1024).toFixed(0)} КБ`)
