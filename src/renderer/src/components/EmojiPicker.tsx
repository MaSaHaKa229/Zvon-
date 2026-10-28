import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EMOJI_GROUPS } from '../lib/emoji'

export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string, keepOpen: boolean) => void; onClose: () => void }) {
  const { i18n } = useTranslation()
  const [group, setGroup] = useState(EMOJI_GROUPS[0].id)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // Откладываем подписку, чтобы клик по кнопке открытия не закрыл пикер сразу.
    const timer = setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const current = EMOJI_GROUPS.find((g) => g.id === group) ?? EMOJI_GROUPS[0]

  return (
    <div className="emoji-picker" ref={ref}>
      <div className="emoji-tabs">
        {EMOJI_GROUPS.map((g) => (
          <button
            key={g.id}
            className={g.id === group ? 'emoji-tab active' : 'emoji-tab'}
            title={i18n.language === 'en' ? g.en : g.ru}
            onClick={() => setGroup(g.id)}
          >
            {g.icon}
          </button>
        ))}
      </div>
      <div className="emoji-title">{i18n.language === 'en' ? current.en : current.ru}</div>
      <div className="emoji-grid">
        {current.items.map((e) => (
          <button key={e} className="emoji-cell" onClick={(ev) => onPick(e, ev.shiftKey)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  )
}
