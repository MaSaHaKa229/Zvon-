/// <reference types="vite/client" />
import type { ZvonApi } from '../../preload/api'

declare global {
  const __ZVON_EDITION__: 'lan' | 'online'
  const __ZVON_DEFAULT_SERVER__: string
  interface Window {
    zvon: ZvonApi
  }
}

export {}
