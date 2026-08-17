import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { allowedSecurityLevels, createDocumentMetadata, validateUploadFile, validateCommentAttachment } from './document-policy.mjs'
import { loadConfig } from './config.mjs'
import { CosStorage } from './cos-storage.mjs'
import { DocumentRepository } from './document-repository.mjs'
import { canManageKnowledgeBase, createAuthenticator } from './auth.mjs'
import { IngestionQueue } from './ingestion-queue.mjs'
import { EmbeddingClient } from './embedding-client.mjs'
import { SearchIndex } from './search-index.mjs'
import { AnswerService } from './answer-service.mjs'

const config = loadConfig()
const ingestionConfigured = Boolean(config.mysqlUrl && config.cos && config.redisUrl && (config.oidc || config.testAdmin))
const storage = config.cos ? new CosStorage(config.cos) : undefined
const repository = config.mysqlUrl ? new DocumentRepository(config.mysqlUrl) : undefined
const authenticate = createAuthenticator(config.oidc || {})
const ingestionQueue = config.redisUrl ? new IngestionQueue(config.redisUrl) : undefined
const embeddings = config.search ? new EmbeddingClient({ url: config.search.embeddingUrl, apiKey: config.search.embeddingApiKey, model: config.search.embeddingModel, dimensions: config.search.embeddingDimensions, hunyuan: config.search.hunyuan }) : undefined
const searchIndex = config.search ? new SearchIndex({ node: config.search.node, apiKey: config.search.apiKey, indexName: config.search.indexName, dimensions: config.search.embeddingDimensions }) : undefined
const answers = config.deepseek ? new AnswerService(config.deepseek) : undefined
const maxUploadBytes = config.maxUploadBytes
const basePath = config.basePath
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url))
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes })
const actorFor = async request => {
  if (config.testAdmin) return { personId: 'usr_test_admin', displayName: '测试管理员', roles: ['admin_specialist'] }
  if (!authenticate) return undefined
  try { return await authenticate({ authorization: request.headers.authorization, cookie: request.headers.cookie }) } catch { return undefined }
}

const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
const actorName = actor => String(actor?.displayName || actor?.name || actor?.preferredUsername || actor?.personId || '资料库用户').slice(0, 128)

await app.register(multipart, { limits: { files: 1, fileSize: maxUploadBytes } })

app.get('/api/health', async () => ({
  status: 'ok',
  service: 'knowledge-base',
  version: '0.2.0',
  time: new Date().toISOString(),
  capabilities: { ingestion: ingestionConfigured },
}))

app.get(`${basePath}*`, async (request, reply) => {
  const relativePath = request.params['*'] || 'index.html'
  const candidate = normalize(join(publicRoot, relativePath))
  const filePath = candidate.startsWith(publicRoot) ? candidate : join(publicRoot, 'index.html')
  try {
    const contents = await readFile(filePath)
    const isStaticAsset = ['.css', '.js'].includes(extname(filePath))
    if (isStaticAsset) reply.header('cache-control', 'no-store, max-age=0')
    return reply.type(contentTypes[extname(filePath)] || 'application/octet-stream').send(contents)
  } catch {
    return reply.type('text/html; charset=utf-8').send(await readFile(join(publicRoot, 'index.html')))
  }
})

app.get('/api/v1/search', async (request, reply) => {
  const actor = await actorFor(request)
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  const query = typeof request.query?.q === 'string' ? request.query.q.trim() : ''
  if (!query || query.length > 500) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'q must contain 1 to 500 characters.' } })
  if (!repository) return reply.code(503).send({ error: { code: 'REPOSITORY_NOT_CONFIGURED' } })
  const securityLevels = allowedSecurityLevels(actor)
  const semantic = Boolean(embeddings && searchIndex)
  const rawResults = semantic ? (await searchIndex.hybridSearch({ query, vector: (await embeddings.embed([query]))[0], securityLevels })).map(result => ({ chunkId: result.chunkId, documentId: result.documentId, versionId: result.versionId, title: result.title, documentType: result.documentType, originalFilename: result.originalFilename, content: result.content, headingPath: result.headingPath, score: result.score })) : await repository.keywordSearch(query, 2, securityLevels)
  const results = [...new Map(rawResults.map(result => [result.documentId, result])).values()].slice(0, 2)
  let answer
  if (request.query?.answer !== '0' && answers && results.length) {
    const answerSources = semantic ? rawResults : await repository.keywordSearchSources(query, 5, securityLevels)
    if (answerSources.length) try { answer = await answers.answer(query, answerSources.slice(0, 5)) } catch (error) { request.log.warn({ error: error.message }, 'deepseek answer unavailable') }
  }
  return { data: { query, mode: semantic ? 'semantic' : 'keyword', results, answer } }
})

