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

/** Сервисы, которые возвращают внешний IPv4 запрашивающего простым текстом. */
const PUBLIC_IP_SERVICES = ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://ifconfig.me/ip']

/** Внешний IPv4 машины (для сервера за NAT). null — ни один сервис не ответил. */
export async function detectPublicIp(timeoutMs = 5000): Promise<string | null> {
  for (const url of PUBLIC_IP_SERVICES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      const text = (await res.text()).trim()
      if (res.ok && /^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text
    } catch {
      // следующий сервис
    }
  }
  return null
}
