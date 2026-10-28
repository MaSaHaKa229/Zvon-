/**
 * Черновые вложения в поле ввода: файл загружается на хост сразу после добавления,
 * а к сообщению прикрепляется при отправке.
 */
import i18n from '../i18n'
import { LIMITS } from '../../../shared/constants'
import type { FileInfo } from '../../../shared/types'
import { deleteUploaded, formatSize, kindOf, mimeOf, prepareMeta, uploadBlob } from '../lib/files'
import { getApp, setApp, type DraftAttachment } from './app'

const files = new Map<string, File>()
const requests = new Map<string, XMLHttpRequest>()
let seq = 0

function patch(channelId: string, localId: string, p: Partial<DraftAttachment>): void {
  setApp((s) => ({
    drafts: { ...s.drafts, [channelId]: (s.drafts[channelId] ?? []).map((d) => (d.localId === localId ? { ...d, ...p } : d)) }
  }))
}

function draftsOf(channelId: string): DraftAttachment[] {
  return getApp().drafts[channelId] ?? []
}

/** Добавляет файлы (из выбора, перетаскивания или буфера обмена) и сразу начинает загрузку. */
export function addFiles(channelId: string, list: File[]): string | null {
  const existing = draftsOf(channelId).length
  const room = LIMITS.attachmentsPerMessage - existing
  let warning: string | null = null
  if (list.length > room) {
    warning = i18n.t('files.tooMany', { max: LIMITS.attachmentsPerMessage })
    list = list.slice(0, Math.max(0, room))
  }
  const max = getApp().maxUploadBytes
  const added: DraftAttachment[] = []
  for (const file of list) {
    const mime = mimeOf(file)
    const kind = kindOf(mime)
    const localId = `d${Date.now().toString(36)}${seq++}`
    const tooBig = max > 0 && file.size > max
    const draft: DraftAttachment = {
      localId,
      name: file.name || (kind === 'image' ? 'image.png' : 'file'),
      size: file.size,
      mime,
      kind,
      previewUrl: kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : null,
      progress: 0,
      status: tooBig ? 'error' : 'preparing',
      error: tooBig ? i18n.t('files.tooBig', { max: formatSize(max) }) : null,
      file: null
    }
    files.set(localId, file)
    added.push(draft)
  }
  setApp((s) => ({ drafts: { ...s.drafts, [channelId]: [...(s.drafts[channelId] ?? []), ...added] } }))
  for (const d of added) if (d.status !== 'error') void upload(channelId, d.localId)
  return warning
}

async function upload(channelId: string, localId: string): Promise<void> {
  const file = files.get(localId)
  const draft = draftsOf(channelId).find((d) => d.localId === localId)
  if (!file || !draft) return
  patch(channelId, localId, { status: 'preparing', error: null, progress: 0 })
  try {
    const meta = await prepareMeta(file, draft.mime)
    if (!draftsOf(channelId).some((d) => d.localId === localId)) return
    patch(channelId, localId, { status: 'uploading' })
    const info = await uploadBlob(
      file,
      { name: draft.name, type: draft.mime, width: meta.width, height: meta.height, duration: meta.duration },
      (progress) => patch(channelId, localId, { progress: meta.thumb ? progress * 0.97 : progress }),
      (xhr) => requests.set(localId, xhr)
    )
    let result: FileInfo = info
    if (meta.thumb) {
      try {
        const thumb = await uploadBlob(meta.thumb, { name: 'thumb.webp', type: 'image/webp', thumbOf: info.id }, () => undefined, (xhr) =>
          requests.set(localId, xhr)
        )
        result = { ...info, thumbId: thumb.id }
      } catch (err) {
        console.warn('[files] миниатюра не загрузилась — покажем оригинал', err)
      }
    }
    requests.delete(localId)
    // Пользователь мог убрать файл, пока он грузился.
    if (!draftsOf(channelId).some((d) => d.localId === localId)) {
      deleteUploaded(result.id)
      return
    }
    patch(channelId, localId, { status: 'done', progress: 1, file: result })
  } catch (err) {
    requests.delete(localId)
    if (!draftsOf(channelId).some((d) => d.localId === localId)) return
    patch(channelId, localId, { status: 'error', error: (err as Error).message })
  }
}

export function retryDraft(channelId: string, localId: string): void {
  void upload(channelId, localId)
}

export function removeDraft(channelId: string, localId: string): void {
  const d = draftsOf(channelId).find((x) => x.localId === localId)
  if (!d) return
  requests.get(localId)?.abort()
  requests.delete(localId)
  files.delete(localId)
  if (d.previewUrl) URL.revokeObjectURL(d.previewUrl)
  if (d.file) deleteUploaded(d.file.id)
  setApp((s) => ({ drafts: { ...s.drafts, [channelId]: (s.drafts[channelId] ?? []).filter((x) => x.localId !== localId) } }))
}

export function draftsBusy(channelId: string): boolean {
  return draftsOf(channelId).some((d) => d.status === 'preparing' || d.status === 'uploading')
}

/** Забирает готовые вложения для отправки и очищает черновик (ошибочные остаются). */
export function takeReadyAttachments(channelId: string): FileInfo[] {
  const ready = draftsOf(channelId).filter((d) => d.status === 'done' && d.file)
  for (const d of ready) {
    files.delete(d.localId)
    // Превью держим ещё немного: картинка с хоста успеет загрузиться.
    if (d.previewUrl) {
      const url = d.previewUrl
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    }
  }
  setApp((s) => ({ drafts: { ...s.drafts, [channelId]: (s.drafts[channelId] ?? []).filter((x) => !(x.status === 'done' && x.file)) } }))
  return ready.map((d) => d.file!)
}

/** При отключении от сервера черновики теряют смысл (токен другого сервера). */
export function clearAllDrafts(): void {
  for (const xhr of requests.values()) xhr.abort()
  requests.clear()
  files.clear()
  for (const list of Object.values(getApp().drafts)) for (const d of list) if (d.previewUrl) URL.revokeObjectURL(d.previewUrl)
  setApp({ drafts: {} })
}
