import { extname } from 'node:path'
import { z } from 'zod'

export const documentStatuses = ['draft', 'review', 'approved', 'active', 'obsolete', 'archived']
export const allowedFiles = new Map([
  ['application/pdf', ['.pdf']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['.docx']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['.xlsx']],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ['.pptx']],
  ['text/plain', ['.txt', '.md']],
])
export const mimeTypeByExtension = new Map([...allowedFiles.entries()].flatMap(([mimeType, extensions]) => extensions.map(extension => [extension, mimeType])))
export const allowedCommentAttachments = new Map([...allowedFiles, ['image/jpeg', ['.jpg', '.jpeg']], ['image/png', ['.png']], ['image/webp', ['.webp']]])

export const createDocumentMetadata = z.object({
  documentType: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(255),
  language: z.string().trim().min(2).max(16).default('zh-CN'),
  departmentId: z.string().trim().min(1).max(64).optional(),
  productId: z.string().trim().regex(/^prd_[A-Za-z0-9_-]+$/).optional(),
  securityLevel: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
  aiAllowed: z.boolean().default(true),
})

// 权限等级映射：普通员工只能看到公开/内部资料，管理者可看机密，专职管理员可看全部。
const fullClearanceRoles = ['admin_specialist']
const confidentialClearanceRoles = ['general_manager', 'admin_specialist']

export function allowedSecurityLevels(actor) {
  if (fullClearanceRoles.some(role => actor.roles.includes(role))) return ['public', 'internal', 'confidential', 'restricted']
  if (confidentialClearanceRoles.some(role => actor.roles.includes(role))) return ['public', 'internal', 'confidential']
  return ['public', 'internal']
}

export function validateUploadFile({ filename, mimetype, bytes }, maxUploadBytes) {
  const extension = extname(filename || '').toLowerCase()
  const expectedMimeType = mimeTypeByExtension.get(extension)
  const suppliedMimeType = String(mimetype || '').toLowerCase()
  const browserGenericMimeType = !suppliedMimeType || suppliedMimeType === 'application/octet-stream' || suppliedMimeType === 'binary/octet-stream'
  if (!expectedMimeType || (!browserGenericMimeType && suppliedMimeType !== expectedMimeType)) return { ok: false, code: 'UNSUPPORTED_FILE_TYPE' }
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return { ok: false, code: 'EMPTY_FILE' }
  if (bytes > maxUploadBytes) return { ok: false, code: 'FILE_TOO_LARGE' }
  return { ok: true, mimeType: expectedMimeType }
}
export function validateCommentAttachment({ filename, mimetype, bytes }, maxUploadBytes) {
  const extension = extname(filename || '').toLowerCase(); const extensions = allowedCommentAttachments.get(mimetype)
  if (!extensions || !extensions.includes(extension)) return { ok: false, code: 'UNSUPPORTED_ATTACHMENT_TYPE' }
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return { ok: false, code: 'EMPTY_ATTACHMENT' }
  if (bytes > Math.min(maxUploadBytes, 10 * 1024 * 1024)) return { ok: false, code: 'ATTACHMENT_TOO_LARGE' }
  return { ok: true }
}
