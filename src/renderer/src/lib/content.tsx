/**
 * Отрисовка текста сообщения: ссылки, упоминания, переносы строк.
 * Никакого HTML из сообщения не вставляется — только текстовые узлы React.
 */
import type { ReactNode } from 'react'
import type { UserInfo } from '../../../shared/types'

const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/giu

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Token {
  kind: 'text' | 'link' | 'mention'
  text: string
  userId?: string
}

function tokenizeMentions(text: string, users: UserInfo[]): Token[] {
  if (!text.includes('@')) return [{ kind: 'text', text }]
  const names = users
    .map((u) => u.nickname)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
  const alternatives = ['everyone', 'все', ...names].join('|')
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(@(?:${alternatives}))(?![\\p{L}\\p{N}_])`, 'giu')
  const out: Token[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const start = (m.index ?? 0) + m[1].length
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) })
    const handle = m[2]
    const name = handle.slice(1).toLowerCase()
    const user = users.find((u) => u.nickname.toLowerCase() === name)
    out.push({ kind: 'mention', text: handle, userId: user?.id ?? 'everyone' })
    last = start + handle.length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

function tokenize(text: string, users: UserInfo[]): Token[] {
  const out: Token[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(...tokenizeMentions(text.slice(last, idx), users))
    out.push({ kind: 'link', text: m[0] })
    last = idx + m[0].length
  }
  if (last < text.length) out.push(...tokenizeMentions(text.slice(last), users))
  return out
}

function withBreaks(text: string, keyBase: string): ReactNode[] {
  const lines = text.split('\n')
  const nodes: ReactNode[] = []
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(<br key={`${keyBase}-br${i}`} />)
    if (line) nodes.push(line)
  })
  return nodes
}

export function renderContent(text: string, users: UserInfo[], myId: string | undefined): ReactNode[] {
  return tokenize(text, users).flatMap((tok, i): ReactNode[] => {
    if (tok.kind === 'link') {
      return [
        <a
          key={i}
          href={tok.text}
          onClick={(e) => {
            e.preventDefault()
            void window.zvon.openExternal(tok.text)
          }}
          title={tok.text}
        >
          {tok.text}
        </a>
      ]
    }
    if (tok.kind === 'mention') {
      const me = tok.userId === myId || tok.userId === 'everyone'
      return [
        <span key={i} className={me ? 'mention mention-me' : 'mention'}>
          {tok.text}
        </span>
      ]
    }
    return withBreaks(tok.text, String(i))
  })
}
