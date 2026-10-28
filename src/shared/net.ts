/** Сетевые утилиты, общие для main и сервера (без зависимостей от Node). */

export type AddressKind = 'hamachi' | 'radmin' | 'zerotier' | 'tailscale' | 'lan' | 'loopback' | 'other'

export interface NetAddress {
  iface: string
  address: string
  kind: AddressKind
}

const KIND_LABELS: Record<AddressKind, string> = {
  hamachi: 'Hamachi',
  radmin: 'Radmin VPN',
  zerotier: 'ZeroTier',
  tailscale: 'Tailscale',
  lan: 'Локальная сеть',
  loopback: 'Этот компьютер',
  other: 'Другая сеть'
}

export function addressKindLabel(kind: AddressKind): string {
  return KIND_LABELS[kind]
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const a = ipv4ToInt(ip)
  const b = ipv4ToInt(base)
  if (a === null || b === null) return false
  const size = 2 ** (32 - bits)
  return Math.floor(a / size) === Math.floor(b / size)
}

export function isValidIpv4(ip: string): boolean {
  return ipv4ToInt(ip) !== null
}

/** Определяет тип сети по имени адаптера и диапазону адреса. */
export function classifyAddress(iface: string, address: string): AddressKind {
  const name = iface.toLowerCase()
  if (inCidr(address, '127.0.0.0', 8)) return 'loopback'
  if (name.includes('hamachi') || inCidr(address, '25.0.0.0', 8)) return 'hamachi'
  if (name.includes('radmin') || inCidr(address, '26.0.0.0', 8)) return 'radmin'
  if (name.startsWith('zt') || name.includes('zerotier')) return 'zerotier'
  if (name.includes('tailscale') || inCidr(address, '100.64.0.0', 10)) return 'tailscale'
  if (inCidr(address, '10.0.0.0', 8) || inCidr(address, '172.16.0.0', 12) || inCidr(address, '192.168.0.0', 16)) {
    return 'lan'
  }
  return 'other'
}

const KIND_ORDER: AddressKind[] = ['radmin', 'hamachi', 'zerotier', 'tailscale', 'lan', 'other', 'loopback']

export function sortAddresses(list: NetAddress[]): NetAddress[] {
  return [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
}

/** Разбирает строку вида «26.1.2.3», «26.1.2.3:7777» или «host.local:7777». */
export function parseHostInput(input: string, defaultPort: number): { host: string; port: number } | null {
  const s = input.trim()
  if (!s) return null
  const m = /^\[?([^\]\s]+?)\]?(?::(\d{1,5}))?$/.exec(s)
  if (!m) return null
  const host = m[1]
  const port = m[2] ? Number(m[2]) : defaultPort
  if (!host || port < 1 || port > 65535) return null
  return { host, port }
}
