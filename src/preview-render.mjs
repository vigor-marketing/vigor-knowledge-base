import mammoth from 'mammoth'
import XLSX from 'xlsx'
import { strFromU8, unzipSync } from 'fflate'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

function shell(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>${esc(title)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:28px 32px;color:#1f1f23;background:#f5f5f5;line-height:1.7}h1{font-size:22px}h2{font-size:17px;color:#333;margin:22px 0 8px;border-bottom:1px solid #e6e6e6;padding-bottom:6px}p{margin:8px 0}table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}td,th{border:1px solid #dcdcdc;padding:6px 9px;text-align:left}th{background:#f2f2f2;font-weight:700}tr:nth-child(even) td{background:#fafafa}.slide{background:#fff;border:1px solid #e6e6e6;border-radius:10px;padding:18px 20px;margin:14px 0}.slide h2{color:#d92d20;font-size:14px;border:0;margin:0 0 8px}.slide p{white-space:pre-wrap;margin:0}</style></head><body>${body}</body></html>`
}

// 将 Office 文件渲染为 HTML 供 iframe 直接预览；返回 null 表示保持原文件格式。
export async function renderPreviewHtml(buffer, mimeType) {
  try {
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.convertToHtml({ buffer })
      return shell('文档预览', `<h1>文档预览</h1>${result.value}`)
    }
    if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      const workbook = XLSX.read(buffer, { type: 'buffer' })
      const sheets = workbook.SheetNames.map(name => `<h2>${esc(name)}</h2>${XLSX.utils.sheet_to_html(workbook.Sheets[name])}`).join('')
      return shell('表格预览', `<h1>表格预览</h1>${sheets}`)
    }
    if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      const archive = unzipSync(buffer)
      const slides = Object.keys(archive).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      const body = slides.map((path, index) => {
        const text = [...strFromU8(archive[path]).matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(match => match[1]).join(' ')
        return `<section class="slide"><h2>第 ${index + 1} 页</h2><p>${esc(text) || '（此页无文本内容）'}</p></section>`
      }).join('')
      return shell('演示文稿预览', `<h1>演示文稿预览</h1>${body}`)
    }
  } catch (error) {
    // 渲染失败时回退为原文件格式，让浏览器按 MIME 处理（PDF/文本/图片仍可正常查看）。
    return null
  }
  return null
}
