import { useEffect, useState } from 'react'
import { ChatView } from './components/ChatView'
import { ConnectScreen } from './components/ConnectScreen'
import { MemberList } from './components/MemberList'
import { Sidebar } from './components/Sidebar'
import { VoiceStage } from './components/VoiceStage'
import { Lightbox } from './components/Attachments'
import { useApp } from './store/app'
import { bootApp, cleanError } from './store/session'

export function App() {
  const booted = useApp((s) => s.boot !== null)
  const screen = useApp((s) => s.screen)
  const showStage = useApp((s) => s.mainView === 'voice' && s.voiceChannelId !== null)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    bootApp().catch((err) => setBootError(cleanError(err)))
    // Файл, брошенный мимо чата, не должен открываться вместо приложения.
    const stop = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  if (bootError) return <div className="splash error">Не удалось запустить Zvon: {bootError}</div>
  if (!booted) return <div className="splash">Zvon</div>

  if (screen === 'connect') return <ConnectScreen />
  return (
    <div className="layout">
      <Sidebar />
      {showStage ? <VoiceStage /> : <ChatView />}
      <MemberList />
      <Lightbox />
    </div>
  )
}
