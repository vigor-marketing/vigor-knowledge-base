const status = document.querySelector('#service-status')
const title = document.querySelector('#page-title')
const state = document.querySelector('#search-state')
const results = document.querySelector('#search-results')
const downloadList = document.querySelector('#download-list')

const labels = { search: '资料查询', manage: '资料管理', downloads: '资料下载' }
const typeLabels = { PRODUCT: '产品资料', TECHNICAL: '技术资料', SOP: 'SOP / 制度' }

for (const button of document.querySelectorAll('.nav')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('.nav').forEach(x => x.classList.toggle('active', x === button))
    document.querySelectorAll('.panel').forEach(x => x.classList.toggle('active', x.id === button.dataset.panel))
    title.textContent = labels[button.dataset.panel]
  })
}

fetch('/api/health')
  .then(r => r.json())
  .then(x => { status.textContent = x.capabilities.ingestion ? '资料服务已配置' : '资料服务已就绪，等待发布资料' })
  .catch(() => { status.textContent = '服务暂不可用' })

// 所有来自服务端的文本一律通过 textContent 渲染，避免 innerHTML 造成 XSS。
function empty(heading, detail) {
  const node = document.createElement('article')
  node.className = 'empty'
  const h = document.createElement('h3')
  h.textContent = heading
  node.append(h)
  if (detail) {
    const p = document.createElement('p')
    p.textContent = detail
    node.append(p)
  }
  return node
}

document.querySelector('#search-form').addEventListener('submit', async e => {
  e.preventDefault()
  const q = document.querySelector('#search-query').value.trim()
  state.hidden = false
  state.textContent = '正在检索资料…'
  results.hidden = true
  try {
    const r = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}`, { credentials: 'include' })
    const body = await r.json()
    if (!r.ok) throw Error(body.error?.message)
    const items = (body.data.results || []).map(item => {
      const article = document.createElement('article')
      article.className = 'result'
      const meta = document.createElement('p')
      meta.className = 'meta'
      meta.textContent = `资料下载 / 已发布资料 · ${item.headingPath || '未分类'} `
      const content = document.createElement('p')
      content.textContent = item.content
      const link = document.createElement('a')
      link.href = `/api/v1/documents/${encodeURIComponent(item.documentId)}/download`
      link.textContent = '快捷下载原文件'
      article.append(meta, content, link)
      return article
    })
    results.replaceChildren(...items)
    state.hidden = true
    results.hidden = false
  } catch (err) {
    state.textContent = `暂时无法搜索：${err.message}`
  }
})

document.querySelector('#upload-form').addEventListener('submit', async e => {
  e.preventDefault()
  const form = new FormData(e.currentTarget)
  const payload = new FormData()
  payload.append('metadata', JSON.stringify({
    title: form.get('title'),
    documentType: form.get('documentType'),
    language: 'zh-CN',
    securityLevel: 'internal',
    aiAllowed: true,
  }))
  payload.append('file', form.get('file'))
  const out = document.querySelector('#upload-state')
  out.textContent = '正在上传…'
  try {
    const r = await fetch('/api/v1/documents', { method: 'POST', body: payload, credentials: 'include' })
    const body = await r.json()
    if (!r.ok) throw Error(body.error?.message)
    out.textContent = `已上传 ${body.data.documentId}，等待审核发布。`
    e.currentTarget.reset()
  } catch (err) {
    out.textContent = `上传失败：${err.message}`
  }
})

let activeDocuments = []
let activeFilter = 'ALL'

async function loadDownloads() {
  downloadList.replaceChildren(empty('正在加载下载列表…'))
  try {
    const r = await fetch('/api/v1/documents', { credentials: 'include' })
    const body = await r.json()
    if (!r.ok) throw Error(body.error?.message)
    activeDocuments = body.data || []
    renderDownloads()
  } catch (err) {
    downloadList.replaceChildren(empty('无法加载下载列表', err.message))
  }
}

function renderDownloads() {
  const documents = activeDocuments.filter(doc => activeFilter === 'ALL' || doc.documentType === activeFilter)
  if (!documents.length) {
    downloadList.replaceChildren(empty('这里还没有资料', '资料发布后会按分类展示，并标明最新版本和更新时间。'))
    return
  }
  const cards = documents.map(doc => {
    const card = document.createElement('article')
    card.className = 'file-card'
    const h = document.createElement('h3')
    h.textContent = doc.title
    const meta = document.createElement('p')
    meta.className = 'meta'
    const updated = doc.updatedAt ? new Date(doc.updatedAt).toLocaleString('zh-CN') : ''
    meta.textContent = `${typeLabels[doc.documentType] || doc.documentType} · ${doc.versionLabel || ''} · ${updated}`.trim()
    const link = document.createElement('a')
    link.href = `/api/v1/documents/${encodeURIComponent(doc.documentId)}/download`
    link.textContent = '下载原文件'
    card.append(h, meta, link)
    return card
  })
  downloadList.replaceChildren(...cards)
}

for (const button of document.querySelectorAll('.filter')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach(x => x.classList.toggle('active', x === button))
    activeFilter = button.dataset.filter || 'ALL'
    renderDownloads()
  })
}

loadDownloads()
