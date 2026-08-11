import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import { strFromU8, unzipSync } from 'fflate'
import XLSX from 'xlsx'

function completed(text, details = {}) {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  const replacementCharacterCount = (normalized.match(/�/g) || []).length
  return normalized
    ? { status: 'completed', reason: null, text: normalized, quality: { charCount: normalized.length, replacementCharacterCount, ...details } }
    : { status: 'review', reason: 'EMPTY_EXTRACTED_TEXT', text: '', quality: { charCount: 0, replacementCharacterCount, ...details } }
}

export function parseTextDocument({ buffer, mimeType }) {
  if (!['text/plain', 'text/markdown'].includes(mimeType)) return { status: 'review', reason: 'PARSER_NOT_ENABLED', text: '', quality: { charCount: 0, replacementCharacterCount: 0 } }
  return completed(buffer.toString('utf8'))
}

export async function parseDocument({ buffer, mimeType }) {
  if (['text/plain', 'text/markdown'].includes(mimeType)) return parseTextDocument({ buffer, mimeType })
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer })
    return completed(result.value, { warningCount: result.messages.length })
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    const workbook = XLSX.read(buffer, { type: 'buffer', raw: false })
    const text = workbook.SheetNames.map(name => `# ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`).join('\n\n')
    return completed(text, { sheetCount: workbook.SheetNames.length })
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    const archive = unzipSync(buffer)
    const slides = Object.keys(archive).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const text = slides.map((path, index) => `# Slide ${index + 1}\n${[...strFromU8(archive[path]).matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(match => match[1]).join(' ')}`).join('\n\n')
    return completed(text, { slideCount: slides.length })
  }
  if (mimeType === 'application/pdf') {
    const parser = new PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      return completed(result.text, { pageCount: result.total || 0 })
    } finally {
      await parser.destroy()
    }
  }
  return { status: 'review', reason: 'PARSER_NOT_ENABLED', text: '', quality: { charCount: 0, replacementCharacterCount: 0 } }
}
