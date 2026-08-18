const EMBEDDED = window.self !== window.top; if (EMBEDDED) document.documentElement.classList.add("workbench-embedded");
const API_PATHS = window.location.pathname.startsWith('/apps/knowledge-base') ? ['/apps/knowledge-base/api', '/api'] : ['/api', '/apps/knowledge-base/api']
const state = { types: [], activeType: '', activeDocumentId: '', downloads: [], allDownloads: [], manageable: [] }
let lastEmbeddedHeight = 0
const $ = selector => document.querySelector(selector)
const escapeHtml = value => String(value || '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]))
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const queryTerms = query => { const q = String(query || '').trim(); return q ? [...new Set([q, ...q.split(/[\s,，。；;、！？!?的了是和与及在]+/).filter(term => term.length >= 2)])] : [] }
// 在已转义文本上对查询词做一次正则替换高亮，避免对 <mark> 内文本二次拆分。
const highlight = (text, terms) => {
  const escaped = escapeHtml(text || '')
  const ordered = [...new Set(terms)].map(escapeHtml).filter(term => term.length >= 2).sort((a, b) => b.length - a.length)
  if (!ordered.length) return escaped
  return escaped.replace(new RegExp(`(${ordered.map(escapeRegExp).join('|')})`, 'g'), '<mark>$1</mark>')
}
const headers = (extra = {}) => extra

async function api(path, options = {}) {
  let fallbackError
  for (const base of API_PATHS) {
    try {
      const response = await fetch(`${base}${path}`, { credentials: 'include', ...options, headers: headers(options.headers) })
      const body = await response.json().catch(() => undefined)
      if (response.ok) return body?.data
      if (response.status === 401 || response.status === 403) throw new Error('请先通过工作平台统一登录并获得资料库管理权限。')
      if (![502, 503, 504].includes(response.status) && body) throw new Error(body.error?.message || `请求失败（${response.status}）`)
      fallbackError = new Error(`请求失败（${response.status}）`)
    } catch (error) {
      if (error.message === '请先通过工作平台统一登录并获得资料库管理权限。') throw error
      fallbackError = error
    }
  }
  throw fallbackError || new Error('资料服务暂不可用')
}
function setMessage(selector, message, error = false) { const node = $(selector); node.textContent = message; node.classList.toggle('error', error); node.classList.toggle('success', Boolean(message) && !error) }
function formatDate(value) { return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—' }
function formatBytes(bytes) { if (!Number.isFinite(bytes) || bytes <= 0) return ''; const units = ['B', 'KB', 'MB', 'GB']; let index = 0; let value = bytes; while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ } return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}` }
function countFilesForType(typeCode) {
  const codes = new Set([typeCode])
  const visit = code => state.types.filter(type => (type.parentTypeCode || '') === code).forEach(child => { codes.add(child.typeCode); visit(child.typeCode) })
  visit(typeCode)
  return state.allDownloads.filter(document => codes.has(document.documentType)).length
}
function typeLabel(code) { return state.types.find(type => type.typeCode === code)?.displayName || code }
function logicalPath(record) { return `资料下载 / ${typeLabel(record.documentType) || '未分类'} / ${record.originalFilename || record.title || '未命名资料'}` }
function childTypes(parentTypeCode = '') { return state.types.filter(type => (type.parentTypeCode || '') === parentTypeCode) }
function categoryTrail(typeCode) {
  const trail = []
  const visited = new Set()
  let current = state.types.find(type => type.typeCode === typeCode)
  while (current && !visited.has(current.typeCode)) { trail.unshift(current); visited.add(current.typeCode); current = state.types.find(type => type.typeCode === current.parentTypeCode) }
  return trail
}
function categoryOptionLabel(type) { return `${'　'.repeat(Math.max(categoryTrail(type.typeCode).length - 1, 0))}${type.displayName}` }
function syncEmbeddedHeight() {
  if (!EMBEDDED) return
  const height = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, document.documentElement.offsetHeight, document.body.offsetHeight))
  if (height === lastEmbeddedHeight) return
  lastEmbeddedHeight = height
  try {
    const frame = window.frameElement
    if (frame?.style) { frame.style.height = `${height}px`; frame.style.minHeight = `${height}px` }
  } catch { /* The workbench may isolate the iframe; postMessage remains available below. */ }
  window.parent.postMessage({ type: 'vigor.workbench.embed.resize.v1', appId: 'knowledge-base', height }, window.location.origin)
}
function revealExpandedContent(node) {
  requestAnimationFrame(() => {
    node?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    syncEmbeddedHeight()
    setTimeout(syncEmbeddedHeight, 220)
  })
}
function renderMentions(text) { return escapeHtml(text).replace(/@([^\s@，。！？,.!?:：]{1,64})/g, '<mark class="mention">@$1</mark>') }
function createTypeCode(displayName) {
  const normalized = displayName.trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return normalized.length >= 2 ? normalized.slice(0, 64) : `TYPE_${Date.now().toString(36).toUpperCase()}`
}
function confirmAction({ title, message, confirmLabel, danger = true }) {
  return new Promise(resolve => {
    const dialog = window.document.createElement('div'); dialog.className = 'action-dialog'; dialog.innerHTML = `<div class="action-dialog__backdrop"></div><section class="action-dialog__panel" role="alertdialog" aria-modal="true" aria-labelledby="action-dialog-title"><p class="eyebrow">请确认操作</p><h3 id="action-dialog-title"></h3><p class="action-dialog__message"></p><div class="action-dialog__actions"><button type="button" class="action-dialog__cancel">取消</button><button type="button" class="${danger ? 'danger ' : ''}action-dialog__confirm"></button></div></section>`
    dialog.querySelector('#action-dialog-title').textContent = title; dialog.querySelector('.action-dialog__message').textContent = message; dialog.querySelector('.action-dialog__confirm').textContent = confirmLabel
    const close = result => { dialog.remove(); resolve(result) }
    dialog.querySelector('.action-dialog__cancel').addEventListener('click', () => close(false)); dialog.querySelector('.action-dialog__confirm').addEventListener('click', () => close(true)); dialog.querySelector('.action-dialog__backdrop').addEventListener('click', () => close(false))
    window.document.body.append(dialog); dialog.querySelector('.action-dialog__cancel').focus()
  })
}

// 与 confirmAction 同风格的输入对话框，替代浏览器原生 prompt。
function promptAction({ title, message, value = '', confirmLabel = '确认', danger = false }) {
  return new Promise(resolve => {
    const dialog = window.document.createElement('div'); dialog.className = 'action-dialog'
    dialog.innerHTML = `<div class="action-dialog__backdrop"></div><section class="action-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="action-dialog-title"><p class="eyebrow">请确认操作</p><h3 id="action-dialog-title"></h3><p class="action-dialog__message"></p><input class="action-dialog__input" maxlength="64"/><div class="action-dialog__actions"><button type="button" class="action-dialog__cancel">取消</button><button type="button" class="${danger ? 'danger ' : ''}action-dialog__confirm"></button></div></section>`
    dialog.querySelector('#action-dialog-title').textContent = title
    dialog.querySelector('.action-dialog__message').textContent = message
    const input = dialog.querySelector('.action-dialog__input'); input.value = value
    dialog.querySelector('.action-dialog__confirm').textContent = confirmLabel
    const close = result => { dialog.remove(); resolve(result) }
    const confirm = () => close(input.value.trim() || null)
    dialog.querySelector('.action-dialog__cancel').addEventListener('click', () => close(null))
    dialog.querySelector('.action-dialog__confirm').addEventListener('click', confirm)
    dialog.querySelector('.action-dialog__backdrop').addEventListener('click', () => close(null))
    input.addEventListener('keydown', event => { if (event.key === 'Enter') confirm(); if (event.key === 'Escape') close(null) })
    window.document.body.append(dialog); input.focus(); input.select()
  })
}

