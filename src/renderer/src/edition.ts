/** Вариант сборки — задаётся при сборке, см. electron.vite.config.ts и vite.web.config.ts. */
export const ONLINE_EDITION = __ZVON_EDITION__ === 'online'

/** Сервер по умолчанию для поля адреса (пусто — не задан). */
export const DEFAULT_SERVER = __ZVON_DEFAULT_SERVER__

/** Веб-версия: открыта в браузере с самого сервера. */
export const IS_WEB = __ZVON_WEB__

/** Адрес сервера, с которого открыта веб-версия. */
export function webTarget(): { host: string; port: number } {
  return { host: location.hostname, port: Number(location.port) || 443 }
}

/** Демонстрация экрана доступна (в мобильных браузерах её нет). */
export const CAN_SHARE_SCREEN = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
