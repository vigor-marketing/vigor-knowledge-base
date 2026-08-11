import { Queue } from 'bullmq'
import IORedis from 'ioredis'

export class IngestionQueue {
  constructor(redisUrl) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null })
    this.queue = new Queue('knowledge-ingestion', { connection: this.connection })
  }

  async enqueue({ jobId, documentId, versionId }) {
    await this.queue.add('parse-document', { jobId, documentId, versionId }, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    })
  }

  async enqueueIndex({ documentId, versionId }) {
    await this.queue.add('index-document', { documentId, versionId }, { jobId: `index-${versionId}`, attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: false })
  }

  async enqueueRemoval({ documentId }) {
    await this.queue.add('remove-document', { documentId }, { jobId: `remove-${documentId}`, attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: false })
  }
}