async function loadTypes() {
  state.types = await api('/v1/document-types')
  const options = state.types.map(type => `<option value="${escapeHtml(type.typeCode)}">${escapeHtml(type.displayName)}</option>`).join('')
  $('#upload-type').innerHTML = options || '<option value="">暂无资料类型</option>'
  $('#type-parent').innerHTML = '<option value="">作为一级分类</option>' + state.types.map(type => `<option value="${escapeHtml(type.typeCode)}">${escapeHtml(categoryOptionLabel(type))}</option>`).join('')
  $('#record-type-filter').innerHTML = '<option value="">全部资料</option>' + state.types.map(type => `<option value="${escapeHtml(type.typeCode)}">${escapeHtml(categoryOptionLabel(type))}</option>`).join('')
  if (state.activeType && !state.types.some(type => type.typeCode === state.activeType)) state.activeType = ''
  if (!state.activeType) { const root = childTypes('')[0]?.typeCode || state.types[0]?.typeCode || ''; const children = childTypes(root); state.activeType = children.length ? children[0].typeCode : root }
  renderCategoryBlocks()
  renderTypeList()
  setMessage('#service-status', '资料服务已就绪')
}
function renderTypeList() {
  const list = $('#type-list')
  list.innerHTML = state.types.length ? state.types.map(type => `<div class="manage-row"><span>${escapeHtml(categoryOptionLabel(type))} <small>${escapeHtml(type.typeCode)}</small></span><div class="record-actions"><button class="edit-type" type="button" data-type="${escapeHtml(type.typeCode)}">编辑</button><button class="danger delete-type" type="button" data-type="${escapeHtml(type.typeCode)}">停用</button></div></div>`).join('') : '<p class="hint">暂无可用分类。</p>'
  list.querySelectorAll('.edit-type').forEach(button => button.addEventListener('click', () => renameType(button.dataset.type)))
  list.querySelectorAll('.delete-type').forEach(button => button.addEventListener('click', () => deactivateType(button.dataset.type)))
}
async function renameType(typeCode) {
  const type = state.types.find(item => item.typeCode === typeCode)
  const displayName = await promptAction({ title: `编辑分类“${typeCode}”`, message: '显示名称（编码不可修改）：', value: type?.displayName || '', confirmLabel: '保存' })
  if (!displayName) return
  try { const result = await api(`/v1/document-types/${encodeURIComponent(typeCode)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName }) }); setMessage('#type-state', `已更新为“${result.displayName}”。`); await loadTypes() } catch (error) { setMessage('#type-state', `编辑失败：${error.message}`, true) }
}
async function deactivateType(typeCode) {
  const type = state.types.find(item => item.typeCode === typeCode)
  if (!await confirmAction({ title: '停用资料分类？', message: `“${type?.displayName || typeCode}”停用后，新资料将不能再选择该分类；已有资料不会被删除。`, confirmLabel: '确认停用' })) return
  try { await api(`/v1/document-types/${encodeURIComponent(typeCode)}`, { method: 'DELETE' }); setMessage('#type-state', '分类已停用。'); await loadTypes() } catch (error) { setMessage('#type-state', error.message === 'TYPE_HAS_ACTIVE_CHILDREN' ? '停用失败：请先停用或调整该分类下的子分类。' : `停用失败：${error.message}`, true) }
}
async function loadManageableDocuments() {
  const select = $('#existing-document')
  try {
    state.manageable = await api('/v1/documents/manage')
    select.innerHTML = '<option value="">不选择资料（系统将新建资料）</option>' + state.manageable.filter(document => document.status !== 'archived').map(document => `<option value="${escapeHtml(document.documentId)}">${escapeHtml(document.title)}（当前 ${escapeHtml(document.versionLabel)}）</option>`).join('')
    renderManagementRecords()
    syncUploadMode()
  } catch (error) {
    state.manageable = []
    select.innerHTML = '<option value="">暂时无法读取可更新资料</option>'
    syncUploadMode()
    $('#management-records').innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`
  }
}
function renderManagementRecords() {
  const list = $('#management-records')
  const filter = $('#record-type-filter')?.value || ''
  const visible = state.manageable.filter(document => !filter || document.documentType === filter)
  list.innerHTML = visible.length ? visible.map(document => `<article class="manage-row record ${document.status === 'archived' ? 'archived-record' : ''}"><div><b>${escapeHtml(document.title)}</b><p class="hint ${document.status === 'archived' ? 'record-status' : ''}">${escapeHtml(typeLabel(document.documentType))} · ${escapeHtml(document.versionLabel)} · ${document.status === 'archived' ? '已归档（不可下载）' : escapeHtml(document.status)} · 更新于 ${formatDate(document.updatedAt)}</p></div><div class="record-actions">${document.status === 'draft' ? `<button class="publish-document" data-document-id="${escapeHtml(document.documentId)}" type="button">发布到下载</button>` : ''}${document.status === 'archived' ? `<button class="restore-document" data-document-id="${escapeHtml(document.documentId)}" type="button">重新启用</button>` : `<button class="update-document" data-document-id="${escapeHtml(document.documentId)}" type="button">更新版本</button><button class="archive-document" data-document-id="${escapeHtml(document.documentId)}" type="button">归档</button>`}</div></article>`).join('') : (state.manageable.length ? '<p class="hint">该分类下暂无资料记录。</p>' : '<p class="hint">暂无资料记录。</p>')
  list.querySelectorAll('.publish-document').forEach(button => button.addEventListener('click', () => publishDocument(button.dataset.documentId)))
  list.querySelectorAll('.update-document').forEach(button => button.addEventListener('click', () => { $('#existing-document').value = button.dataset.documentId; syncUploadMode(); $('#upload-form').scrollIntoView({ block: 'start', behavior: 'smooth' }); $('#upload-form').querySelector('input[type="file"]').focus() }))
  list.querySelectorAll('.archive-document').forEach(button => button.addEventListener('click', () => archiveDocument(button.dataset.documentId)))
  list.querySelectorAll('.restore-document').forEach(button => button.addEventListener('click', () => restoreDocument(button.dataset.documentId)))
}
async function archiveDocument(documentId) {
  const document = state.manageable.find(item => item.documentId === documentId)
  if (!await confirmAction({ title: '归档这份资料？', message: `“${document?.title || documentId}”将从资料下载中隐藏，但保留版本与审计记录，并可随时重新启用。`, confirmLabel: '确认归档' })) return
  try { await api(`/v1/documents/${encodeURIComponent(documentId)}/retire`, { method: 'POST' }); await loadManageableDocuments(); await loadDownloads(); setMessage('#upload-state', '资料已归档，并已从下载列表移除；可在资料记录中重新启用。') } catch (error) { setMessage('#upload-state', `归档失败：${error.message}`, true) }
}
async function restoreDocument(documentId) {
  const document = state.manageable.find(item => item.documentId === documentId)
  if (!await confirmAction({ title: '重新启用这份资料？', message: `“${document?.title || documentId}”会恢复到资料下载与检索中。`, confirmLabel: '确认重新启用' })) return
  try { await api(`/v1/documents/${encodeURIComponent(documentId)}/restore`, { method: 'POST' }); await loadManageableDocuments(); await loadDownloads(); setMessage('#upload-state', '资料已重新启用，并恢复到资料下载与检索中。') } catch (error) { setMessage('#upload-state', `重新启用失败：${error.message}`, true) }
}
async function publishDocument(documentId) {
  const document = state.manageable.find(item => item.documentId === documentId)
  if (!await confirmAction({ title: '发布到资料下载？', message: `“${document?.title || documentId}”将对拥有资料库访问权限的用户开放下载。`, confirmLabel: '确认发布' })) return
  try { await api(`/v1/documents/${encodeURIComponent(documentId)}/publish`, { method: 'POST' }); setMessage('#upload-state', '资料已发布，现在可以在“资料下载”中下载。'); await loadManageableDocuments(); await loadDownloads() } catch (error) { setMessage('#upload-state', `发布失败：${error.message}`, true) }
}
function syncUploadMode() {
  const document = state.manageable.find(item => item.documentId === $('#existing-document').value)
  const updating = Boolean(document)
  const mode = $('#upload-mode')
  const submit = $('#upload-submit')
  $('#upload-title').disabled = updating
  $('#upload-type').disabled = updating
  if (updating) {
    $('#upload-title').value = document.title
    $('#upload-type').value = document.documentType
    mode.textContent = `本次操作：更新版本 · ${document.title} 将从 ${document.versionLabel} 更新为下一版本。`
    submit.textContent = '更新版本并上传'
    setMessage('#upload-state', '')
  } else {
    $('#upload-title').value = ''
    mode.textContent = '本次操作：新建资料 · 将创建第 1 个版本。'
    submit.textContent = '新建资料并上传'
    setMessage('#upload-state', '')
  }
}
// 左侧分类树：一级分类可展开子分类，点击直接选中并在右侧显示文件，无页面跳转感。
// 组织架构式分类小方块：一级方块在上，二级方块缩进排在下方，始终可见、点击选中。
function renderCategoryBlocks() {
  const container = $('#category-blocks')
  if (!container) return
  const roots = childTypes('')
  if (!roots.length) { container.innerHTML = '<p class="hint">暂无可用资料分类。</p>'; return }
  const renderBlock = (type, level) => {
    const count = countFilesForType(type.typeCode)
    const isActive = type.typeCode === state.activeType
    return `<button type="button" class="category-block level-${level} ${isActive ? 'active' : ''}" data-type="${escapeHtml(type.typeCode)}" data-level="${level}"><span class="category-block-name">${escapeHtml(type.displayName)}</span><span class="category-block-count">${count} 份</span></button>`
  }
  container.innerHTML = roots.map(root => {
    const children = childTypes(root.typeCode)
    return `<div class="category-block-group">${renderBlock(root, 0)}${children.length ? `<div class="category-block-children">${children.map(child => renderBlock(child, 1)).join('')}</div>` : ''}</div>`
  }).join('')
  container.querySelectorAll('.category-block').forEach(block => block.addEventListener('click', () => {
    state.activeType = block.dataset.type
    state.activeDocumentId = ''
    renderCategoryBlocks()
    renderDownloads()
  }))
}
// 下载页：一次拉取全部已发布资料，分类切换与文件选择都在前端完成，避免重复请求。
async function loadDownloads() {
  try { state.allDownloads = await api('/v1/documents') } catch (error) { const list = $('#download-list'); list.innerHTML = `<article class="empty"><h3>无法读取资料</h3><p>${escapeHtml(error.message)}</p></article>`; return }
  renderCategoryBlocks()
  renderDownloads()
}
function renderDownloads() {
  const list = $('#download-list')
  if (!state.activeType) { list.innerHTML = '<article class="empty"><h3>请选择资料分类</h3><p>选择分类后即可查看该类文件，再点击具体文件展开下载与讨论。</p></article>'; return }
  state.downloads = state.allDownloads.filter(document => document.documentType === state.activeType)
  if (!state.downloads.length) { list.innerHTML = '<article class="empty"><h3>这里还没有已发布资料</h3><p>上传并完成审核发布后，会按分类显示在这里。</p></article>'; return }
  const trail = categoryTrail(state.activeType)
  const heading = trail.length ? trail.map(type => type.displayName).join(' / ') : typeLabel(state.activeType)
  list.innerHTML = `<section class="download-split"><div class="download-file-list"><div class="download-category__head"><div><p class="meta">当前分类文件</p><h3>${escapeHtml(heading)}</h3></div><span>${state.downloads.length} 份</span></div><div class="download-file-options">${state.downloads.map(document => `<button class="download-file-option ${document.documentId === state.activeDocumentId ? 'active' : ''}" type="button" data-document-id="${escapeHtml(document.documentId)}"><span>文件</span><strong>${escapeHtml(document.title)}</strong><small>${escapeHtml(document.originalFilename)}${document.byteSize ? ` · ${formatBytes(document.byteSize)}` : ''}</small></button>`).join('')}</div></div><div class="download-file-detail"></div></section>`
  list.querySelectorAll('.download-file-option').forEach(button => button.addEventListener('click', () => {
    state.activeDocumentId = button.dataset.documentId
    list.querySelectorAll('.download-file-option').forEach(node => node.classList.toggle('active', node === button))
    const holder = list.querySelector('.download-file-detail')
    if (holder) { holder.replaceChildren(); const selected = state.downloads.find(document => document.documentId === state.activeDocumentId); if (selected) holder.append(renderDocument(selected)) }
  }))
  const selected = state.downloads.find(document => document.documentId === state.activeDocumentId)
  const holder = list.querySelector('.download-file-detail')
  if (holder && selected) holder.append(renderDocument(selected))
}
function renderDocument(record) {
  const card = window.document.createElement('article'); card.className = 'file-card'; card.dataset.documentId = record.documentId
  const sizeText = record.byteSize ? ` · ${formatBytes(record.byteSize)}` : ''
  card.innerHTML = `<div class="file-head"><div><p class="meta">${escapeHtml(record.documentTypeName || typeLabel(record.documentType))}</p><h3>${escapeHtml(record.title)}</h3><p class="hint">${escapeHtml(record.originalFilename)}${sizeText} · 当前 ${escapeHtml(record.versionLabel)} · 更新于 ${formatDate(record.updatedAt)}</p><p class="storage-path" title="资料逻辑路径（不含存储凭据）">${escapeHtml(logicalPath(record))}</p></div><div class="file-actions"><button class="preview btn-secondary" type="button">预览文件</button><button class="download" type="button">下载文件</button></div></div><div class="public-note">所有拥有资料库访问权限的用户均可查看评价、建议和评论附件。</div><details class="comment-box"><summary>评价与建议（所有可访问用户可见）</summary><div class="comment-list"><p class="hint">展开后加载全部评论。</p></div><form class="comment-form"><select name="kind"><option value="comment">评价</option><option value="suggestion">建议</option></select><textarea name="content" maxlength="2000" placeholder="输入 @姓名 或 @账号 提及相关人；评论将对所有可访问用户展示" required></textarea><label class="comment-attachment">附件（可选，图片 / PDF / Office，最大 10 MB）<input name="attachment" type="file" accept=".pdf,.docx,.xlsx,.pptx,.txt,.md,.jpg,.jpeg,.png,.webp"/></label><button>公开提交</button><p class="comment-state" role="status"></p></form></details>`
  card.querySelector('.download').addEventListener('click', () => downloadDocument(record.documentId))
  card.querySelector('.preview').addEventListener('click', () => previewDocument(record.documentId))
  card.querySelector('details').addEventListener('toggle', event => { if (event.target.open) { loadComments(card, record.documentId).then(() => revealExpandedContent(event.target)); revealExpandedContent(event.target) } })
  card.querySelector('.comment-form').addEventListener('submit', event => submitComment(event, card, record.documentId))
  return card
}
async function downloadDocument(documentId) { try { const data = await api(`/v1/documents/${encodeURIComponent(documentId)}/download`, { headers: { accept: 'application/json' } }); window.location.assign(data.url) } catch (error) { await confirmAction({ title: '下载失败', message: error.message, confirmLabel: '知道了', danger: false }) } }
async function previewDocument(documentId) {
  try {
    const preview = await api(`/v1/documents/${encodeURIComponent(documentId)}/preview`)
    if (!preview.previewable) { await confirmAction({ title: '暂不支持在线预览', message: preview.reason || '请下载文件后在本地查看。', confirmLabel: '知道了', danger: false }); return }
    const dialog = window.document.createElement('dialog')
    dialog.className = 'preview-dialog'
    dialog.innerHTML = `<section class="preview-dialog__panel"><header><div><h3>预览文件</h3><p>${escapeHtml(preview.originalFilename || '资料文件')}</p></div><button type="button" class="preview-dialog__close" aria-label="关闭预览">关闭</button></header><iframe title="${escapeHtml(preview.originalFilename || '资料预览')}" referrerpolicy="no-referrer"></iframe></section>`
    dialog.querySelector('iframe').src = `${API_PATHS[0]}/v1/documents/${encodeURIComponent(documentId)}/preview?inline=1`
    const close = () => { dialog.close(); dialog.remove() }
    dialog.querySelector('.preview-dialog__close').addEventListener('click', close)
    dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
    window.document.body.append(dialog); dialog.showModal()
  } catch (error) { await confirmAction({ title: '无法预览文件', message: `请下载后在本地查看。${error.message ? `（${error.message}）` : ''}`, confirmLabel: '知道了', danger: false }) }
}
function commentMarkup(comment, reply = false) { return `<article class="comment${reply ? ' comment-reply' : ''}"><div class="comment-meta"><div><b>${escapeHtml(comment.authorName || comment.createdBy || '资料库用户')}</b><span class="comment-kind">${comment.commentKind === 'suggestion' ? '建议' : reply ? '回复' : '评价'}</span></div><time datetime="${escapeHtml(comment.createdAt)}">${formatDate(comment.createdAt)}</time></div><p class="comment-content">${renderMentions(comment.content)}</p>${comment.mentions?.length ? `<small>提及 ${comment.mentions.map(mention => `@${escapeHtml(mention)}`).join('、')}</small>` : ''}${comment.attachments?.length ? `<div class="attachment-list">${comment.attachments.map(item => `<button class="attachment-download" type="button" data-attachment-id="${escapeHtml(item.attachmentId)}">附件：${escapeHtml(item.originalFilename)}</button>`).join('')}</div>` : ''}${reply ? '' : `<button class="reply-toggle btn-secondary" type="button" data-comment-id="${escapeHtml(comment.commentId)}">回复</button><form class="reply-form" hidden><label>回复 ${escapeHtml(comment.authorName || comment.createdBy || '这条评论')}<textarea maxlength="2000" placeholder="输入公开回复；所有可访问用户均可见" required></textarea></label><button type="submit">发布回复</button><p class="comment-state" role="status"></p></form>`}</article>` }
async function loadComments(card, documentId) { const list = card.querySelector('.comment-list'); try { const comments = await api(`/v1/documents/${encodeURIComponent(documentId)}/comments`); const roots = comments.filter(comment => !comment.parentCommentId); list.innerHTML = roots.length ? `<p class="comment-count">${roots.length} 条讨论 · 所有内容公开可见</p>${roots.map(comment => { const replies = comments.filter(reply => reply.parentCommentId === comment.commentId); return `<section class="comment-thread">${commentMarkup(comment)}${replies.length ? `<div class="comment-replies"><p>${replies.length} 条回复</p>${replies.map(reply => commentMarkup(reply, true)).join('')}</div>` : ''}</section>` }).join('')}` : '<p class="hint">暂时没有评价或建议。发布后会对所有可访问用户展示。</p>'; list.querySelectorAll('.attachment-download').forEach(button => button.addEventListener('click', () => downloadCommentAttachment(button.dataset.attachmentId))); list.querySelectorAll('.reply-toggle').forEach(button => button.addEventListener('click', () => { const form = button.parentElement.querySelector('.reply-form'); const opening = form.hidden; form.hidden = !opening; button.setAttribute('aria-expanded', String(opening)); button.textContent = opening ? '收起回复' : '回复'; if (opening) { form.querySelector('textarea').focus(); revealExpandedContent(form) } })); list.querySelectorAll('.reply-form').forEach(form => form.addEventListener('submit', event => submitReply(event, card, documentId, event.currentTarget.parentElement.querySelector('.reply-toggle').dataset.commentId))); revealExpandedContent(list) } catch (error) { list.innerHTML = `<p class="error">评论加载失败：${escapeHtml(error.message)}</p>` } }
async function downloadCommentAttachment(attachmentId) { try { const data = await api(`/v1/comment-attachments/${encodeURIComponent(attachmentId)}/download`); window.location.assign(data.url) } catch (error) { await confirmAction({ title: '附件下载失败', message: error.message, confirmLabel: '知道了', danger: false }) } }
async function submitComment(event, card, documentId) { event.preventDefault(); const form = event.currentTarget; const output = form.querySelector('.comment-state'); const file = form.attachment.files[0]; try { if (file) { const payload = new FormData(); payload.append('metadata', JSON.stringify({ kind: form.kind.value, content: form.content.value.trim() })); payload.append('file', file); await api(`/v1/documents/${encodeURIComponent(documentId)}/comments/attachment`, { method: 'POST', body: payload }) } else await api(`/v1/documents/${encodeURIComponent(documentId)}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: form.kind.value, content: form.content.value.trim() }) }); form.reset(); output.textContent = '已公开提交，所有可访问用户均可查看。'; output.classList.remove('error'); await loadComments(card, documentId) } catch (error) { output.textContent = `提交失败：${error.message}`; output.classList.add('error') } }
async function submitReply(event, card, documentId, parentCommentId) { event.preventDefault(); const form = event.currentTarget; const output = form.querySelector('.comment-state'); try { await api(`/v1/documents/${encodeURIComponent(documentId)}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'comment', content: form.querySelector('textarea').value.trim(), parentCommentId }) }); await loadComments(card, documentId) } catch (error) { output.textContent = `回复失败：${error.message}`; output.classList.add('error') } }

