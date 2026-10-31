/** Пароли аккаунтов: scrypt со случайной солью, формат «scrypt$соль$хеш» (base64). */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const KEY_LEN = 32

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, KEY_LEN, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split('$')
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, 'base64')
  const key = await derive(password, Buffer.from(saltB64, 'base64'))
  return key.length === expected.length && timingSafeEqual(key, expected)
}

/** Хеш, с которым сравнивается пароль несуществующего логина (чтобы время ответа не выдавало, есть ли логин). */
export const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
