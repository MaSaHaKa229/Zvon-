/// <reference types="vite/client" />
import type { ZvonApi } from '../../preload/api'

declare global {
  interface Window {
    zvon: ZvonApi
  }
}

export {}