app.get('/api/v1/search/answer', async (request, reply) => {
  const actor = await actorFor(request)
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } })
  const query = typeof request.query?.q === 'string' ? request.query.q.trim() : ''
  if (!query || query.length > 500) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } })
  if (!repository || !answers) return { data: { answer: null } }
  const sources = await repository.keywordSearchSources(query, 5, allowedSecurityLevels(actor))
  if (!sources.length) return { data: { answer: null } }
  try { return { data: { answer: await answers.answer(query, sources) } } } catch (error) { request.log.warn({ error: error.message }, 'deepseek answer unavailable'); return { data: { answer: null } } }
})

app.get('/api/v1/document-types', async (request, reply) => repository ? { data: await repository.listDocumentTypes() } : reply.code(503).send({ error: { code: 'REPOSITORY_NOT_CONFIGURED' } }))
app.post('/api/v1/document-types', async (request, reply) => {
  const actor = await actorFor(request); const requestedTypeCode = String(request.body?.typeCode || '').trim().toUpperCase(); const typeCode = /^[A-Z0-9_-]{2,64}$/.test(requestedTypeCode) ? requestedTypeCode : `TYPE_${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`; const displayName = String(request.body?.displayName || '').trim(); const parentTypeCode = String(request.body?.parentTypeCode || '').trim().toUpperCase() || null
  if (!repository || !actor || !canManageKnowledgeBase(actor)) return reply.code(403).send({ error: { code: 'FORBIDDEN' } })
  if (!displayName || displayName.length > 64) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } })
  if (parentTypeCode && !/^[A-Z0-9_-]{2,64}$/.test(parentTypeCode)) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } })
  try { return reply.code(201).send({ data: await repository.createDocumentType({ typeCode, displayName, parentTypeCode }) }) } catch (error) { return reply.code(error.message === 'PARENT_TYPE_NOT_FOUND' ? 400 : 409).send({ error: { code: error.message === 'PARENT_TYPE_NOT_FOUND' ? error.message : 'TYPE_EXISTS' } }) }
})
app.delete('/api/v1/document-types/:typeCode', async (request, reply) => {
  const actor = await actorFor(request)
  if (!repository || !actor || !canManageKnowledgeBase(actor)) return reply.code(403).send({ error: { code: 'FORBIDDEN' } })
  try {
    await repository.deactivateDocumentType(request.params.typeCode)
    return reply.code(204).send()
  } catch (error) {
    return reply.code(error.message === 'TYPE_NOT_FOUND' ? 404 : 500).send({ error: { code: error.message || 'INTERNAL_ERROR' } })
  }
})
app.patch('/api/v1/document-types/:typeCode', async (request, reply) => {
  const actor = await actorFor(request); const displayName = String(request.body?.displayName || '').trim()
  if (!repository || !actor || !canManageKnowledgeBase(actor)) return reply.code(403).send({ error: { code: 'FORBIDDEN' } })
  if (!displayName || displayName.length > 64) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '类型名称长度应为 1 至 64 个字符。' } })
  try { return { data: await repository.renameDocumentType({ typeCode: request.params.typeCode, displayName }) } } catch (error) { return reply.code(error.message === 'TYPE_NOT_FOUND' ? 404 : 500).send({ error: { code: error.message || 'INTERNAL_ERROR' } }) }
})
app.get('/api/v1/documents', async (request, reply) => {
  if (!repository) return reply.code(503).send({ error: { code: 'REPOSITORY_NOT_CONFIGURED' } })
  const actor = await actorFor(request)
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  return { data: await repository.listDownloadDocuments(request.query?.type, allowedSecurityLevels(actor)) }
})
app.get('/api/v1/documents/manage', async (request, reply) => {
  const actor = await actorFor(request)
  if (!repository || !actor || !canManageKnowledgeBase(actor)) return reply.code(403).send({ error: { code: 'FORBIDDEN' } })
  return { data: await repository.listManageableDocuments() }
})
app.get('/api/v1/documents/:documentId/comments', async (request, reply) => repository ? { data: await repository.listComments(request.params.documentId) } : reply.code(503).send({ error: { code: 'REPOSITORY_NOT_CONFIGURED' } }))
app.post('/api/v1/documents/:documentId/comments', async (request, reply) => {
  const actor = await actorFor(request); const content = String(request.body?.content || '').trim(); const kind = request.body?.kind === 'suggestion' ? 'suggestion' : 'comment'; const parentCommentId = String(request.body?.parentCommentId || '').trim() || null
  if (!repository || !actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } })
  if (!content || content.length > 2000) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } })
  try { const comment = await repository.createComment({ documentId: request.params.documentId, parentCommentId, kind, content, actorId: actor.personId, authorName: actorName(actor) }); const mentions = [...content.matchAll(/@([^\s@，。！？,.!?:：]{1,64})/g)].map(match => match[1]); await repository.addCommentMentions({ commentId: comment.commentId, mentions }); return reply.code(201).send({ data: { ...comment, mentions } }) } catch (error) { return reply.code(error.message === 'PARENT_COMMENT_NOT_FOUND' ? 404 : 500).send({ error: { code: error.message || 'COMMENT_FAILED' } }) }
})
app.post('/api/v1/documents/:documentId/comments/attachment', async (request, reply) => {
  const actor = await actorFor(request); if (!repository || !storage || !actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } })
  let uploaded
  try { const fields = await request.parts(); let metadata; let file
    for await (const part of fields) { if (part.type === 'file') { file = part; const valid = validateCommentAttachment({ filename: file.filename, mimetype: file.mimetype, bytes: 1 }, maxUploadBytes); if (!valid.ok) { file.file.resume(); return reply.code(422).send({ error: { code: valid.code } }) }; continue }; if (part.fieldname === 'metadata') metadata = JSON.parse(part.value) }
    const content = String(metadata?.content || '').trim(); const kind = metadata?.kind === 'suggestion' ? 'suggestion' : 'comment'; if (!file || !content) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const comment = await repository.createComment({ documentId: request.params.documentId, kind, content, actorId: actor.personId, authorName: actorName(actor) }); uploaded = await storage.uploadCommentAttachment({ documentId: request.params.documentId, commentId: comment.commentId, stream: file.file, mimeType: file.mimetype }); if (uploaded.byteSize > Math.min(maxUploadBytes, 10 * 1024 * 1024)) { await storage.deleteSource(uploaded.objectKey); return reply.code(422).send({ error: { code: 'ATTACHMENT_TOO_LARGE', message: '评论附件不能超过 10 MB。' } }) }; const attachment = await repository.addCommentAttachment({ attachmentId: uploaded.attachmentId, commentId: comment.commentId, uploaded, originalFilename: file.filename, mimeType: file.mimetype }); const mentions = [...content.matchAll(/@([^\s@，。！？,.!?:：]{1,64})/g)].map(match => match[1]); await repository.addCommentMentions({ commentId: comment.commentId, mentions }); return reply.code(201).send({ data: { ...comment, attachment, mentions } })
  } catch (error) { if (uploaded) await storage.deleteSource(uploaded.objectKey).catch(() => undefined); return reply.code(500).send({ error: { code: 'COMMENT_ATTACHMENT_FAILED' } }) }
})
app.get('/api/v1/comment-attachments/:attachmentId/download', async (request, reply) => { const actor = await actorFor(request); if (!repository || !storage || !actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } }); const attachment = await repository.getCommentAttachment(request.params.attachmentId); if (!attachment) return reply.code(404).send({ error: { code: 'ATTACHMENT_NOT_FOUND' } }); return { data: { url: storage.createDownloadUrl(attachment.objectKey, 600) } } })

