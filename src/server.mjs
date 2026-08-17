import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowedSecurityLevels, createDocumentMetadata, validateUploadFile } from './document-policy.mjs'
import { loadConfig } from './config.mjs'
import { CosStorage } from './cos-storage.mjs'
import { DocumentRepository } from './document-repository.mjs'
import { canManageKnowledgeBase, createAuthenticator } from './auth.mjs'
import { IngestionQueue } from './ingestion-queue.mjs'
import { EmbeddingClient } from './embedding-client.mjs'
import { SearchIndex } from './search-index.mjs'
import { AnswerService } from './answer-service.mjs'

const config = loadConfig()
const ingestionConfigured = Boolean(config.mysqlUrl && config.cos && config.oidc && config.redisUrl)
const storage = config.cos ? new CosStorage(config.cos) : undefined
const repository = config.mysqlUrl ? new DocumentRepository(config.mysqlUrl) : undefined
const authenticate = createAuthenticator(config.oidc || {})
const ingestionQueue = config.redisUrl ? new IngestionQueue(config.redisUrl) : undefined
const embeddings = config.search ? new EmbeddingClient({ url: config.search.embeddingUrl, apiKey: config.search.embeddingApiKey, model: config.search.embeddingModel, dimensions: config.search.embeddingDimensions }) : undefined
const searchIndex = config.search ? new SearchIndex({ node: config.search.node, apiKey: config.search.apiKey, indexName: config.search.indexName, dimensions: config.search.embeddingDimensions }) : undefined
const answers = config.deepseek ? new AnswerService(config.deepseek) : undefined
const maxUploadBytes = config.maxUploadBytes
const basePath = config.basePath
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url))
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes })

const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

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
    return reply.type(contentTypes[extname(filePath)] || 'application/octet-stream').send(contents)
  } catch {
    return reply.type('text/html; charset=utf-8').send(await readFile(join(publicRoot, 'index.html')))
  }
})

app.get('/api/v1/search', async (request, reply) => {
  if (!authenticate || !embeddings || !searchIndex) return reply.code(503).send({ error: { code: 'SEARCH_NOT_CONFIGURED', message: 'Search is not configured.' } })
  let actor
  try { actor = await authenticate({ authorization: request.headers.authorization, cookie: request.headers.cookie }) } catch { actor = undefined }
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  const query = typeof request.query?.q === 'string' ? request.query.q.trim() : ''
  if (!query || query.length > 500) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'q must contain 1 to 500 characters.' } })
  const vector = (await embeddings.embed([query]))[0]
  const results = await searchIndex.hybridSearch({ query, vector, securityLevels: allowedSecurityLevels(actor) })
  return { data: { query, results: results.map(result => ({ chunkId: result.chunkId, documentId: result.documentId, versionId: result.versionId, content: result.content, headingPath: result.headingPath, score: result.score })) } }
})

app.get('/api/v1/documents', async (request, reply) => {
  if (!authenticate || !repository) return reply.code(503).send({ error: { code: 'DOWNLOAD_NOT_CONFIGURED', message: 'Document download is not configured.' } })
  let actor
  try { actor = await authenticate({ authorization: request.headers.authorization, cookie: request.headers.cookie }) } catch { actor = undefined }
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  const allowed = allowedSecurityLevels(actor)
  const documents = await repository.listDownloadableDocuments()
  const visible = documents.filter(document => allowed.includes(document.securityLevel)).map(({ securityLevel, ...document }) => document)
  return { data: visible }
})

app.get('/api/v1/documents/:documentId/download', async (request, reply) => {
  if (!authenticate || !repository || !storage) return reply.code(503).send({ error: { code: 'DOWNLOAD_NOT_CONFIGURED', message: 'Document download is not configured.' } })
  let actor
  try { actor = await authenticate({ authorization: request.headers.authorization, cookie: request.headers.cookie }) } catch { actor = undefined }
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  const document = await repository.getDownloadableDocument(request.params.documentId)
  if (!document || !allowedSecurityLevels(actor).includes(document.securityLevel)) return reply.code(404).send({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'This document is unavailable.' } })
  return reply.redirect(storage.createDownloadUrl(document.objectKey, 600))
})

app.post('/api/v1/ask', async (request, reply) => {
  if (!authenticate || !embeddings || !searchIndex || !answers) return reply.code(503).send({ error: { code: 'ANSWERING_NOT_CONFIGURED', message: 'AI answering is not configured.' } })
  let actor
  try { actor = await authenticate({ authorization: request.headers.authorization, cookie: request.headers.cookie }) } catch { actor = undefined }
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  const question = typeof request.body?.question === 'string' ? request.body.question.trim() : ''
  if (!question || question.length > 500) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'question must contain 1 to 500 characters.' } })
  const vector = (await embeddings.embed([question]))[0]
  const sources = await searchIndex.hybridSearch({ query: question, vector, limit: 5, securityLevels: allowedSecurityLevels(actor) })
  const result = await answers.answer(question, sources)
  return { data: { ...result, sources: sources.map(source => ({ documentId: source.documentId, versionId: source.versionId, chunkId: source.chunkId, headingPath: source.headingPath, content: source.content })) } }
})

