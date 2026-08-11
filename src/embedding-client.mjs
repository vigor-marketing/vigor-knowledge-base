export class EmbeddingClient {
  constructor({ url, apiKey, model, dimensions }) {
    this.url = url.replace(/\/$/, '')
    this.apiKey = apiKey
    this.model = model
    this.dimensions = dimensions
  }

  async embed(inputs) {
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
}
