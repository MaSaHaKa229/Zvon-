import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_PORT, DEFAULT_RTC_PORT, LIMITS } from '../../../shared/constants'
import { parseHostInput } from '../../../shared/net'
import { DEFAULT_SERVER, ONLINE_EDITION } from '../edition'
import { useApp } from '../store/app'
import {
  beginConnect,
  enterOwnServer,
  rememberHostSettings,
  setNicknameDraft,
  startHost,
  stopHost
} from '../store/session'
import { FirewallCard } from './Firewall'
import { HostShare } from './HostShare'
import { CloseIcon, ServerIcon } from './Icons'
import { TrustDialog } from './TrustDialog'

type Tab = 'join' | 'host'

export function ConnectScreen() {
  const { t } = useTranslation()
  const nickname = useApp((s) => s.nickname)
  const error = useApp((s) => s.connectError)
  const trustPrompt = useApp((s) => s.trustPrompt)
  const hostState = useApp((s) => s.hostStatus.state)
  const boot = useApp((s) => s.boot)
  const [tab, setTab] = useState<Tab>(hostState === 'running' ? 'host' : 'join')

  return (
    <div className="connect-screen">
      <div className="connect-card">
        <div className="brand">
          <div className="brand-logo">Z</div>
          <div>
            <h1>Zvon</h1>
            <p>{t(ONLINE_EDITION ? 'connect.taglineOnline' : 'connect.tagline')}</p>
          </div>
        </div>

        <label className="field">
          <span className="field-label">{t('connect.nickname')}</span>
          <input
            value={nickname}
            maxLength={LIMITS.nicknameLength}
            placeholder={t('connect.nicknamePlaceholder')}
            onChange={(e) => setNicknameDraft(e.target.value.replace(/@/g, ''))}
            autoFocus={!nickname}
          />
        </label>

        {ONLINE_EDITION ? (
          <JoinForm />
        ) : (
          <>
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'join'} className={tab === 'join' ? 'tab active' : 'tab'} onClick={() => setTab('join')}>
                {t('connect.tabJoin')}
              </button>
              <button role="tab" aria-selected={tab === 'host'} className={tab === 'host' ? 'tab active' : 'tab'} onClick={() => setTab('host')}>
                {t('connect.tabHost')}
                {hostState === 'running' && <span className="dot-live" />}
              </button>
            </div>

            {tab === 'join' ? <JoinForm /> : <HostForm />}
          </>
        )}

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {boot && (
          <div className="version-line">
            v{boot.version}
            {boot.profile ? ` · профиль «${boot.profile}»` : ''}
          </div>
        )}
      </div>

      {trustPrompt && <TrustDialog />}
    </div>
  )
}

