// Настройки готовой сборки. Меняются руками, пересборка не нужна.
//
// Пусто = приложение работает только локально (IndexedDB, офлайн).
// Чтобы включить синхронизацию, впиши ключи из Supabase Dashboard →
// Project Settings → API и не забудь выполнить supabase/schema.sql.
window.__NOT_CONFIG__ = {
  supabaseUrl: '',
  supabaseAnonKey: '',
}
