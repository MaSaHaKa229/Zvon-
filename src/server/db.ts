import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Channel, ChannelType, FileInfo, FileKind, Message } from '../shared/types'
import type { Logger } from './logger'

/** Миграции применяются по порядку; номер версии хранится в PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE channels (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('text', 'voice')),
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE users (
    id         TEXT PRIMARY KEY,
    nickname   TEXT NOT NULL,
    avatar     TEXT,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id   TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content     TEXT NOT NULL,
    mentions    TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL,
    edited_at   INTEGER
  );
  CREATE INDEX idx_messages_channel ON messages (channel_id, id);
  `,
  `
  CREATE TABLE files (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    width       INTEGER,
    height      INTEGER,
    duration    REAL,
    thumb_id    TEXT,
    is_thumb    INTEGER NOT NULL DEFAULT 0,
    uploader_id TEXT NOT NULL,
    message_id  INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_files_message ON files (message_id);
  CREATE INDEX idx_files_orphans ON files (message_id, created_at);
  ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `
]

interface MessageRow {
  id: number
  channel_id: string
  author_id: string
  author_name: string
  content: string
  mentions: string
  created_at: number
  edited_at: number | null
  attachments: string
}

interface FileRow {
  id: string
  name: string
  mime: string
  size: number
  kind: FileKind
  width: number | null
  height: number | null
  duration: number | null
  thumb_id: string | null
  is_thumb: number
  uploader_id: string
  message_id: number | null
  created_at: number
}

/** Запись о файле со служебными полями (для проверок прав и удаления). */
export interface StoredFile extends FileInfo {
  isThumb: boolean
  uploaderId: string
  messageId: number | null
  createdAt: number
}

export type NewFile = Omit<StoredFile, 'messageId' | 'thumbId' | 'createdAt'>

function rowToFile(r: FileRow): StoredFile {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    kind: r.kind,
    width: r.width,
    height: r.height,
    duration: r.duration,
    thumbId: r.thumb_id,
    isThumb: r.is_thumb === 1,
    uploaderId: r.uploader_id,
    messageId: r.message_id,
    createdAt: r.created_at
  }
}

export function publicFile(f: StoredFile): FileInfo {
  return {
    id: f.id,
    name: f.name,
    mime: f.mime,
    size: f.size,
    kind: f.kind,
    width: f.width,
    height: f.height,
    duration: f.duration,
    thumbId: f.thumbId
  }
}

