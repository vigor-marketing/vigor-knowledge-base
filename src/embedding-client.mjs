import { createHash, createHmac } from 'node:crypto'

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function hmac(key, value, encoding) { return createHmac('sha256', key).update(value).digest(encoding) }

export class EmbeddingClient {
  constructor({ url, apiKey, model, dimensions, hunyuan }) {
    this.url = url?.replace(/\/$/, '')
    this.apiKey = apiKey
    this.model = model
    this.dimensions = dimensions
    this.hunyuan = hunyuan
  }

  async embed(inputs) {
    if (this.hunyuan) return this.embedWithHunyuan(inputs)
    const response = await fetch(`${this.url}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: inputs }),
    })
    if (!response.ok) throw new Error(`Embedding service returned ${response.status}.`)
    const body = await response.json()
    const vectors = body.data?.sort((left, right) => left.index - right.index).map(item => item.embedding)
    if (!Array.isArray(vectors) || vectors.length !== inputs.length || vectors.some(vector => !Array.isArray(vector) || vector.length !== this.dimensions)) throw new Error('Embedding response has an unexpected shape.')
    return vectors
  }

  async embedWithHunyuan(inputs) {
    const host = 'hunyuan.tencentcloudapi.com'
    const timestamp = Math.floor(Date.now() / 1000)
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
    const payload = JSON.stringify({ InputList: inputs })
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`
    const signedHeaders = 'content-type;host'
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hash(payload)}`
    const credentialScope = `${date}/hunyuan/tc3_request`
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hash(canonicalRequest)}`
    const secretDate = hmac(`TC3${this.hunyuan.secretKey}`, date)
    const secretService = hmac(secretDate, 'hunyuan')
    const secretSigning = hmac(secretService, 'tc3_request')
    const signature = hmac(secretSigning, stringToSign, 'hex')
    const authorization = `TC3-HMAC-SHA256 Credential=${this.hunyuan.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    const response = await fetch(`https://${host}`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', host, authorization, 'x-tc-action': 'GetEmbedding', 'x-tc-version': '2023-09-01', 'x-tc-region': this.hunyuan.region, 'x-tc-timestamp': String(timestamp) }, body: payload })
    if (!response.ok) throw new Error(`Hunyuan embedding service returned ${response.status}.`)
    const body = await response.json()
    const vectors = body.Response?.Data?.sort((left, right) => left.Index - right.Index).map(item => item.Embedding)
    if (!Array.isArray(vectors) || vectors.length !== inputs.length || vectors.some(vector => !Array.isArray(vector) || vector.length !== this.dimensions)) throw new Error('Hunyuan embedding response has an unexpected shape.')
    return vectors
  }
}
