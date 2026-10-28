import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LIMITS } from '../../../shared/constants'
import type { Message, UserInfo } from '../../../shared/types'
import { renderContent } from '../lib/content'
import { isEmojiOnly } from '../lib/emoji'
import { formatFull, formatTime } from '../lib/format'
import { setApp } from '../store/app'
import { deleteMessage, editMessage, isMentioned } from '../store/session'
import { Attachments } from './Attachments'
import { Avatar } from './Common'
import { EditIcon, TrashIcon } from './Icons'

interface Props {
  message: Message
  grouped: boolean
  author: UserInfo | undefined
  users: UserInfo[]
  myId: string | undefined
  canDelete: boolean
  editing: boolean
}

export const MessageItem = memo(function MessageItem({ message, grouped, author, users, myId, canDelete, editing }: Props) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const mine = message.authorId === myId
  const name = author?.nickname ?? message.authorName
  const mentioned = isMentioned(message, myId)
  const big = isEmojiOnly(message.content)

  const onDelete = async (skipConfirm: boolean): Promise<void> => {
    if (!skipConfirm && !window.confirm(t('chat.deleteConfirm'))) return
    const err = await deleteMessage(message.id, message.channelId)
    if (err) setError(err)
  }

  const cls = ['message', grouped ? 'grouped' : '', mentioned ? 'mentioned' : '', editing ? 'editing' : ''].join(' ')

  return (
    <div className={cls} data-id={message.id}>
      <div className="message-gutter">
        {grouped ? (
          <span className="message-time-hover" title={formatFull(message.createdAt)}>
            {formatTime(message.createdAt)}
          </span>
        ) : (
          <Avatar id={message.authorId} nickname={name} size={40} />
        )}
      </div>
      <div className="message-main">
        {!grouped && (
          <div className="message-head">
            <span className="message-author">{name}</span>
            {author?.isAdmin && <span className="tag">{t('members.admin')}</span>}
            <span className="message-time" title={formatFull(message.createdAt)}>
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}
        {editing ? (
          <EditBox message={message} onError={setError} />
        ) : (
          message.content.trim() !== '' && (
            <div className={big ? 'message-body emoji-big' : 'message-body'}>
              {renderContent(message.content, users, myId)}
              {message.editedAt && (
                <span className="edited" title={formatFull(message.editedAt)}>
                  {' '}
                  {t('chat.edited')}
                </span>
              )}
            </div>
          )
        )}
        <Attachments files={message.attachments} />
        {error && <div className="message-error">{error}</div>}
      </div>
      {!editing && (mine || canDelete) && (
        <div className="message-actions">
          {mine && (
            <button className="icon-btn" title={t('chat.edit')} onClick={() => setApp({ editingId: message.id })}>
              <EditIcon width={16} height={16} />
            </button>
          )}
          <button className="icon-btn danger" title={t('common.delete')} onClick={(e) => void onDelete(e.shiftKey)}>
            <TrashIcon width={16} height={16} />
          </button>
        </div>
      )}
    </div>
  )
})

function EditBox({ message, onError }: { message: Message; onError: (e: string | null) => void }) {
  const { t } = useTranslation()
  const [value, setValue] = useState(message.content)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`
  }, [value])

  const save = async (): Promise<void> => {
    const v = value.trim()
    if (v === message.content.trim()) {
      setApp({ editingId: null })
      return
    }
    if (!v && message.attachments.length > 0) {
      // Текст убрать нельзя, если остаются файлы, — просто выходим из редактирования.
      setApp({ editingId: null })
      return
    }
    if (!v) {
      // Пустое сообщение при редактировании = удаление (как в Discord).
      const err = await deleteMessage(message.id, message.channelId)
      if (err) onError(err)
      setApp({ editingId: null })
      return
    }
    setBusy(true)
    const err = await editMessage(message.id, v)
    setBusy(false)
    onError(err)
  }

  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        value={value}
        maxLength={LIMITS.messageLength}
        disabled={busy}
        rows={1}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            setApp({ editingId: null })
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void save()
          }
        }}
      />
      <div className="hint">{t('chat.editHint')}</div>
    </div>
  )
}
