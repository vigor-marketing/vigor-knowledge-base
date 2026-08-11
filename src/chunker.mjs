function splitLongParagraph(paragraph, maxChars) {
  if (paragraph.length <= maxChars) return [paragraph]
  const sentences = paragraph.split(/(?<=[。！？.!?])\s+/)
  const chunks = []
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > maxChars) {
      chunks.push(current)
      current = sentence
    } else current = current ? `${current}\n${sentence}` : sentence
  }
  if (current) chunks.push(current)
  return chunks
}

export function chunkExtractedText(text, maxChars = 1200) {
  const sections = text.split(/\n(?=# )/)
  const chunks = []
  for (const section of sections) {
    const lines = section.split('\n')
    const heading = lines[0]?.startsWith('# ') ? lines.shift().slice(2) : undefined
    const paragraphs = lines.join('\n').split(/\n{2,}/).map(value => value.trim()).filter(Boolean)
    for (const paragraph of paragraphs) {
      for (const content of splitLongParagraph(paragraph, maxChars)) chunks.push({ ordinal: chunks.length + 1, headingPath: heading || null, content })
    }
  }
  return chunks
}
