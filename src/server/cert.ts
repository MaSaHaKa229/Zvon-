/**
 * Самоподписанный TLS-сертификат хоста. Создаётся один раз и хранится в dataDir,
 * чтобы отпечаток не менялся между запусками (клиенты доверяют ему по принципу TOFU).
 */
import { X509Certificate, generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import forge from 'node-forge'
import type { Logger } from './logger'

export interface TlsMaterial {
  key: string
  cert: string
  /** SHA-256 отпечаток в формате «AB:CD:…» (как X509Certificate.fingerprint256). */
  fingerprint: string
}

function generate(commonName: string): { key: string; cert: string } {
  // Ключ генерирует нативный crypto Node (быстро), node-forge только собирает сертификат.
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  const keys = {
    publicKey: forge.pki.publicKeyFromPem(pair.publicKey),
    privateKey: forge.pki.privateKeyFromPem(pair.privateKey)
  }
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15))
  const now = new Date()
  cert.validity.notBefore = new Date(now.getTime() - 24 * 3600 * 1000)
  cert.validity.notAfter = new Date(now.getTime() + 20 * 365 * 24 * 3600 * 1000)
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'Zvon self-hosted' }
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { key: pair.privateKey, cert: forge.pki.certificateToPem(cert) }
}

export function loadOrCreateTls(dataDir: string, log: Logger): TlsMaterial {
  const keyPath = join(dataDir, 'tls-key.pem')
  const certPath = join(dataDir, 'tls-cert.pem')
  let key: string
  let cert: string
  if (existsSync(keyPath) && existsSync(certPath)) {
    key = readFileSync(keyPath, 'utf8')
    cert = readFileSync(certPath, 'utf8')
    try {
      const x = new X509Certificate(cert)
      if (new Date(x.validTo).getTime() > Date.now()) {
        return { key, cert, fingerprint: x.fingerprint256 }
      }
      log.warn('Сертификат хоста истёк, создаю новый')
    } catch (err) {
      log.warn('Сертификат хоста повреждён, создаю новый', err)
    }
  }
  log.info('Генерирую самоподписанный сертификат…')
  const generated = generate('zvon-host')
  key = generated.key
  cert = generated.cert
  writeFileSync(keyPath, key, { mode: 0o600 })
  writeFileSync(certPath, cert)
  const fingerprint = new X509Certificate(cert).fingerprint256
  log.info(`Сертификат создан, отпечаток ${fingerprint}`)
  return { key, cert, fingerprint }
}
