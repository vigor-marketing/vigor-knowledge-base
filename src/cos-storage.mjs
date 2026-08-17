import COS from 'cos-nodejs-sdk-v5'
import { createHash, randomUUID } from 'node:crypto'

function putObject(client, options) {
  return new Promise((resolve, reject) => client.putObject(options, (error, result) => error ? reject(error) : resolve(result)))
}

function deleteObject(client, options) {
  return new Promise((resolve, reject) => client.deleteObject(options, error => error ? reject(error) : resolve()))
}

function getObject(client, options) {
  return new Promise((resolve, reject) => client.getObject(options, (error, result) => error ? reject(error) : resolve(result)))
}

export class CosStorage {
  constructor(config, client = new COS({ SecretId: config.secretId, SecretKey: config.secretKey })) {
    this.client = client
    this.bucket = config.bucket
    this.region = config.region
    this.prefix = config.prefix.replace(/^\/+|\/+$/g, '')
  }

  async uploadSource({ documentId, stream, mimeType }) {
    const versionId = `kver_${randomUUID()}`
    const objectKey = `${this.prefix}/documents/${documentId}/versions/${versionId}/source`
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const contentHash = createHash('sha256').update(body).digest('hex')
    await putObject(this.client, { Bucket: this.bucket, Region: this.region, Key: objectKey, Body: body, ContentType: mimeType })
    return { versionId, objectKey, byteSize: body.length, contentHash }
  }
  async uploadCommentAttachment({ documentId, commentId, stream, mimeType }) {
    const attachmentId = `katt_${randomUUID()}`; const objectKey = `${this.prefix}/documents/${documentId}/comments/${commentId}/attachments/${attachmentId}`; const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const body = Buffer.concat(chunks); await putObject(this.client, { Bucket: this.bucket, Region: this.region, Key: objectKey, Body: body, ContentType: mimeType })
    return { attachmentId, objectKey, byteSize: body.length }
  }

  async deleteSource(objectKey) {
    await deleteObject(this.client, { Bucket: this.bucket, Region: this.region, Key: objectKey })
  }

  async downloadSource(objectKey) {
    const result = await getObject(this.client, { Bucket: this.bucket, Region: this.region, Key: objectKey })
    if (Buffer.isBuffer(result.Body)) return result.Body
    const chunks = []
    for await (const chunk of result.Body) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  createDownloadUrl(objectKey, expiresSeconds) {
    return this.client.getObjectUrl({ Bucket: this.bucket, Region: this.region, Key: objectKey, Sign: true, Expires: expiresSeconds })
  }
}
