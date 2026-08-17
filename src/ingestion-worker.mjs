import { Worker } from 'bullmq'
import IORedis from 'ioredis'
import { loadConfig } from './config.mjs'
import { CosStorage } from './cos-storage.mjs'
import { DocumentRepository } from './document-repository.mjs'
import { parseDocument } from './text-parser.mjs'
import { EmbeddingClient } from './embedding-client.mjs'
import { SearchIndex } from './search-index.mjs'

const config = loadConfig()
if (!config.redisUrl || !config.mysqlUrl || !config.cos) throw new Error('Worker requires Redis, MySQL, and COS configuration.')

const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null })
const storage = new CosStorage(config.cos)
const repository = new DocumentRepository(config.mysqlUrl)
const embeddings = config.search ? new EmbeddingClient({ url: config.search.embeddingUrl, apiKey: config.search.embeddingApiKey, model: config.search.embeddingModel, dimensions: config.search.embeddingDimensions, hunyuan: config.search.hunyuan }) : undefined
const searchIndex = config.search ? new SearchIndex({ node: config.search.node, apiKey: config.search.apiKey, indexName: config.search.indexName, dimensions: config.search.embeddingDimensions }) : undefined
if (searchIndex) await searchIndex.ensureMapping()

const worker = new Worker('knowledge-ingestion', async job => {
  try {
    if (job.name === 'remove-document') {
      if (searchIndex) await searchIndex.removeDocument(job.data.documentId)
      return
    }
    if (job.name === 'index-document') {
      if (!embeddings || !searchIndex) throw new Error('Search indexing is not configured.')
      const chunks = await repository.getIndexableChunks(job.data.versionId)
      if (chunks.length) await searchIndex.indexChunks(chunks, await embeddings.embed(chunks.map(chunk => chunk.content)))
      await repository.markChunksIndexed(job.data.versionId)
      return
    }
    const source = await repository.getSourceForJob(job.data.jobId)
    if (!source) throw new Error(`Ingestion job ${job.data.jobId} was not found.`)
    await repository.markJobProcessing(job.data.jobId)
    const buffer = await storage.downloadSource(source.objectKey)
    const parsed = await parseDocument({ buffer, mimeType: source.mimeType })
    await repository.saveExtraction({ jobId: job.data.jobId, versionId: source.versionId, parsed })
  } catch (error) {
    if (job.data.jobId) await repository.markJobFailed(job.data.jobId, error)
    throw error
  }
}, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 2) })

worker.on('failed', (job, error) => console.error('ingestion job failed', { jobId: job?.id, error: error.message }))
worker.on('error', error => console.error('ingestion worker error', error))
