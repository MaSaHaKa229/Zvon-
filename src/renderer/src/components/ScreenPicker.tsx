import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ScreenSource } from '../../../preload/api'
import { useApp } from '../store/app'
import { closeScreenPicker, startScreenShare, updateVoiceSettings } from '../store/voice'
import { SCREEN_PRESETS, type ScreenQuality } from '../voice/settings'
import { Modal } from './Common'

export function ScreenPicker() {
  const { t } = useTranslation()
  const boot = useApp((s) => s.boot)
  const settings = useApp((s) => s.voiceSettings)
  const [sources, setSources] = useState<ScreenSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const [tab, setTab] = useState<'screen' | 'window'>('screen')
  const [selected, setSelected] = useState<string | null>(null)
  const [monitors, setMonitors] = useState<MediaDeviceInfo[]>([])
  const [monitorId, setMonitorId] = useState('')
  const systemAudio = boot?.systemAudio ?? 'none'
  const isWayland = boot?.platform === 'linux' && sources?.length === 1 && sources[0].thumbnail === null

  const load = useCallback(async () => {
    setError(null)
    setSources(null)
    try {
      const access = await window.zvon.screenAccess()
      setDenied(access === 'denied')
      const list = await window.zvon.screenSources()
      setSources(list)
      setSelected((cur) => (cur && list.some((s) => s.id === cur) ? cur : (list.find((s) => s.kind === 'screen')?.id ?? list[0]?.id ?? null)))
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setSources([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Linux: звук системы берётся с «Monitor»-устройства PulseAudio/PipeWire.
  useEffect(() => {
    if (systemAudio !== 'monitor') return
    navigator.mediaDevices
      .enumerateDevices()
      .then((list) => setMonitors(list.filter((d) => d.kind === 'audioinput' && /monitor/i.test(d.label))))
      .catch(() => setMonitors([]))
  }, [systemAudio])

  const visible = (sources ?? []).filter((s) => s.kind === tab)

  const start = (): void => {
    if (!selected) return
    void startScreenShare({
      sourceId: selected,
      quality: settings.screenQuality,
      content: settings.screenContent,
      loopbackAudio: systemAudio === 'loopback' && settings.screenAudio,
      monitorDeviceId: systemAudio === 'monitor' && monitorId ? monitorId : null
    })
  }

  return (
    <Modal
      title={t('picker.title')}
      onClose={closeScreenPicker}
      wide
      footer={
        <>
          <button className="btn btn-secondary" onClick={() => void load()}>
            {t('picker.refresh')}
          </button>
          <span className="spacer" />
          <button className="btn btn-secondary" onClick={closeScreenPicker}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!selected} onClick={start}>
            {t('picker.start')}
          </button>
        </>
      }
    >
      {denied && (
        <div className="error-box">
          {t('picker.macAccess')}{' '}
          <button className="btn btn-small btn-secondary" onClick={() => void window.zvon.openScreenSettings()}>
            {t('picker.openSettings')}
          </button>
        </div>
      )}
      {error && <div className="error-box">{error}</div>}

      <div className="tabs">
        <button className={tab === 'screen' ? 'tab active' : 'tab'} onClick={() => setTab('screen')}>
          {t('picker.screens')}
        </button>
        <button className={tab === 'window' ? 'tab active' : 'tab'} onClick={() => setTab('window')}>
          {t('picker.windows')}
        </button>
      </div>

      {isWayland && <p className="hint">{t('picker.wayland')}</p>}

      <div className="source-grid">
        {sources === null ? (
          <p className="hint">{t('picker.loading')}</p>
        ) : visible.length === 0 ? (
          <p className="hint">{t('picker.empty')}</p>
        ) : (
          visible.map((s) => (
            <button
              key={s.id}
              className={s.id === selected ? 'source selected' : 'source'}
              onClick={() => setSelected(s.id)}
              onDoubleClick={() => {
                setSelected(s.id)
                start()
              }}
            >
              {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <div className="source-noprev">{t('picker.noPreview')}</div>}
              <span className="source-name">
                {s.icon && <img className="source-icon" src={s.icon} alt="" />}
                {s.name}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="picker-options">
        <label className="field">
          <span className="field-label">{t('picker.quality')}</span>
          <select value={settings.screenQuality} onChange={(e) => updateVoiceSettings({ screenQuality: e.target.value as ScreenQuality })}>
            {(Object.keys(SCREEN_PRESETS) as ScreenQuality[]).map((q) => (
              <option key={q} value={q}>
                {q.replace(/p(\d+)$/, 'p · $1 fps')}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('picker.content')}</span>
          <select
            value={settings.screenContent}
            onChange={(e) => updateVoiceSettings({ screenContent: e.target.value === 'motion' ? 'motion' : 'detail' })}
          >
            <option value="detail">{t('picker.contentDetail')}</option>
            <option value="motion">{t('picker.contentMotion')}</option>
          </select>
        </label>
      </div>

      {systemAudio === 'loopback' && (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={settings.screenAudio} onChange={(e) => updateVoiceSettings({ screenAudio: e.target.checked })} />
            {t('picker.audio')}
          </label>
          {settings.screenAudio && <p className="hint warning">{t('picker.audioEchoHint')}</p>}
        </>
      )}
      {systemAudio === 'monitor' && (
        <label className="field">
          <span className="field-label">{t('picker.audioMonitor')}</span>
          <select value={monitorId} onChange={(e) => setMonitorId(e.target.value)}>
            <option value="">{t('picker.audioNone')}</option>
            {monitors.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label}
              </option>
            ))}
          </select>
          {monitors.length === 0 && <span className="hint">{t('picker.audioMonitorMissing')}</span>}
          {monitorId && <span className="hint warning">{t('picker.audioEchoHint')}</span>}
        </label>
      )}
      {systemAudio === 'none' && <p className="hint">{t('picker.audioUnsupported')}</p>}
    </Modal>
  )
}
