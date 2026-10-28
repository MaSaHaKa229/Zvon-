/** Вариант сборки — задаётся при сборке, см. electron.vite.config.ts. */
export const ONLINE_EDITION = __ZVON_EDITION__ === 'online'

/** Сервер по умолчанию для поля адреса (пусто — не задан). */
export const DEFAULT_SERVER = __ZVON_DEFAULT_SERVER__