app.post('/api/v1/documents/:documentId/publish', async (request, reply) => {
  if (!authenticate || !repository || !ingestionQueue || !embeddings || !searchIndex) return reply.code(503).send({ error: { code: 'INGESTION_NOT_CONFIGURED', message: 'Document publishing is not configured.' } })
  let actor
  try { actor = await authenticate({ authorization: request.headers.authorization, cookie: request.headers.cookie }) } catch { actor = undefined }
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  if (!canManageKnowledgeBase(actor)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Knowledge base administrator access is required.' } })
  try {
    const published = await repository.publishDocument(request.params.documentId)
    await ingestionQueue.enqueueIndex(published)
    return { data: published }
  } catch (error) {
    const status = error.message === 'DOCUMENT_NOT_FOUND' ? 404 : error.message === 'DOCUMENT_NOT_READY' ? 422 : 500
    return reply.code(status).send({ error: { code: error.message || 'INTERNAL_ERROR', message: 'Document could not be published.' } })
  }
})

app.post('/api/v1/documents/:documentId/retire', async (request, reply) => {
  if (!authenticate || !repository || !ingestionQueue || !searchIndex) return reply.code(503).send({ error: { code: 'INGESTION_NOT_CONFIGURED', message: 'Document retirement is not configured.' } })
  let actor
  try { actor = await authenticate({ authorization: request.headers.authorization, cookie: request.headers.cookie }) } catch { actor = undefined }
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })
  if (!canManageKnowledgeBase(actor)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Knowledge base administrator access is required.' } })
  try {
    await repository.retireDocument(request.params.documentId)
    await ingestionQueue.enqueueRemoval({ documentId: request.params.documentId })
    return reply.code(204).send()
  } catch (error) {
    return reply.code(error.message === 'DOCUMENT_NOT_FOUND' ? 404 : 500).send({ error: { code: error.message || 'INTERNAL_ERROR', message: 'Document could not be retired.' } })
  }
})

app.post('/api/v1/documents', async (request, reply) => {
  if (!ingestionConfigured || !storage || !repository || !authenticate || !ingestionQueue) return reply.code(503).send({ error: { code: 'INGESTION_NOT_CONFIGURED', message: 'Document ingestion is not configured.' } })
  let actor
  try { actor = await authenticate({ authorization: request.headers.authorization, cookie: request.headers.cookie }) } catch { actor = undefined }
  if (!actor) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A verified platform user is required.' } })

  const fields = await request.parts()
  let metadata
  let file
  for await (const part of fields) {
    if (part.type === 'file') {
      file = part
      continue
    }
    if (part.fieldname === 'metadata') {
      try { metadata = JSON.parse(part.value) } catch { return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Metadata must be valid JSON.' } }) }
    }
  }
  const parsedMetadata = createDocumentMetadata.safeParse(metadata)
  if (!parsedMetadata.success || !file) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'A valid metadata field and one file are required.' } })

  const documentId = `kdoc_${randomUUID()}`
  let uploaded
  try {
    uploaded = await storage.uploadSource({ documentId, stream: file.file, mimeType: file.mimetype })
    const validation = validateUploadFile({ filename: file.filename, mimetype: file.mimetype, bytes: uploaded.byteSize }, maxUploadBytes)
    if (!validation.ok || file.file.truncated) {
      await storage.deleteSource(uploaded.objectKey)
      const code = file.file.truncated || validation.code === 'FILE_TOO_LARGE' ? 'FILE_TOO_LARGE' : validation.code
      const status = code === 'FILE_TOO_LARGE' ? 413 : 422
      return reply.code(status).send({ error: { code, message: 'The uploaded file does not meet the knowledge base policy.' } })
    }
    const created = await repository.createDraft({ documentId, metadata: parsedMetadata.data, uploaded, originalFilename: file.filename, mimeType: file.mimetype, actorId: actor.personId })
    await ingestionQueue.enqueue(created)
    return reply.code(201).send({ data: created })
  } catch (error) {
    if (uploaded) await storage.deleteSource(uploaded.objectKey).catch(() => undefined)
    request.log.error(error, 'document upload failed')
    return reply.code(500).send({ error: { code: 'INGESTION_FAILED', message: 'Document ingestion failed.' } })
  }
})

await app.listen({ port: config.port, host: '0.0.0.0' })