function parseIds(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

interface ChannelRow {
  id: string
  name: string
  type: ChannelType
  position: number
}

export interface StoredUser {
  id: string
  nickname: string
  avatar: string | null
  lastSeen: number
}

function rowToMessage(r: MessageRow, files: Map<string, StoredFile>): Message {
  let mentions: string[] = []
  try {
    const parsed: unknown = JSON.parse(r.mentions)
    if (Array.isArray(parsed)) mentions = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    /* повреждённое поле — считаем, что упоминаний нет */
  }
  return {
    id: r.id,
    channelId: r.channel_id,
    authorId: r.author_id,
    authorName: r.author_name,
    content: r.content,
    mentions,
    attachments: parseIds(r.attachments)
      .map((id) => files.get(id))
      .filter((f): f is StoredFile => Boolean(f))
      .map(publicFile),
    createdAt: r.created_at,
    editedAt: r.edited_at
  }
}

export class ZvonDb {
  private db: Database.Database

  constructor(file: string, private log: Logger) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('synchronous = NORMAL')
    this.migrate()
    this.seedDefaults()
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.log.info(`Применяю миграцию БД №${v + 1}`)
      const run = this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v])
        this.db.pragma(`user_version = ${v + 1}`)
      })
      run()
    }
  }

  private seedDefaults(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM channels').get() as { n: number }).n
    if (count > 0) return
    const defaults: Array<[string, ChannelType]> = [
      ['общий', 'text'],
      ['мемы', 'text'],
      ['Общий голосовой', 'voice'],
      ['Игры', 'voice']
    ]
    const insert = this.db.prepare('INSERT INTO channels (id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)')
    const now = Date.now()
    this.db.transaction(() => {
      defaults.forEach(([name, type], i) => insert.run(randomUUID(), name, type, i, now))
    })()
    this.log.info('Созданы каналы по умолчанию')
  }

  close(): void {
    try {
      this.db.close()
    } catch (err) {
      this.log.warn('Ошибка при закрытии БД', err)
    }
  }

  /* ---------- каналы ---------- */

  listChannels(): Channel[] {
    const rows = this.db.prepare('SELECT id, name, type, position FROM channels ORDER BY type, position, created_at').all() as ChannelRow[]
    return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, position: r.position }))
  }

  getChannel(id: string): Channel | null {
    const r = this.db.prepare('SELECT id, name, type, position FROM channels WHERE id = ?').get(id) as ChannelRow | undefined
    return r ? { id: r.id, name: r.name, type: r.type, position: r.position } : null
  }

  private nextPosition(type: ChannelType): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE type = ?').get(type) as { p: number }
    return r.p + 1
  }

  createChannel(name: string, type: ChannelType): Channel {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO channels (id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, type, this.nextPosition(type), Date.now())
    return this.getChannel(id)!
  }

  renameChannel(id: string, name: string): Channel | null {
    this.db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, id)
    return this.getChannel(id)
  }

  /** Удаляет канал вместе с сообщениями и возвращает их файлы (для удаления с диска). */
  deleteChannel(id: string): StoredFile[] {
    const run = this.db.transaction(() => {
      const files = (
        this.db.prepare('SELECT f.* FROM files f JOIN messages m ON f.message_id = m.id WHERE m.channel_id = ?').all(id) as FileRow[]
      ).map(rowToFile)
      if (files.length) {
        const ph = files.map(() => '?').join(',')
        this.db.prepare(`DELETE FROM files WHERE id IN (${ph})`).run(...files.map((f) => f.id))
      }
      this.db.prepare('DELETE FROM messages WHERE channel_id = ?').run(id)
      this.db.prepare('DELETE FROM channels WHERE id = ?').run(id)
      return files
    })
    return run()
  }

  /** Меняет канал местами с соседним того же типа. */
  moveChannel(id: string, direction: 'up' | 'down'): void {
    const ch = this.getChannel(id)
    if (!ch) return
    const list = this.listChannels().filter((c) => c.type === ch.type)
    const i = list.findIndex((c) => c.id === id)
    const j = direction === 'up' ? i - 1 : i + 1
    if (i < 0 || j < 0 || j >= list.length) return
    // Нормализуем позиции и меняем две местами.
    const ordered = [...list]
    ;[ordered[i], ordered[j]] = [ordered[j], ordered[i]]
    const upd = this.db.prepare('UPDATE channels SET position = ? WHERE id = ?')
    this.db.transaction(() => ordered.forEach((c, pos) => upd.run(pos, c.id)))()
  }

  /* ---------- настройки сервера ---------- */

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return r?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  /* ---------- пользователи ---------- */

  upsertUser(id: string, nickname: string): StoredUser {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO users (id, nickname, avatar, created_at, last_seen) VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname, last_seen = excluded.last_seen`
      )
      .run(id, nickname, now, now)
    return this.getUser(id)!
  }

  touchUser(id: string): void {
    this.db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), id)
  }

  getUser(id: string): StoredUser | null {
    const r = this.db.prepare('SELECT id, nickname, avatar, last_seen FROM users WHERE id = ?').get(id) as
      | { id: string; nickname: string; avatar: string | null; last_seen: number }
      | undefined
    return r ? { id: r.id, nickname: r.nickname, avatar: r.avatar, lastSeen: r.last_seen } : null
  }

  /** Недавние пользователи (для списка участников «не в сети»). */
  listUsers(limit = 200): StoredUser[] {
    const rows = this.db
      .prepare('SELECT id, nickname, avatar, last_seen FROM users ORDER BY last_seen DESC LIMIT ?')
      .all(limit) as Array<{ id: string; nickname: string; avatar: string | null; last_seen: number }>
    return rows.map((r) => ({ id: r.id, nickname: r.nickname, avatar: r.avatar, lastSeen: r.last_seen }))
  }

  /* ---------- сообщения ---------- */

  /** Подтягивает вложения для пачки сообщений одним запросом. */
  private toMessages(rows: MessageRow[]): Message[] {
    const ids = [...new Set(rows.flatMap((r) => parseIds(r.attachments)))]
    const files = new Map<string, StoredFile>()
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',')
      const fileRows = this.db.prepare(`SELECT * FROM files WHERE id IN (${placeholders})`).all(...ids) as FileRow[]
      for (const f of fileRows) files.set(f.id, rowToFile(f))
    }
    return rows.map((r) => rowToMessage(r, files))
  }

  /** Сохраняет сообщение и привязывает к нему вложения (только свои и ещё не привязанные). */
  insertMessage(m: Omit<Message, 'id' | 'editedAt' | 'nonce' | 'attachments'>, attachmentIds: string[]): Message {
    const run = this.db.transaction(() => {
      const info = this.db
        .prepare(
          'INSERT INTO messages (channel_id, author_id, author_name, content, mentions, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(m.channelId, m.authorId, m.authorName, m.content, JSON.stringify(m.mentions), m.createdAt, JSON.stringify(attachmentIds))
      const id = Number(info.lastInsertRowid)
      if (attachmentIds.length > 0) {
        const placeholders = attachmentIds.map(() => '?').join(',')
        const changed = this.db
          .prepare(
            `UPDATE files SET message_id = ? WHERE id IN (${placeholders}) AND uploader_id = ? AND message_id IS NULL AND is_thumb = 0 AND kind != 'avatar'`
          )
          .run(id, ...attachmentIds, m.authorId).changes
        if (changed !== attachmentIds.length) throw new Error('ATTACHMENTS_INVALID')
        // Миниатюры живут вместе с основным файлом.
        this.db
          .prepare(`UPDATE files SET message_id = ? WHERE id IN (SELECT thumb_id FROM files WHERE message_id = ? AND thumb_id IS NOT NULL)`)
          .run(id, id)
      }
      return id
    })
    const id = run()
    return this.getMessage(id)!
  }

  getMessage(id: number): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
    return r ? this.toMessages([r])[0] : null
  }

  updateMessage(id: number, content: string, mentions: string[]): Message | null {
    this.db
      .prepare('UPDATE messages SET content = ?, mentions = ?, edited_at = ? WHERE id = ?')
      .run(content, JSON.stringify(mentions), Date.now(), id)
    return this.getMessage(id)
  }

  /** Удаляет сообщение и возвращает его файлы (вместе с миниатюрами), чтобы стереть их с диска. */
  deleteMessage(id: number): StoredFile[] {
    const run = this.db.transaction(() => {
      const files = (this.db.prepare('SELECT * FROM files WHERE message_id = ?').all(id) as FileRow[]).map(rowToFile)
      this.db.prepare('DELETE FROM files WHERE message_id = ?').run(id)
      this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
      return files
    })
    return run()
  }

  /** Страница истории: сообщения с id < before, в хронологическом порядке. */
  history(channelId: string, before: number | undefined, limit: number): { messages: Message[]; hasMore: boolean } {
    const rows = (
      before
        ? this.db
            .prepare('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(channelId, before, limit + 1)
        : this.db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?').all(channelId, limit + 1)
    ) as MessageRow[]
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).reverse()
    return { messages: this.toMessages(page), hasMore }
  }

  /* ---------- файлы ---------- */

  insertFile(f: NewFile): StoredFile {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO files (id, name, mime, size, kind, width, height, duration, thumb_id, is_thumb, uploader_id, message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`
      )
      .run(f.id, f.name, f.mime, f.size, f.kind, f.width, f.height, f.duration, f.isThumb ? 1 : 0, f.uploaderId, now)
    return this.getFile(f.id)!
  }

  getFile(id: string): StoredFile | null {
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined
    return r ? rowToFile(r) : null
  }

  setThumb(fileId: string, thumbId: string): void {
    this.db.prepare('UPDATE files SET thumb_id = ? WHERE id = ?').run(thumbId, fileId)
  }

  /** Удаляет записи и возвращает их (вместе с миниатюрами). */
  deleteFiles(ids: string[]): StoredFile[] {
    if (ids.length === 0) return []
    const run = this.db.transaction(() => {
      const placeholders = ids.map(() => '?').join(',')
      const rows = (this.db.prepare(`SELECT * FROM files WHERE id IN (${placeholders})`).all(...ids) as FileRow[]).map(rowToFile)
      const thumbIds = rows.map((r) => r.thumbId).filter((x): x is string => Boolean(x))
      const all = [...new Set([...ids, ...thumbIds])]
      const ph2 = all.map(() => '?').join(',')
      const withThumbs = (this.db.prepare(`SELECT * FROM files WHERE id IN (${ph2})`).all(...all) as FileRow[]).map(rowToFile)
      this.db.prepare(`DELETE FROM files WHERE id IN (${ph2})`).run(...all)
      return withThumbs
    })
    return run()
  }

  /** Загруженные, но так и не отправленные файлы старше указанного времени. */
  orphanFiles(olderThan: number): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM files WHERE message_id IS NULL AND is_thumb = 0 AND kind != 'avatar' AND created_at < ?`)
      .all(olderThan) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** Миниатюры, чей основной файл исчез (например, загрузка была прервана). */
  danglingThumbs(olderThan: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.id FROM files t WHERE t.is_thumb = 1 AND t.message_id IS NULL AND t.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM files p WHERE p.thumb_id = t.id)`
      )
      .all(olderThan) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** Меняет аватарку и возвращает id прежней (чтобы удалить файл). */
  setUserAvatar(userId: string, fileId: string | null): string | null {
    const prev = this.getUser(userId)?.avatar ?? null
    this.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(fileId, userId)
    return prev
  }

  /** Сколько места занимают все файлы (для панели хоста). */
  totalFilesSize(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files').get() as { n: number }).n
  }
}
