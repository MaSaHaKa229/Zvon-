import { networkInterfaces } from 'node:os'
import { classifyAddress, sortAddresses, type NetAddress } from '../shared/net'

/** Все IPv4-адреса машины с типом сети; VPN-адаптеры идут первыми. */
export function listAddresses(includeLoopback = false): NetAddress[] {
  const result: NetAddress[] = []
  const ifaces = networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      // В Node 18+ family — строка 'IPv4'; в старых сборках встречалось число 4.
      const family = info.family as string | number
      if (family !== 'IPv4' && family !== 4) continue
      const kind = classifyAddress(name, info.address)
      if (kind === 'loopback' && !includeLoopback) continue
      // Link-local (169.254.x.x) бесполезны для подключения.
      if (info.address.startsWith('169.254.')) continue
      result.push({ iface: name, address: info.address, kind })
    }
  }
  return sortAddresses(result)
}