document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => { const page = ({ manage: ['资料管理', '上传、更新、发布与归档资料；所有变更保留版本记录。'], downloads: ['资料下载', '搜索、筛选并下载已发布的企业资料。'] })[button.dataset.panel]; document.querySelectorAll('.nav').forEach(node => node.classList.toggle('active', node === button)); document.querySelectorAll('.panel').forEach(node => node.classList.toggle('active', node.id === button.dataset.panel)); $('#page-title').textContent = page[0]; $('#page-description').textContent = page[1]; if (button.dataset.panel === 'downloads') loadDownloads(); if (button.dataset.panel === 'manage') loadManageableDocuments() }))
$('#existing-document').addEventListener('change', syncUploadMode)
$('#refresh-records').addEventListener('click', loadManageableDocuments)
$('#record-type-filter').addEventListener('change', renderManagementRecords)
$('#upload-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const existingDocumentId = $('#existing-document').value; const updating = Boolean(state.manageable.find(item => item.documentId === existingDocumentId)); const payload = new FormData(); payload.append('metadata', JSON.stringify({ title: data.get('title'), documentType: data.get('documentType'), language: 'zh-CN', securityLevel: 'internal', aiAllowed: true })); payload.append('file', data.get('file')); setMessage('#upload-state', updating ? '正在按“更新版本”处理并创建解析任务…' : '正在按“新建资料”处理并创建解析任务…'); try { const result = await api(updating ? `/v1/documents/${encodeURIComponent(existingDocumentId)}/versions` : '/v1/documents', { method: 'POST', body: payload }); setMessage('#upload-state', updating ? `本次已记录为：更新版本（${result.versionLabel}）。系统正在解析，完成后重新发布即可更新下载中心。` : `本次已记录为：新建资料（${result.documentId}）。系统正在解析，完成后可进入发布流程。`); form.reset(); await loadManageableDocuments(); syncUploadMode() } catch (error) { setMessage('#upload-state', `${updating ? '更新版本' : '新建资料'}失败：${error.message}`, true) } })
$('#type-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const displayName = form.displayName.value.trim(); const enteredCode = form.typeCode.value.trim(); const typeCode = /^[A-Za-z0-9_-]{2,64}$/.test(enteredCode) ? enteredCode.toUpperCase() : ''; const parentTypeCode = form.parentTypeCode.value || null; try { const result = await api('/v1/document-types', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ typeCode, displayName, parentTypeCode }) }); setMessage('#type-state', `已新增“${result.displayName}”（系统编码：${result.typeCode}）。`); form.reset(); await loadTypes() } catch (error) { setMessage('#type-state', error.message === 'PARENT_TYPE_NOT_FOUND' ? '新增失败：上级分类不存在或已停用。' : `新增失败：${error.message === 'VALIDATION_ERROR' ? '请填写类型名称。' : error.message}`, true) } })
$('#search-form').addEventListener('submit', async event => { event.preventDefault(); const query = $('#search-query').value.trim(); const terms = queryTerms(query); const box = $('#search-state'); const results = $('#search-results'); box.hidden = false; box.textContent = '正在检索资料…'; results.hidden = true; try { const data = await api(`/v1/search?q=${encodeURIComponent(query)}&answer=0`); results.innerHTML = data.results.length ? `<p class="search-mode">${data.mode === 'semantic' ? '语义检索结果' : '关键词检索结果'} · 找到 ${data.results.length} 份相关资料</p><div class="ai-answer" data-ai-answer><b>资料整理</b><p>正在基于命中资料生成摘要，不影响下方文件下载。</p></div><div class="search-file-grid">${data.results.map(item => `<article class="search-file"><span class="file-icon" aria-hidden="true">▤</span><div><p class="meta">${escapeHtml(typeLabel(item.documentType) || '资料下载')}</p><h3>${highlight(item.title || item.originalFilename || '相关资料', terms)}</h3><p class="hint">${escapeHtml(item.originalFilename || '点击预览或下载原文件')}</p>${item.snippet ? `<p class="search-snippet">${highlight(item.snippet, terms)}</p>` : ''}<p class="storage-path">${escapeHtml(logicalPath(item))}</p></div><div class="search-file-actions"><button class="search-preview btn-secondary" type="button" data-document-id="${escapeHtml(item.documentId)}">预览</button><button class="search-download file-download" type="button" aria-label="下载 ${escapeHtml(item.title || item.originalFilename || '资料')}" data-document-id="${escapeHtml(item.documentId)}" title="快速下载">下载</button></div></article>`).join('')}</div>` : '<article class="empty"><h3>未找到匹配资料</h3><p>请换一个资料标题、型号、参数或正文中的关键词。</p></article>'; results.querySelectorAll('.search-preview').forEach(button => button.addEventListener('click', () => previewDocument(button.dataset.documentId))); results.querySelectorAll('.search-download').forEach(button => button.addEventListener('click', () => downloadDocument(button.dataset.documentId))); box.hidden = true; results.hidden = false; if (data.results.length) { api(`/v1/search/answer?q=${encodeURIComponent(query)}`).then(extra => { const holder = results.querySelector('[data-ai-answer]'); if (!holder) return; const answerText = typeof extra.answer?.answer === 'string' ? extra.answer.answer : extra.answer?.answer?.answer; holder.innerHTML = answerText ? `<b>资料整理</b><p>${escapeHtml(answerText)}</p><small>基于已发布资料片段生成；请以原始资料为准。</small>` : '<b>资料整理</b><p>暂时无法生成摘要，请直接下载相关文件查看。</p>' }).catch(() => { const holder = results.querySelector('[data-ai-answer]'); if (holder) holder.hidden = true }) } } catch (error) { box.textContent = `暂时无法搜索：${error.message}` } })

// 分类目录以平台鉴权后的 API 为唯一来源。每次新增、编辑或停用分类后
// 都会调用 loadTypes()，因此不需要把分类写死在页面中。
loadTypes().then(loadDownloads).catch(error => setMessage('#service-status', `无法加载资料类型：${error.message}`, true))
if (EMBEDDED && 'ResizeObserver' in window) new ResizeObserver(syncEmbeddedHeight).observe(document.body)
window.addEventListener('load', syncEmbeddedHeight)