app.get('/api/v1/documents/:documentId/download', async (request, reply) => {
  if (!repository || !storage) return reply.code(503).send({ error: { code: 'DOWNLOAD_NOT_CONFIGURED', message: 'Document download is not configured.' } })
  const actor = await actorFor(request)
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  const document = await repository.getDownloadableDocument(request.params.documentId)
  if (!document || !allowedSecurityLevels(actor).includes(document.securityLevel)) return reply.code(404).send({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'This document is unavailable.' } })
  const url = storage.createDownloadUrl(document.objectKey, 600)
  if (request.headers.accept?.includes('application/json')) return { data: { url, expiresInSeconds: 600 } }
  return reply.redirect(url)
})

app.get('/api/v1/documents/:documentId/preview', async (request, reply) => {
  if (!repository || !storage) return reply.code(503).send({ error: { code: 'PREVIEW_NOT_CONFIGURED', message: 'Document preview is not configured.' } })
  const actor = await actorFor(request)
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  const document = await repository.getDownloadableDocument(request.params.documentId)
  if (!document || !allowedSecurityLevels(actor).includes(document.securityLevel)) return reply.code(404).send({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'This document is unavailable.' } })
  const previewable = Boolean(document.mimeType)
  if (request.query?.inline !== '1') return { data: { previewable, mimeType: document.mimeType, originalFilename: document.originalFilename, reason: null } }
  const contents = await storage.downloadSource(document.objectKey)
  const filename = encodeURIComponent(document.originalFilename || 'preview')
  return reply.header('content-disposition', `inline; filename*=UTF-8''${filename}`).type(document.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : document.mimeType).send(contents)
})

