import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { fileUrl } from '../lib/files'
import { avatarColor, initials } from '../lib/format'
import { useApp } from '../store/app'
import { CloseIcon, CopyIcon } from './Icons'

export function Avatar({
  id,
  nickname,
  size = 40,
  online
}: {
  id: string
  nickname: string
  size?: number
  online?: boolean
}) {
  const avatarId = useApp((s) => s.users[id]?.avatar ?? null)
  // Токен в ссылке меняется при переподключении — подписываемся, чтобы перерисовать картинку.
  useApp((s) => s.fileToken)
  const [failed, setFailed] = useState<string | null>(null)
  const src = avatarId && failed !== avatarId ? fileUrl(avatarId) : null
  return (
    <div className="avatar" style={{ width: size, height: size, background: src ? 'transparent' : avatarColor(id), fontSize: size * 0.4 }}>
      {src ? <img src={src} alt="" draggable={false} onError={() => setFailed(avatarId)} /> : initials(nickname)}
      {online !== undefined && <span className={online ? 'presence presence-on' : 'presence'} />}
    </div>
  )
}

export function Modal({
  title,
  children,
  onClose,
  footer,
  danger,
  wide
}: {
  title: string
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
  danger?: boolean
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={['modal', danger ? 'modal-danger' : '', wide ? 'modal-wide' : ''].join(' ')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation()
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(timer)
  }, [done])
  return (
    <button
      className="btn btn-small btn-secondary"
      onClick={() => {
        void window.zvon.copyText(text).then(() => setDone(true))
      }}
    >
      <CopyIcon width={14} height={14} />
      {done ? t('common.copied') : (label ?? t('common.copy'))}
    </button>
  )
}
