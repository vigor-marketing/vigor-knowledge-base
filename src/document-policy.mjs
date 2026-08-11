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

export const createDocumentMetadata = z.object({
  documentType: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(255),
  language: z.string().trim().min(2).max(16).default('zh-CN'),
  departmentId: z.string().trim().min(1).max(64).optional(),
  productId: z.string().trim().regex(/^prd_[A-Za-z0-9_-]+$/).optional(),
  securityLevel: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
  aiAllowed: z.boolean().default(true),
})

export function validateUploadFile({ filename, mimetype, bytes }, maxUploadBytes) {
  const extension = extname(filename || '').toLowerCase()
  const extensions = allowedFiles.get(mimetype)
  if (!extensions || !extensions.includes(extension)) return { ok: false, code: 'UNSUPPORTED_FILE_TYPE' }
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return { ok: false, code: 'EMPTY_FILE' }
  if (bytes > maxUploadBytes) return { ok: false, code: 'FILE_TOO_LARGE' }
  return { ok: true }
}
