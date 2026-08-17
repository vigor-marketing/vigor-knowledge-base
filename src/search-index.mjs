export class SearchIndex {
  constructor({ node, indexName, dimensions }) {
    this.node = node.replace(/\/$/, '')
    this.indexName = indexName
    this.dimensions = dimensions
  }

  async call(path, options = {}) {
    const r = await fetch(`${this.node}${path}`, { ...options, headers: { 'content-type': 'application/json' } })
    if (!r.ok) throw new Error(`Qdrant request failed: ${r.status}`)
    return r.json()
  }

  async ensureMapping() {
    const r = await fetch(`${this.node}/collections/${this.indexName}/exists`)
    const exists = r.ok && (await r.json()).result?.exists
    if (!exists) {
      await this.call(`/collections/${this.indexName}`, { method: 'PUT', body: JSON.stringify({ vectors: { size: this.dimensions, distance: 'Cosine' } }) })
    }
    await this.ensureFullTextIndex()
  }

  async ensureFullTextIndex() {
    try {
      const existing = await fetch(`${this.node}/collections/${this.indexName}/index/content`)
      if (existing.ok) return
      await this.call(`/collections/${this.indexName}/index?wait=true`, { method: 'PUT', body: JSON.stringify({ field_name: 'content', field_schema: 'text', tokenizer: 'multilingual' }) })
    } catch (error) {
      console.error('Qdrant full-text index setup failed; keyword search will be disabled:', error.message)
    }
  }

  async indexChunks(chunks, vectors) {
    await this.call(`/collections/${this.indexName}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({ points: chunks.map((chunk, i) => ({ id: chunk.chunkId.replace('kchunk_', ''), vector: vectors[i], payload: chunk })) }),
    })
  }

  async removeDocument(documentId) {
    await this.call(`/collections/${this.indexName}/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({ filter: { must: [{ key: 'documentId', match: { value: documentId } }] } }),
    })
  }

  baseFilter(securityLevels) {
    // aiAllowed 已在 getIndexableChunks 中按 ai_allowed = TRUE 过滤，且 MySQL BOOLEAN
    // 返回 0/1 整数，与 Qdrant 的 boolean true 过滤类型不符，故不在此重复过滤。
    return { must: [{ key: 'status', match: { value: 'active' } }, { key: 'securityLevel', match: { any: securityLevels } }] }
  }

  async vectorSearch({ vector, limit, filter }) {
    const d = await this.call(`/collections/${this.indexName}/points/search`, {
      method: 'POST',
      body: JSON.stringify({ vector, limit, filter, with_payload: true }),
    })
    return (d.result || []).map(x => ({ ...x.payload, score: x.score }))
  }

  async keywordSearch({ query, limit, filter }) {
    const d = await this.call(`/collections/${this.indexName}/points/scroll`, {
      method: 'POST',
      body: JSON.stringify({
        limit,
        with_payload: true,
        with_vector: false,
        filter: { must: [...filter.must, { key: 'content', match: { text: query } }] },
      }),
    })
    return (d.result?.points || []).map(point => ({ ...point.payload, score: 1 }))
  }

  async hybridSearch({ query, vector, limit = 10, securityLevels = ['public', 'internal'] }) {
    const filter = this.baseFilter(securityLevels)
    const candidateLimit = Math.max(limit * 2, 20)
    const vectorHits = await this.vectorSearch({ vector, limit: candidateLimit, filter })
    let keywordHits = []
    if (query) {
      try {
        keywordHits = await this.keywordSearch({ query, limit: candidateLimit, filter })
      } catch (error) {
        console.error('Qdrant keyword search failed; falling back to vector-only:', error.message)
      }
    }
    return reciprocalRankFuse([vectorHits, keywordHits].filter(set => set.length > 0), limit)
  }
}

export function reciprocalRankFuse(resultSets, limit, k = 60) {
  const scores = new Map()
  for (const set of resultSets) set.forEach((hit, i) => { const x = scores.get(hit.chunkId) || { hit, score: 0 }; x.score += 1 / (k + i + 1); scores.set(hit.chunkId, x) })
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(x => ({ ...x.hit, score: x.score }))
}
