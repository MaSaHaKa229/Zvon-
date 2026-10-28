/**
 * Проверка сервера перед подключением: TLS-рукопожатие без проверки цепочки,
 * получение отпечатка сертификата и /health. Решение о доверии принимает пользователь (TOFU).
 */
import { request } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { PROTOCOL_VERSION } from '../shared/constants'
import type { ServerHealth } from '../preload/api'

const PROBE_TIMEOUT_MS = 6_000

export interface RawProbe {
  fingerprint: string
  /** Сертификат выдан публичным центром для этого имени (например, Let's Encrypt у сервера на VPS). */
  publiclyTrusted: boolean
  health: ServerHealth
}

function humanError(err: NodeJS.ErrnoException, host: string, port: number): string {
  switch (err.code) {
    case 'ECONNREFUSED':
      return `Хост ${host}:${port} отклонил подключение. Сервер не запущен или порт закрыт брандмауэром.`
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return `Хост ${host}:${port} не отвечает. Проверьте IP, что вы в одной VPN-сети и что порт открыт.`
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `Сеть до ${host} недоступна. Проверьте, что VPN (Hamachi/Radmin/ZeroTier) подключён.`
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Не удалось найти адрес «${host}».`
    case 'ECONNRESET':
    case 'EPROTO':
      return `Соединение с ${host}:${port} сброшено. Возможно, на этом порту работает не Zvon.`
    default:
      return `Ошибка подключения к ${host}:${port}: ${err.message}`
  }
}

export function probeServer(host: string, port: number): Promise<RawProbe> {
  return new Promise((resolve, reject) => {
    let fingerprint: string | null = null
    let publiclyTrusted = false
    let finished = false
    const done = (fn: () => void): void => {
      if (finished) return
      finished = true
      fn()
    }

    const req = request(
      {
        host,
        port,
        path: '/health',
        method: 'GET',
        // Сертификат самоподписанный: доверие проверяется по отпечатку, а не по цепочке.
        rejectUnauthorized: false,
        timeout: PROBE_TIMEOUT_MS,
        agent: false,
        headers: { Accept: 'application/json' }
      },
      (res) => {
        const sock = res.socket as TLSSocket
        fingerprint = sock.getPeerX509Certificate?.()?.fingerprint256 ?? sock.getPeerCertificate()?.fingerprint256 ?? null
        publiclyTrusted = sock.authorized === true
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
          if (body.length > 64 * 1024) req.destroy(new Error('Слишком большой ответ'))
        })
        res.on('end', () =>
          done(() => {
            if (!fingerprint) {
              reject(new Error('Сервер не предоставил TLS-сертификат'))
              return
            }
            let health: ServerHealth
            try {
              health = JSON.parse(body) as ServerHealth
            } catch {
              reject(new Error(`На ${host}:${port} отвечает не сервер Zvon`))
              return
            }
            if (res.statusCode !== 200 || health.app !== 'zvon') {
              reject(new Error(`На ${host}:${port} отвечает не сервер Zvon`))
              return
            }
            if (health.protocol !== PROTOCOL_VERSION) {
              reject(
                new Error(
                  `Версия сервера не совпадает (протокол ${health.protocol}, у вас ${PROTOCOL_VERSION}). Обновите приложение у себя или у хоста.`
                )
              )
              return
            }
            resolve({ fingerprint, publiclyTrusted, health })
          })
        )
      }
    )
    req.on('timeout', () => {
      const e = new Error('timeout') as NodeJS.ErrnoException
      e.code = 'ETIMEDOUT'
      req.destroy(e)
    })
    req.on('error', (err: NodeJS.ErrnoException) => done(() => reject(new Error(humanError(err, host, port)))))
    req.end()
  })
}
