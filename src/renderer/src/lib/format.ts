import i18n from '../i18n'

function locale(): string {
  return i18n.language === 'en' ? 'en-GB' : 'ru-RU'
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
}

export function formatFull(ts: number): string {
  return new Date(ts).toLocaleString(locale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function formatDay(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (dayKey(ts) === dayKey(today.getTime())) return i18n.t('chat.today')
  if (dayKey(ts) === dayKey(yesterday.getTime())) return i18n.t('chat.yesterday')
  return d.toLocaleDateString(locale(), {
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  })
}

/** Стабильный цвет аватарки по id пользователя. */
const AVATAR_COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22', '#3498db', '#747f8d']

export function avatarColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export function initials(nickname: string): string {
  const parts = nickname.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = Array.from(parts[0])[0] ?? '?'
  const second = parts.length > 1 ? (Array.from(parts[1])[0] ?? '') : ''
  return (first + second).toUpperCase()
}

/** «AB:CD:EF:…» → группы по 4 байта для удобной сверки вслух. */
export function prettyFingerprint(fp: string): string {
  const bytes = fp.split(':')
  const groups: string[] = []
  for (let i = 0; i < bytes.length; i += 4) groups.push(bytes.slice(i, i + 4).join(''))
  return groups.join(' ')
}
