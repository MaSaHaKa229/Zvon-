/**
 * Синхронизация значка в трее с состоянием приложения и обработка команд из его меню.
 */
import type { TrayState } from '../../../preload/api'
import { getApp, useApp, type AppState } from './app'
import { leaveVoice, toggleDeafen, toggleMute } from './voice'

let started = false

function compute(s: AppState): TrayState {
  let unread = 0
  let mentions = 0
  for (const u of Object.values(s.unread)) {
    unread += u.count
    mentions += u.mentions
  }
  return {
    inVoice: s.voiceChannelId !== null,
    voiceChannel: s.channels.find((c) => c.id === s.voiceChannelId)?.name ?? null,
    muted: s.selfMuted,
    deafened: s.selfDeafened,
    unread,
    mentions
  }
}

export function initTraySync(): void {
  if (started) return
  started = true
  let last = ''
  const push = (s: AppState): void => {
    const state = compute(s)
    const key = JSON.stringify(state)
    if (key === last) return
    last = key
    window.zvon.setTrayState(state)
  }
  push(getApp())
  useApp.subscribe(push)
  window.zvon.onTrayAction((action) => {
    if (action === 'toggle-mute') toggleMute()
    else if (action === 'toggle-deafen') toggleDeafen()
    else if (action === 'leave-voice') void leaveVoice()
  })
}