function JoinForm() {
  const { t } = useTranslation()
  const connecting = useApp((s) => s.connecting)
  const recent = useApp((s) => s.recentServers)
  const [address, setAddress] = useState(() => {
    const r = recent[0]
    return r ? (r.port === DEFAULT_PORT ? r.host : `${r.host}:${r.port}`) : DEFAULT_SERVER
  })
  const [password, setPassword] = useState(() => recent[0]?.password ?? '')
  const [adminToken, setAdminToken] = useState(() => recent[0]?.adminToken ?? '')
  const [showAdmin, setShowAdmin] = useState(() => Boolean(recent[0]?.adminToken))
  const [remember, setRemember] = useState(true)
  const [localError, setLocalError] = useState<string | null>(null)

  const submit = (e?: FormEvent): void => {
    e?.preventDefault()
    const parsed = parseHostInput(address, DEFAULT_PORT)
    if (!parsed) {
      setLocalError(t(ONLINE_EDITION ? 'connect.errAddressOnline' : 'connect.errAddress'))
      return
    }
    setLocalError(null)
    void beginConnect({ host: parsed.host, port: parsed.port, password, adminToken: showAdmin ? adminToken.trim() : '', remember })
  }

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">{t(ONLINE_EDITION ? 'connect.addressOnline' : 'connect.address')}</span>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={t(ONLINE_EDITION ? 'connect.addressPlaceholderOnline' : 'connect.addressPlaceholder')}
          spellCheck={false}
        />
        <span className="hint">{t(ONLINE_EDITION ? 'connect.addressHintOnline' : 'connect.addressHint')}</span>
      </label>
      <label className="field">
        <span className="field-label">{t('connect.password')}</span>
        <input
          type="password"
          value={password}
          maxLength={LIMITS.passwordLength}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('connect.passwordPlaceholder')}
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        {t('connect.rememberPassword')}
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={showAdmin} onChange={(e) => setShowAdmin(e.target.checked)} />
        {t('connect.iAmAdmin')}
      </label>
      {showAdmin && (
        <label className="field">
          <span className="field-label">{t('connect.adminToken')}</span>
          <input
            type="password"
            value={adminToken}
            maxLength={128}
            onChange={(e) => setAdminToken(e.target.value)}
            placeholder={t('connect.adminTokenPlaceholder')}
            spellCheck={false}
          />
        </label>
      )}
      {localError && <div className="error-box">{localError}</div>}
      <button className="btn btn-primary btn-wide" type="submit" disabled={connecting}>
        {connecting ? t('connect.joining') : t('connect.join')}
      </button>

      <div className="recent">
        <div className="field-label">{t('connect.recent')}</div>
        {recent.length === 0 ? (
          <p className="hint">{t('connect.recentEmpty')}</p>
        ) : (
          <ul>
            {recent.map((r) => (
              <li key={`${r.host}:${r.port}`}>
                <button
                  type="button"
                  className="recent-item"
                  disabled={connecting}
                  onClick={() => {
                    setAddress(r.port === DEFAULT_PORT ? r.host : `${r.host}:${r.port}`)
                    setPassword(r.password ?? '')
                    setAdminToken(r.adminToken ?? '')
                    setShowAdmin(Boolean(r.adminToken))
                    void beginConnect({
                      host: r.host,
                      port: r.port,
                      password: r.password ?? '',
                      adminToken: r.adminToken ?? '',
                      remember: Boolean(r.password || r.adminToken)
                    })
                  }}
                >
                  <ServerIcon width={18} height={18} />
                  <span className="recent-name">{r.name}</span>
                  <span className="recent-addr">
                    {r.host}:{r.port}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={t('connect.forget')}
                  onClick={() => {
                    void window.zvon.forgetServer(r.host, r.port).then((recentServers) => useApp.setState({ recentServers }))
                  }}
                >
                  <CloseIcon width={16} height={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </form>
  )
}

function HostForm() {
  const { t } = useTranslation()
  const boot = useApp((s) => s.boot)
  const status = useApp((s) => s.hostStatus)
  const connecting = useApp((s) => s.connecting)
  const [serverName, setServerName] = useState(boot?.hostSettings.serverName ?? '')
  const [port, setPort] = useState(String(boot?.hostSettings.port ?? DEFAULT_PORT))
  const [password, setPassword] = useState(boot?.hostSettings.password ?? '')
  const [rtcPort, setRtcPort] = useState(String(boot?.hostSettings.rtcPort ?? DEFAULT_RTC_PORT))
  const [maxUploadMb, setMaxUploadMb] = useState(String(boot?.hostSettings.maxUploadMb ?? LIMITS.defaultMaxUploadMb))
  const busy = status.state === 'starting' || status.state === 'stopping'
  const running = status.state === 'running'

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const settings = { serverName, port: Number(port), password, rtcPort: Number(rtcPort), maxUploadMb: Number(maxUploadMb) }
    rememberHostSettings(settings)
    void startHost(settings)
  }

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">{t('host.serverName')}</span>
        <input value={serverName} maxLength={LIMITS.serverNameLength} disabled={running || busy} onChange={(e) => setServerName(e.target.value)} />
      </label>
      <div className="field-row">
        <label className="field field-port">
          <span className="field-label">{t('host.port')}</span>
          <input
            value={port}
            inputMode="numeric"
            disabled={running || busy}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
          />
        </label>
        <label className="field field-port">
          <span className="field-label">{t('host.rtcPort')}</span>
          <input
            value={rtcPort}
            inputMode="numeric"
            disabled={running || busy}
            onChange={(e) => setRtcPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
          />
        </label>
        <label className="field field-port">
          <span className="field-label">{t('host.maxUpload')}</span>
          <input
            value={maxUploadMb}
            inputMode="numeric"
            disabled={running || busy}
            onChange={(e) => setMaxUploadMb(e.target.value.replace(/\D/g, '').slice(0, 5))}
          />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">{t('host.password')}</span>
          <input
            type="password"
            value={password}
            maxLength={LIMITS.passwordLength}
            disabled={running || busy}
            placeholder={t('host.passwordPlaceholder')}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </div>
      <p className="hint">
        {t('host.portHint')} {t('host.firewallHint')}
      </p>

      {status.state === 'error' && status.error && <div className="error-box">{status.error}</div>}

      {running ? (
        <>
          <div className="host-running">
            <span className="dot-live" /> {t('host.running')} · {t('host.onlineCount', { count: status.online })}
          </div>
          {status.voiceError && <div className="warning">{t('host.voiceUnavailable', { reason: status.voiceError })}</div>}
          <div className="button-row">
            <button type="button" className="btn btn-primary" disabled={connecting} onClick={() => void enterOwnServer()}>
              {connecting ? t('connect.joining') : t('host.enter')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void stopHost()}>
              {t('host.stop')}
            </button>
          </div>
          {status.port && status.rtcPort && <FirewallCard port={status.port} rtcPort={status.rtcPort} />}
          <HostShare status={status} />
        </>
      ) : (
        <button className="btn btn-primary btn-wide" type="submit" disabled={busy}>
          {status.state === 'starting' ? t('host.starting') : status.state === 'stopping' ? t('host.stopping') : t('host.start')}
        </button>
      )}
    </form>
  )
}
