export class AnswerService {
  constructor({ baseUrl, apiKey, model }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
    this.model = model
  }

  async answer(question, sources) {
    if (!sources.length) return { answer: '知识库中没有找到足以支持该问题的已发布资料。', confidence: 'low' }
    const evidence = sources.map((source, index) => `[${index + 1}] 文档名称：${source.title || source.originalFilename || source.documentId}；版本：${source.versionId}${source.headingPath ? `；章节：${source.headingPath}` : ''}\n${source.content}`).join('\n\n')
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: '你是企业知识库助手。只能根据提供的证据回答；没有明确证据时必须说明无法确认，不得编造。输出固定为两段：\n资料概述：用 1—2 句简述命中文档的主题、适用范围和其中可确认的关键信息，并标注证据编号。\n回答：直接回答用户问题；信息不足时说明还缺少什么资料。\n总长度控制在 180 字以内。区分资料事实与推理建议，每项结论均标注证据编号，例如 [1]。' },
          { role: 'user', content: `问题：${question}\n\n证据：\n${evidence}` },
        ],
      }),
    })
    if (!response.ok) throw new Error(`DeepSeek returned ${response.status}.`)
    const body = await response.json()
    const answer = body.choices?.[0]?.message?.content?.trim()
    if (!answer) throw new Error('DeepSeek returned no answer.')
    return { answer, confidence: sources.length >= 3 ? 'high' : 'medium' }
  }
}
