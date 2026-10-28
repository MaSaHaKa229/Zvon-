import { useTranslation } from 'react-i18next'
import type { HostStatus } from '../../../preload/api'
import { DEFAULT_PORT } from '../../../shared/constants'
import { addressKindLabel } from '../../../shared/net'
import { prettyFingerprint } from '../lib/format'
import { CopyButton } from './Common'

/** Адреса хоста для друзей и отпечаток сертификата. */
export function HostShare({ status }: { status: HostStatus }) {
  const { t } = useTranslation()
  const port = status.port ?? DEFAULT_PORT
  const withPort = (ip: string): string => (port === DEFAULT_PORT ? ip : `${ip}:${port}`)

  return (
    <div className="host-share">
      <div className="field-label">{t('host.shareTitle')}</div>
      <p className="hint">{t('host.shareHint')}</p>
      {status.addresses.length === 0 ? (
        <p className="warning">{t('host.noAddresses')}</p>
      ) : (
        <ul className="address-list">
          {status.addresses.map((a) => (
            <li key={`${a.iface}-${a.address}`} className={a.kind === 'lan' || a.kind === 'other' ? '' : 'address-vpn'}>
              <div>
                <div className="address-ip">{withPort(a.address)}</div>
                <div className="address-kind">
                  {addressKindLabel(a.kind)} · {a.iface}
                </div>
              </div>
              <CopyButton text={withPort(a.address)} />
            </li>
          ))}
        </ul>
      )}
      {status.fingerprint && (
        <>
          <div className="field-label">{t('host.fingerprint')}</div>
          <code className="fingerprint">{prettyFingerprint(status.fingerprint)}</code>
          <p className="hint">{t('host.fingerprintHint')}</p>
        </>
      )}
    </div>
  )
}
