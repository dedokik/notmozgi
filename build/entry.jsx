// Точка входа для сборки без npm (site/app.js).
// Отдельно от src/main.jsx, потому что CSS здесь уже скомпилирован
// и подключается ссылкой в index.html, а не импортом.
import { createRoot } from 'react-dom/client'
import App from '../src/App.jsx'

const el = document.getElementById('root')
createRoot(el).render(<App />)
