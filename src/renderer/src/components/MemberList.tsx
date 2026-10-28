import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserInfo } from '../../../shared/types'
import { useApp } from '../store/app'
import { Avatar } from './Common'

export function MemberList() {
  const { t } = useTranslation()
  const users = useApp((s) => s.users)
  const myId = useApp((s) => s.me?.id)

  const { online, offline } = useMemo(() => {
    const all = Object.values(users).sort((a, b) => a.nickname.localeCompare(b.nickname))
    return { online: all.filter((u) => u.online), offline: all.filter((u) => !u.online) }
  }, [users])

  const row = (u: UserInfo) => (
    <div key={u.id} className={u.online ? 'member' : 'member offline'}>
      <Avatar id={u.id} nickname={u.nickname} size={32} online={u.online} />
      <span className="member-name">{u.nickname}</span>
      {u.isAdmin && <span className="tag">{t('members.admin')}</span>}
      {u.id === myId && <span className="member-you">{t('members.you')}</span>}
    </div>
  )

  return (
    <aside className="members">
      <div className="members-group">{t('members.online', { count: online.length })}</div>
      {online.map(row)}
      {offline.length > 0 && <div className="members-group">{t('members.offline', { count: offline.length })}</div>}
      {offline.map(row)}
    </aside>
  )
}
