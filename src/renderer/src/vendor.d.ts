/** Пакет без собственных типов TypeScript; его index.js использует нестандартный синтаксис, поэтому импортируем сборку напрямую. */
declare module '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js' {
  export default function createRNNWasmModuleSync(): unknown
}
