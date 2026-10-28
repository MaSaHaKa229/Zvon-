import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HostStatus, TrayAction, ZvonApi } from './api'

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T): void => listener(value)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: ZvonApi = {
  getInitialState: () => ipcRenderer.invoke('app:initial-state'),
  setNickname: (nickname) => ipcRenderer.invoke('app:set-nickname', nickname),
  probeServer: (host, port) => ipcRenderer.invoke('server:probe', host, port),
  trustServer: (host, port, fingerprint) => ipcRenderer.invoke('server:trust', host, port, fingerprint),
  rememberServer: (host, port, name, password, adminToken) =>
    ipcRenderer.invoke('server:remember', host, port, name, password, adminToken),
  forgetServer: (host, port) => ipcRenderer.invoke('server:forget', host, port),
  startHost: (settings) => ipcRenderer.invoke('host:start', settings),
  stopHost: () => ipcRenderer.invoke('host:stop'),
  onHostStatus: (listener) => subscribe<HostStatus>('host:status', listener),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
  ensureMediaAccess: (kind) => ipcRenderer.invoke('media:ensure-access', kind),
  pttSupport: () => ipcRenderer.invoke('ptt:support'),
  pttConfigure: (enabled, binding) => ipcRenderer.invoke('ptt:configure', enabled, binding),
  pttRecord: () => ipcRenderer.invoke('ptt:record'),
  onPttChange: (listener) => subscribe<boolean>('ptt:pressed', listener),
  screenSources: () => ipcRenderer.invoke('screen:sources'),
  screenSelect: (sourceId, audio) => ipcRenderer.invoke('screen:select', sourceId, audio),
  screenAccess: () => ipcRenderer.invoke('screen:access'),
  openScreenSettings: () => ipcRenderer.invoke('screen:open-settings'),
  downloadFile: (url) => ipcRenderer.invoke('file:download', url),
  setAppSettings: (patch) => ipcRenderer.invoke('app:set-settings', patch),
  setTrayState: (state) => ipcRenderer.send('tray:state', state),
  onTrayAction: (listener) => subscribe<TrayAction>('tray:action', listener),
  focusWindow: () => ipcRenderer.send('app:focus'),
  requestAttention: () => ipcRenderer.send('app:attention'),
  firewallCheck: (port, rtcPort) => ipcRenderer.invoke('firewall:check', port, rtcPort),
  firewallAdd: (port, rtcPort) => ipcRenderer.invoke('firewall:add', port, rtcPort)
}

contextBridge.exposeInMainWorld('zvon', api)
