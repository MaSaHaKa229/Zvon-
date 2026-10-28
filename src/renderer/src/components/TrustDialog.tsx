import { useTranslation } from 'react-i18next'
import { prettyFingerprint } from '../lib/format'
import { useApp } from '../store/app'
import { acceptTrust, rejectTrust } from '../store/session'
import { Modal } from './Common'
import { ShieldIcon } from './Icons'

export function TrustDialog() {
  const { t } = useTranslation()
  const prompt = useApp((s) => s.trustPrompt)
  if (!prompt) return null
  const changed = prompt.probe.trust === 'changed'
  const name = prompt.probe.health.name

  return (
    <Modal
      title={changed ? t('trust.titleChanged') : t('trust.titleNew')}
      onClose={rejectTrust}
      danger={changed}
      footer={
        <>
          <button className="btn btn-secondary" onClick={rejectTrust}>
            {t('common.cancel')}
          </button>
          <button className={changed ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => void acceptTrust()} autoFocus={!changed}>
            {changed ? t('trust.acceptChanged') : t('trust.accept')}
          </button>
        </>
      }
    >
      <div className="trust">
        <ShieldIcon width={36} height={36} className={changed ? 'trust-icon danger' : 'trust-icon'} />
        <p>{changed ? t('trust.textChanged', { name }) : t('trust.textNew', { name })}</p>
      </div>
      <div className="trust-server">
        {prompt.target.host}:{prompt.target.port} · v{prompt.probe.health.version}
      </div>
      <code className="fingerprint">{prettyFingerprint(prompt.probe.fingerprint)}</code>
    </Modal>
  )
}
