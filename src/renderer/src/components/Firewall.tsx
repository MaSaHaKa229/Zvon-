import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FirewallStatus } from '../../../preload/api'

/** Проверка и добавление правил брандмауэра Windows для портов хоста. */
export function FirewallCard({ port, rtcPort }: { port: number; rtcPort: number }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<FirewallStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    window.zvon
      .firewallCheck(port, rtcPort)
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null))
    return () => {
      alive = false
    }
  }, [port, rtcPort])

  if (!status?.supported) return null
  const ok = status.missing.length === 0
  return (
    <div className={ok ? 'firewall ok' : 'firewall'}>
      <div className="field-label">{t('firewall.title')}</div>
      <div className="firewall-title">{ok ? t('firewall.ok') : t('firewall.missing', { list: status.missing.join(', ') })}</div>
      {!ok && <p className="hint">{t('firewall.hint')}</p>}
      {status.error && <div className="error-box">{status.error}</div>}
      {!ok && (
        <button
          className="btn btn-small btn-primary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            window.zvon
              .firewallAdd(port, rtcPort)
              .then(setStatus)
              .catch(() => undefined)
              .finally(() => setBusy(false))
          }}
        >
          {busy ? t('firewall.adding') : t('firewall.add')}
        </button>
      )}
    </div>
  )
}