app.post('/api/v1/ask', async (request, reply) => {
  if (!repository || !answers) return reply.code(503).send({ error: { code: 'ANSWERING_NOT_CONFIGURED', message: 'DeepSeek answering is not configured.' } })
  const actor = await actorFor(request)
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  const question = typeof request.body?.question === 'string' ? request.body.question.trim() : ''
  if (!question || question.length > 500) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'question must contain 1 to 500 characters.' } })
  const sources = await repository.keywordSearchSources(question, 5, allowedSecurityLevels(actor))
  const result = await answers.answer(question, sources)
  return { data: { ...result, sources: sources.map(source => ({ documentId: source.documentId, versionId: source.versionId, chunkId: source.chunkId, headingPath: source.headingPath, content: source.content })) } }
})

app.post('/api/v1/documents/:documentId/publish', async (request, reply) => {
  if (!repository) return reply.code(503).send({ error: { code: 'REPOSITORY_NOT_CONFIGURED', message: 'Document publishing is not configured.' } })
  const actor = await actorFor(request)
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  if (!canManageKnowledgeBase(actor)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Knowledge base administrator access is required.' } })
  try {
    const published = await repository.publishDocument(request.params.documentId)
    if (ingestionQueue && embeddings && searchIndex) await ingestionQueue.enqueueIndex(published)
    return { data: published }
  } catch (error) {
    const status = error.message === 'DOCUMENT_NOT_FOUND' ? 404 : error.message === 'DOCUMENT_NOT_READY' ? 422 : 500
    return reply.code(status).send({ error: { code: error.message || 'INTERNAL_ERROR', message: 'Document could not be published.' } })
  }
})

app.post('/api/v1/documents/:documentId/retire', async (request, reply) => {
  if (!repository) return reply.code(503).send({ error: { code: 'REPOSITORY_NOT_CONFIGURED', message: 'Document retirement is not configured.' } })
  const actor = await actorFor(request)
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  if (!canManageKnowledgeBase(actor)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Knowledge base administrator access is required.' } })
  try {
    await repository.retireDocument(request.params.documentId)
    if (ingestionQueue && searchIndex) await ingestionQueue.enqueueRemoval({ documentId: request.params.documentId })
    return reply.code(204).send()
  } catch (error) {
    return reply.code(error.message === 'DOCUMENT_NOT_FOUND' ? 404 : 500).send({ error: { code: error.message || 'INTERNAL_ERROR', message: 'Document could not be retired.' } })
  }
})

app.post('/api/v1/documents/:documentId/restore', async (request, reply) => {
  if (!repository) return reply.code(503).send({ error: { code: 'REPOSITORY_NOT_CONFIGURED', message: 'Document restore is not configured.' } })
  const actor = await actorFor(request)
  if (!actor || !canManageKnowledgeBase(actor)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Knowledge base administrator access is required.' } })
  try {
    const restored = await repository.restoreDocument(request.params.documentId)
    if (ingestionQueue && embeddings && searchIndex) await ingestionQueue.enqueueIndex(restored)
    return { data: restored }
  } catch (error) {
    return reply.code(error.message === 'ARCHIVED_DOCUMENT_NOT_FOUND' ? 404 : 500).send({ error: { code: error.message || 'INTERNAL_ERROR', message: 'Document could not be restored.' } })
  }
})

app.post('/api/v1/documents/:documentId/versions', async (request, reply) => {
  if (!ingestionConfigured || !storage || !repository || !ingestionQueue) return reply.code(503).send({ error: { code: 'INGESTION_NOT_CONFIGURED', message: 'Document ingestion is not configured.' } })
  const actor = await actorFor(request)
  if (!actor || !canManageKnowledgeBase(actor)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Knowledge base administrator access is required.' } })
  let uploaded
  let file
  let mimeType
  try {
    const fields = await request.parts()
    for await (const part of fields) {
      if (part.type !== 'file') continue
      file = part
      // 预检仅判定文件类型/扩展名（此时字节数未知）；大小校验在流式上传后用真实字节数完成。
      const typeValidation = validateUploadFile({ filename: file.filename, mimetype: file.mimetype, bytes: 1 }, maxUploadBytes)
      if (!typeValidation.ok) { file.file.resume(); return reply.code(422).send({ error: { code: typeValidation.code, message: 'The uploaded file does not meet the knowledge base policy.' } }) }
      mimeType = typeValidation.mimeType
      uploaded = await storage.uploadSource({ documentId: request.params.documentId, stream: file.file, mimeType })
    }
    if (!file || !uploaded) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'One file is required.' } })
    const validation = validateUploadFile({ filename: file.filename, mimetype: file.mimetype, bytes: uploaded.byteSize }, maxUploadBytes)
    if (!validation.ok || file.file.truncated) {
      await storage.deleteSource(uploaded.objectKey)
      uploaded = undefined
      const code = file.file.truncated || validation.code === 'FILE_TOO_LARGE' ? 'FILE_TOO_LARGE' : validation.code
      const status = code === 'FILE_TOO_LARGE' ? 413 : 422
      return reply.code(status).send({ error: { code, message: 'The uploaded file does not meet the knowledge base policy.' } })
    }
    const duplicate = await repository.findVersionByHash(uploaded.contentHash)
    if (duplicate) {
      await storage.deleteSource(uploaded.objectKey)
      return reply.code(409).send({ error: { code: 'DUPLICATE_FILE', message: `该文件内容已存在（资料：${duplicate.title}，ID：${duplicate.documentId}），请勿重复上传。` } })
    }
    const created = await repository.createVersion({ documentId: request.params.documentId, uploaded, originalFilename: file.filename, mimeType, actorId: actor.personId })
    await ingestionQueue.enqueue(created)
    return reply.code(201).send({ data: created })
  } catch (error) {
    if (uploaded) await storage.deleteSource(uploaded.objectKey).catch(() => undefined)
    if (error.message === 'DUPLICATE_FILE') return reply.code(409).send({ error: { code: 'DUPLICATE_FILE', message: '该文件内容已存在，请勿重复上传。' } })
    const status = error.message === 'DOCUMENT_NOT_FOUND' ? 404 : error.code === 'ER_DUP_ENTRY' ? 409 : 500
    request.log.error(error, 'document version upload failed')
    return reply.code(status).send({ error: { code: error.message || 'INGESTION_FAILED', message: status === 409 ? 'This file already exists as a version.' : 'Document version upload failed.' } })
  }
})

app.post('/api/v1/documents', async (request, reply) => {
  if (!ingestionConfigured || !storage || !repository || !ingestionQueue) return reply.code(503).send({ error: { code: 'INGESTION_NOT_CONFIGURED', message: 'Document ingestion is not configured.' } })
  const actor = await actorFor(request)
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })

  const documentId = `kdoc_${randomUUID()}`
  let uploaded
  let mimeType
  try {
    const fields = await request.parts()
    let metadata
    let file
    for await (const part of fields) {
      if (part.type === 'file') {
        file = part
        // 预检仅判定文件类型/扩展名（此时字节数未知）；大小校验在流式上传后用真实字节数完成。
        const typeValidation = validateUploadFile({ filename: file.filename, mimetype: file.mimetype, bytes: 1 }, maxUploadBytes)
        if (!typeValidation.ok) {
          file.file.resume()
          return reply.code(422).send({ error: { code: typeValidation.code, message: 'The uploaded file does not meet the knowledge base policy.' } })
        }
        mimeType = typeValidation.mimeType
        // Fastify's multipart iterator cannot advance until this stream is consumed.
        uploaded = await storage.uploadSource({ documentId, stream: file.file, mimeType })
        continue
      }
      if (part.fieldname === 'metadata') {
        try { metadata = JSON.parse(part.value) } catch { throw new Error('INVALID_METADATA') }
      }
    }
    const parsedMetadata = createDocumentMetadata.safeParse(metadata)
    if (!parsedMetadata.success || !file || !uploaded) {
      if (uploaded) await storage.deleteSource(uploaded.objectKey)
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'A valid metadata field and one file are required.' } })
    }
    // 上传完成后再以真实字节数做权威校验（文件类型 + 空文件 + 大小）。
    const validation = validateUploadFile({ filename: file.filename, mimetype: file.mimetype, bytes: uploaded.byteSize }, maxUploadBytes)
    if (!validation.ok || file.file.truncated) {
      await storage.deleteSource(uploaded.objectKey)
      const code = file.file.truncated || validation.code === 'FILE_TOO_LARGE' ? 'FILE_TOO_LARGE' : validation.code
      const status = code === 'FILE_TOO_LARGE' ? 413 : 422
      return reply.code(status).send({ error: { code, message: 'The uploaded file does not meet the knowledge base policy.' } })
    }
    const duplicate = await repository.findVersionByHash(uploaded.contentHash)
    if (duplicate) {
      await storage.deleteSource(uploaded.objectKey)
      return reply.code(409).send({ error: { code: 'DUPLICATE_FILE', message: `该文件内容已存在（资料：${duplicate.title}，ID：${duplicate.documentId}），请勿重复上传。` } })
    }
    const created = await repository.createDraft({ documentId, metadata: parsedMetadata.data, uploaded, originalFilename: file.filename, mimeType, actorId: actor.personId })
    await ingestionQueue.enqueue(created)
    return reply.code(201).send({ data: created })
  } catch (error) {
    if (uploaded) await storage.deleteSource(uploaded.objectKey).catch(() => undefined)
    if (error.message === 'DUPLICATE_FILE') return reply.code(409).send({ error: { code: 'DUPLICATE_FILE', message: '该文件内容已存在，请勿重复上传。' } })
    request.log.error(error, 'document upload failed')
    return reply.code(500).send({ error: { code: 'INGESTION_FAILED', message: 'Document ingestion failed.' } })
  }
})

await app.listen({ port: config.port, host: '0.0.0.0' })
