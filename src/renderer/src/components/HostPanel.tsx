import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LIMITS } from '../../../shared/constants'
import type { AdminSettings, AdminStats, Channel, ChannelType } from '../../../shared/types'
import { formatSize } from '../lib/files'
import { useApp } from '../store/app'
import { adminRequest } from '../store/session'
import { Avatar, Modal } from './Common'
import { FirewallCard } from './Firewall'
import { HashIcon, TrashIcon, VolumeIcon } from './Icons'

type Tab = 'users' | 'channels' | 'load' | 'settings'

const POLL_MS = 2_000
const HISTORY = 60

function mbps(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Мбит/с` : `${kbps} кбит/с`
}

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${m} мин` : `${m} мин`
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Панель хоста: участники, каналы, нагрузка SFU, лимиты. Доступна только администратору. */
export function HostPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('users')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [history, setHistory] = useState<Array<{ send: number; recv: number }>>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const poll = (): void => {
      adminRequest('admin-stats', {})
        .then((s) => {
          if (!alive) return
          setStats(s)
          setError(null)
          setHistory((h) => [...h, { send: s.sfu.sendKbps, recv: s.sfu.recvKbps }].slice(-HISTORY))
        })
        .catch((err) => alive && setError(errText(err)))
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return (
    <Modal title={t('admin.title')} onClose={onClose} wide>
      <div className="tabs">
        {(['users', 'channels', 'load', 'settings'] as const).map((x) => (
          <button key={x} className={tab === x ? 'tab active' : 'tab'} onClick={() => setTab(x)}>
            {t(`admin.tab_${x}`)}
          </button>
        ))}
      </div>
      {error && <div className="error-box">{error}</div>}
      {tab === 'users' && <UsersTab stats={stats} />}
      {tab === 'channels' && <ChannelsTab />}
      {tab === 'load' && <LoadTab stats={stats} history={history} />}
      {tab === 'settings' && <SettingsTab stats={stats} />}
    </Modal>
  )
}

function UsersTab({ stats }: { stats: AdminStats | null }) {
  const { t } = useTranslation()
  const channels = useApp((s) => s.channels)
  const myId = useApp((s) => s.me?.id)
  const [error, setError] = useState<string | null>(null)
  if (!stats) return <p className="hint">{t('common.loading')}</p>

  const act = (userId: string, nickname: string, ban: boolean): void => {
    const question = ban ? t('admin.banConfirm', { name: nickname }) : t('admin.kickConfirm', { name: nickname })
    if (!window.confirm(question)) return
    adminRequest('admin-kick', { userId, ban }).catch((err) => setError(errText(err)))
  }

  return (
    <div className="admin-section">
      {error && <div className="error-box">{error}</div>}
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t('admin.user')}</th>
            <th>IP</th>
            <th>{t('admin.voice')}</th>
            <th title={t('admin.downHint')}>↓</th>
            <th title={t('admin.upHint')}>↑</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {stats.users.map((u) => (
            <tr key={u.userId}>
              <td>
                <span className="admin-user">
                  <Avatar id={u.userId} nickname={u.nickname} size={24} />
                  {u.nickname}
                  {u.isAdmin && <span className="tag">{t('members.admin')}</span>}
                </span>
              </td>
              <td className="mono">{u.ip}</td>
              <td>{u.voiceChannelId ? (channels.find((c) => c.id === u.voiceChannelId)?.name ?? '—') : '—'}</td>
              <td className="mono">{u.voiceChannelId ? mbps(u.sendKbps) : '—'}</td>
              <td className="mono">{u.voiceChannelId ? mbps(u.recvKbps) : '—'}</td>
              <td className="admin-actions">
                {u.userId !== myId && (
                  <>
                    <button className="btn btn-small btn-secondary" onClick={() => act(u.userId, u.nickname, false)}>
                      {t('admin.kick')}
                    </button>
                    <button className="btn btn-small btn-danger" onClick={() => act(u.userId, u.nickname, true)}>
                      {t('admin.ban')}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {stats.banned.length > 0 && (
        <>
          <div className="field-label admin-subtitle">{t('admin.banned')}</div>
          {stats.banned.map((b) => (
            <div key={b.userId} className="admin-row">
              <span>{b.nickname}</span>
              <button
                className="btn btn-small btn-secondary"
                onClick={() => adminRequest('admin-unban', { userId: b.userId }).catch((err) => setError(errText(err)))}
              >
                {t('admin.unban')}
              </button>
            </div>
          ))}
          <p className="hint">{t('admin.bannedHint')}</p>
        </>
      )}
    </div>
  )
}

function ChannelRow({ channel, first, last, onError }: { channel: Channel; first: boolean; last: boolean; onError: (e: string) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(channel.name)
  useEffect(() => setName(channel.name), [channel.name])
  const save = (): void => {
    const v = name.trim()
    if (!v || v === channel.name) {
      setName(channel.name)
      return
    }
    adminRequest('channel-rename', { channelId: channel.id, name: v }).catch((err) => {
      setName(channel.name)
      onError(errText(err))
    })
  }
  return (
    <div className="admin-row channel-edit">
      {channel.type === 'text' ? <HashIcon width={16} height={16} /> : <VolumeIcon width={16} height={16} />}
      <input
        value={name}
        maxLength={LIMITS.channelNameLength}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setName(channel.name)
        }}
      />
      <button
        className="icon-btn"
        disabled={first}
        title={t('admin.up')}
        onClick={() => adminRequest('channel-move', { channelId: channel.id, direction: 'up' }).catch((err) => onError(errText(err)))}
      >
        ↑
      </button>
      <button
        className="icon-btn"
        disabled={last}
        title={t('admin.down')}
        onClick={() => adminRequest('channel-move', { channelId: channel.id, direction: 'down' }).catch((err) => onError(errText(err)))}
      >
        ↓
      </button>
      <button
        className="icon-btn danger"
        title={t('common.delete')}
        onClick={() => {
          if (!window.confirm(t('admin.deleteChannelConfirm', { name: channel.name }))) return
          adminRequest('channel-delete', { channelId: channel.id }).catch((err) => onError(errText(err)))
        }}
      >
        <TrashIcon width={16} height={16} />
      </button>
    </div>
  )
}

function ChannelsTab() {
  const { t } = useTranslation()
  const channels = useApp((s) => s.channels)
  const [name, setName] = useState('')
  const [type, setType] = useState<ChannelType>('text')
  const [error, setError] = useState<string | null>(null)
  const groups: Array<[ChannelType, Channel[]]> = [
    ['text', channels.filter((c) => c.type === 'text')],
    ['voice', channels.filter((c) => c.type === 'voice')]
  ]
  return (
    <div className="admin-section">
      {error && <div className="error-box">{error}</div>}
      {groups.map(([kind, list]) => (
        <div key={kind}>
          <div className="field-label admin-subtitle">{kind === 'text' ? t('chat.textChannels') : t('chat.voiceChannels')}</div>
          {list.map((c, i) => (
            <ChannelRow key={c.id} channel={c} first={i === 0} last={i === list.length - 1} onError={setError} />
          ))}
        </div>
      ))}
      <form
        className="admin-create"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          adminRequest('channel-create', { name: name.trim(), type })
            .then(() => {
              setName('')
              setError(null)
            })
            .catch((err) => setError(errText(err)))
        }}
      >
        <input value={name} maxLength={LIMITS.channelNameLength} placeholder={t('admin.newChannel')} onChange={(e) => setName(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value === 'voice' ? 'voice' : 'text')}>
          <option value="text">{t('admin.typeText')}</option>
          <option value="voice">{t('admin.typeVoice')}</option>
        </select>
        <button className="btn btn-small btn-primary" type="submit" disabled={!name.trim()}>
          {t('admin.create')}
        </button>
      </form>
    </div>
  )
}

/** Маленький график исходящего/входящего трафика за последние 2 минуты. */
function TrafficChart({ history }: { history: Array<{ send: number; recv: number }> }) {
  const w = 600
  const h = 120
  const max = Math.max(1000, ...history.map((p) => Math.max(p.send, p.recv)))
  const line = (key: 'send' | 'recv'): string =>
    history.map((p, i) => `${(i / Math.max(1, HISTORY - 1)) * w},${h - (p[key] / max) * (h - 8) - 4}`).join(' ')
  return (
    <svg className="traffic-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="traffic">
      <line x1="0" y1={h - 4} x2={w} y2={h - 4} className="axis" />
      <polyline points={line('recv')} className="recv" />
      <polyline points={line('send')} className="send" />
      <text x="6" y="14" className="label">
        {mbps(max)}
      </text>
    </svg>
  )
}

function LoadTab({ stats, history }: { stats: AdminStats | null; history: Array<{ send: number; recv: number }> }) {
  const { t } = useTranslation()
  if (!stats) return <p className="hint">{t('common.loading')}</p>
  const s = stats.sfu
  const cards: Array<[string, string, string?]> = [
    [t('admin.cpu'), `${s.cpuPercent.toFixed(1)}%`, s.cpuPercent > 80 ? 'warn' : undefined],
    [t('admin.out'), mbps(s.sendKbps)],
    [t('admin.in'), mbps(s.recvKbps)],
    [t('admin.streams'), `${s.producers} / ${s.consumers}`],
    [t('admin.rooms'), String(s.rooms)],
    [t('admin.online'), String(stats.users.length)],
    [t('admin.memory'), `${stats.memoryMb} МБ`],
    [t('admin.files'), formatSize(stats.files.totalBytes)],
    [t('admin.uptime'), uptime(stats.uptimeSec)]
  ]
  return (
    <div className="admin-section">
      {!s.available && <div className="error-box">{t('admin.sfuDown', { reason: s.error ?? '' })}</div>}
      <div className="stat-grid">
        {cards.map(([label, value, cls]) => (
          <div key={label} className={cls ? `stat ${cls}` : 'stat'}>
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>
      <div className="field-label admin-subtitle">
        {t('admin.traffic')} <span className="legend send">● {t('admin.out')}</span> <span className="legend recv">● {t('admin.in')}</span>
      </div>
      <TrafficChart history={history} />
      <p className="hint">
        {t('admin.mediaPort', { port: s.rtcPort })} · {s.listenIps.join(', ')}
      </p>
      <p className="hint">{t('admin.streamsHint')}</p>
    </div>
  )
}

function SettingsTab({ stats }: { stats: AdminStats | null }) {
  const { t } = useTranslation()
  const hostStatus = useApp((s) => s.hostStatus)
  const isOwn = useApp((s) => s.isOwnServer)
  const [form, setForm] = useState<{ maxIncomingKbps: string; maxOutgoingKbps: string; maxUploadMb: string } | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const loaded = useRef(false)

  useEffect(() => {
    if (!stats || loaded.current) return
    loaded.current = true
    setForm({
      maxIncomingKbps: String(stats.settings.maxIncomingKbps),
      maxOutgoingKbps: String(stats.settings.maxOutgoingKbps),
      maxUploadMb: String(stats.settings.maxUploadMb)
    })
  }, [stats])

  if (!form) return <p className="hint">{t('common.loading')}</p>
  const field = (key: keyof typeof form, label: string, hint: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input inputMode="numeric" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value.replace(/\D/g, '').slice(0, 7) })} />
      <span className="hint">{hint}</span>
    </label>
  )
  return (
    <div className="admin-section">
      {field('maxIncomingKbps', t('admin.maxIn'), t('admin.maxInHint'))}
      {field('maxOutgoingKbps', t('admin.maxOut'), t('admin.maxOutHint'))}
      {field('maxUploadMb', t('admin.maxUpload'), t('admin.maxUploadHint'))}
      {msg && <div className={msg.ok ? 'ok-box' : 'error-box'}>{msg.text}</div>}
      <button
        className="btn btn-primary"
        onClick={() => {
          const patch: Partial<AdminSettings> = {
            maxIncomingKbps: Number(form.maxIncomingKbps),
            maxOutgoingKbps: Number(form.maxOutgoingKbps),
            maxUploadMb: Number(form.maxUploadMb)
          }
          adminRequest('admin-settings', patch)
            .then(() => setMsg({ ok: true, text: t('admin.saved') }))
            .catch((err) => setMsg({ ok: false, text: errText(err) }))
        }}
      >
        {t('common.save')}
      </button>
      {isOwn && hostStatus.port && hostStatus.rtcPort && <FirewallCard port={hostStatus.port} rtcPort={hostStatus.rtcPort} />}
    </div>
  )
}
