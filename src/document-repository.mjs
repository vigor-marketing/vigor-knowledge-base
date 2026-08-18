import mysql from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { chunkExtractedText } from './chunker.mjs'

const escapeLike = value => String(value || '').replace(/[\\%_]/g, '\\$&')

// 从命中内容中截取命中词附近约 100 字的片段，供搜索摘要展示（不返回全文）。
export function buildSnippet(content, terms) {
  const text = String(content || '')
  if (!text) return ''
  let bestIndex = -1
  for (const term of terms) {
    const index = text.indexOf(term)
    if (index >= 0 && (bestIndex === -1 || index < bestIndex)) bestIndex = index
  }
  if (bestIndex === -1) return text.slice(0, 100)
  const start = Math.max(bestIndex - 30, 0)
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 100)}${start + 100 < text.length ? '…' : ''}`
}

export class DocumentRepository {
  constructor(mysqlUrl, pool = mysql.createPool(mysqlUrl)) {
    this.pool = pool
  }

  async createDraft({ documentId, metadata, uploaded, originalFilename, mimeType, actorId }) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute(
        `INSERT INTO knowledge_documents
          (document_id, title, document_type, language, department_id, product_id, security_level, ai_allowed, status, current_version_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        [documentId, metadata.title, metadata.documentType, metadata.language, metadata.departmentId || null, metadata.productId || null, metadata.securityLevel, metadata.aiAllowed, uploaded.versionId, actorId],
      )
      await connection.execute(
        `INSERT INTO knowledge_document_versions
          (version_id, document_id, version_label, object_key, content_hash, original_filename, mime_type, byte_size, created_by)
         VALUES (?, ?, 'v1', ?, ?, ?, ?, ?, ?)`,
        [uploaded.versionId, documentId, uploaded.objectKey, uploaded.contentHash, originalFilename, mimeType, uploaded.byteSize, actorId],
      )
      const jobId = `kjob_${randomUUID()}`
      await connection.execute('INSERT INTO knowledge_ingestion_jobs (job_id, version_id) VALUES (?, ?)', [jobId, uploaded.versionId])
      await connection.commit()
      return { documentId, versionId: uploaded.versionId, jobId, status: 'draft', parsingStatus: 'pending' }
    } catch (error) {
      await connection.rollback()
      // content_hash 唯一约束兜底（并发上传同一文件时的竞态），转成可识别错误。
      if (error.code === 'ER_DUP_ENTRY') throw new Error('DUPLICATE_FILE')
      throw error
    } finally {
      connection.release()
    }
  }

  async createVersion({ documentId, uploaded, originalFilename, mimeType, actorId }) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [documents] = await connection.execute('SELECT document_id AS documentId FROM knowledge_documents WHERE document_id = ? FOR UPDATE', [documentId])
      if (!documents[0]) throw new Error('DOCUMENT_NOT_FOUND')
      const [counts] = await connection.execute('SELECT COUNT(*) AS versionCount FROM knowledge_document_versions WHERE document_id = ?', [documentId])
      const versionLabel = `v${Number(counts[0].versionCount) + 1}`
      await connection.execute(
        `INSERT INTO knowledge_document_versions
          (version_id, document_id, version_label, object_key, content_hash, original_filename, mime_type, byte_size, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uploaded.versionId, documentId, versionLabel, uploaded.objectKey, uploaded.contentHash, originalFilename, mimeType, uploaded.byteSize, actorId],
      )
      await connection.execute("UPDATE knowledge_documents SET current_version_id = ?, status = 'draft' WHERE document_id = ?", [uploaded.versionId, documentId])
      const jobId = `kjob_${randomUUID()}`
      await connection.execute('INSERT INTO knowledge_ingestion_jobs (job_id, version_id) VALUES (?, ?)', [jobId, uploaded.versionId])
      await connection.commit()
      return { documentId, versionId: uploaded.versionId, versionLabel, jobId, status: 'draft', parsingStatus: 'pending' }
    } catch (error) {
      await connection.rollback()
      // content_hash 唯一约束兜底（并发上传同一文件时的竞态），转成可识别错误。
      if (error.code === 'ER_DUP_ENTRY') throw new Error('DUPLICATE_FILE')
      throw error
    } finally {
      connection.release()
    }
  }

  async findVersionByHash(contentHash) {
    const [rows] = await this.pool.execute(
      `SELECT version.document_id AS documentId, version.version_id AS versionId, document.title AS title, document.status AS status
       FROM knowledge_document_versions version
       JOIN knowledge_documents document ON document.document_id = version.document_id
       WHERE version.content_hash = ?
       LIMIT 1`,
      [contentHash],
    )
    return rows[0]
  }

  async getSourceForJob(jobId) {
    const [rows] = await this.pool.execute(
      `SELECT job.version_id AS versionId, version.object_key AS objectKey, version.mime_type AS mimeType
       FROM knowledge_ingestion_jobs job
       JOIN knowledge_document_versions version ON version.version_id = job.version_id
       WHERE job.job_id = ?`,
      [jobId],
    )
    return rows[0]
  }

  async getDownloadableDocument(documentId) {
    const [rows] = await this.pool.execute(
      `SELECT version.object_key AS objectKey, version.original_filename AS originalFilename,
              version.mime_type AS mimeType, version.byte_size AS byteSize,
              document.security_level AS securityLevel
       FROM knowledge_documents document
       JOIN knowledge_document_versions version ON version.version_id = document.current_version_id
       WHERE document.document_id = ? AND document.status = 'active'`,
      [documentId],
    )
    return rows[0]
  }

  async markJobProcessing(jobId) {
    await this.pool.execute("UPDATE knowledge_ingestion_jobs SET status = 'processing', attempt_count = attempt_count + 1 WHERE job_id = ?", [jobId])
  }

  async markJobFailed(jobId, error) {
    await this.pool.execute(
      "UPDATE knowledge_ingestion_jobs SET status = 'failed', error_code = ?, error_message = ? WHERE job_id = ?",
      ['PARSER_FAILED', String(error.message || error).slice(0, 1024), jobId],
    )
  }

  async saveExtraction({ jobId, versionId, parsed }) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute(
        `INSERT INTO knowledge_document_extractions
          (version_id, extracted_text, parser_status, parser_reason, char_count, replacement_character_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE extracted_text = VALUES(extracted_text), parser_status = VALUES(parser_status), parser_reason = VALUES(parser_reason), char_count = VALUES(char_count), replacement_character_count = VALUES(replacement_character_count)`,
        [versionId, parsed.text, parsed.status, parsed.reason, parsed.quality.charCount, parsed.quality.replacementCharacterCount],
      )
      await connection.execute('UPDATE knowledge_document_versions SET parsing_status = ? WHERE version_id = ?', [parsed.status === 'completed' ? 'completed' : 'review', versionId])
      if (parsed.status === 'completed') {
        await connection.execute('DELETE FROM knowledge_document_chunks WHERE version_id = ?', [versionId])
        for (const chunk of chunkExtractedText(parsed.text)) {
          await connection.execute(
            'INSERT INTO knowledge_document_chunks (chunk_id, version_id, ordinal, heading_path, content) VALUES (?, ?, ?, ?, ?)',
            [`kchunk_${randomUUID()}`, versionId, chunk.ordinal, chunk.headingPath, chunk.content],
          )
        }
      }
      await connection.execute("UPDATE knowledge_ingestion_jobs SET status = 'completed', error_code = NULL, error_message = NULL WHERE job_id = ?", [jobId])
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async getIndexableChunks(versionId) {
    const [rows] = await this.pool.execute(
      `SELECT chunk.chunk_id AS chunkId, document.document_id AS documentId, chunk.version_id AS versionId,
              chunk.content AS content, chunk.heading_path AS headingPath, document.title AS title,
              version.original_filename AS originalFilename, document.document_type AS documentType,
              document.department_id AS departmentId, document.product_id AS productId,
              document.security_level AS securityLevel, document.status AS status,
              document.ai_allowed AS aiAllowed, version.permission_version AS permissionVersion
       FROM knowledge_document_chunks chunk
       JOIN knowledge_document_versions version ON version.version_id = chunk.version_id
       JOIN knowledge_documents document ON document.document_id = version.document_id
       WHERE chunk.version_id = ? AND document.status IN ('approved', 'active') AND document.ai_allowed = TRUE`,
      [versionId],
    )
    return rows
  }

  async markChunksIndexed(versionId) {
    await this.pool.execute("UPDATE knowledge_document_versions SET parsing_status = 'completed' WHERE version_id = ?", [versionId])
  }

  async publishDocument(documentId) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.execute(
        `SELECT document.current_version_id AS versionId, version.parsing_status AS parsingStatus
         FROM knowledge_documents document
         JOIN knowledge_document_versions version ON version.version_id = document.current_version_id
         WHERE document.document_id = ? FOR UPDATE`,
        [documentId],
      )
      const document = rows[0]
      if (!document) throw new Error('DOCUMENT_NOT_FOUND')
      if (document.parsingStatus !== 'completed') throw new Error('DOCUMENT_NOT_READY')
      await connection.execute("UPDATE knowledge_documents SET status = 'active' WHERE document_id = ?", [documentId])
      await connection.commit()
      return { documentId, versionId: document.versionId }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async retireDocument(documentId) {
    const [result] = await this.pool.execute("UPDATE knowledge_documents SET status = 'archived' WHERE document_id = ?", [documentId])
    if (!result.affectedRows) throw new Error('DOCUMENT_NOT_FOUND')
  }

  async restoreDocument(documentId) {
    const [result] = await this.pool.execute("UPDATE knowledge_documents SET status = 'active' WHERE document_id = ? AND status = 'archived'", [documentId])
    if (!result.affectedRows) throw new Error('ARCHIVED_DOCUMENT_NOT_FOUND')
    return { documentId }
  }

  async listDocumentTypes() {
    const [rows] = await this.pool.execute('SELECT type_code AS typeCode, display_name AS displayName, parent_type_code AS parentTypeCode FROM knowledge_document_types WHERE is_active = TRUE ORDER BY sort_order, display_name')
    return rows
  }

  async createDocumentType({ typeCode, displayName, parentTypeCode = null }) {
    if (parentTypeCode) {
      const [parents] = await this.pool.execute('SELECT type_code FROM knowledge_document_types WHERE type_code = ? AND is_active = TRUE', [parentTypeCode])
      if (!parents.length) throw new Error('PARENT_TYPE_NOT_FOUND')
    }
    await this.pool.execute('INSERT INTO knowledge_document_types (type_code, display_name, parent_type_code, sort_order) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM (SELECT sort_order FROM knowledge_document_types) AS types))', [typeCode, displayName, parentTypeCode])
    return { typeCode, displayName, parentTypeCode }
  }

  async deactivateDocumentType(typeCode) {
    const [children] = await this.pool.execute('SELECT type_code FROM knowledge_document_types WHERE parent_type_code = ? AND is_active = TRUE LIMIT 1', [typeCode])
    if (children.length) throw new Error('TYPE_HAS_ACTIVE_CHILDREN')
    const [result] = await this.pool.execute('UPDATE knowledge_document_types SET is_active = FALSE WHERE type_code = ? AND is_active = TRUE', [typeCode])
    if (!result.affectedRows) throw new Error('TYPE_NOT_FOUND')
  }

  async renameDocumentType({ typeCode, displayName }) {
    const [result] = await this.pool.execute('UPDATE knowledge_document_types SET display_name = ? WHERE type_code = ? AND is_active = TRUE', [displayName, typeCode])
    if (!result.affectedRows) throw new Error('TYPE_NOT_FOUND')
    return { typeCode, displayName }
  }

  async listDownloadDocuments(typeCode, securityLevels = ['public', 'internal', 'confidential', 'restricted']) {
    const params = []
    let where = "WHERE document.status = 'active'"
    if (typeCode) { where += ' AND document.document_type = ?'; params.push(typeCode) }
    where += ` AND document.security_level IN (${securityLevels.map(() => '?').join(', ')})`
    params.push(...securityLevels)
    const [rows] = await this.pool.execute(
      `SELECT document.document_id AS documentId, document.title, document.document_type AS documentType,
              COALESCE(type.display_name, document.document_type) AS documentTypeName,
              version.version_label AS versionLabel, version.original_filename AS originalFilename,
              version.created_at AS updatedAt
       FROM knowledge_documents document
       JOIN knowledge_document_versions version ON version.version_id = document.current_version_id
       LEFT JOIN knowledge_document_types type ON type.type_code = document.document_type
       ${where} ORDER BY version.created_at DESC`, params)
    return rows
  }
  // 提取查询词并生成匹配/打分 SQL 片段。权重：标题命中 +3、内容命中 +1，多个词累加。
  searchClauses(query) {
    const raw = String(query || '').trim()
    const compact = raw.toLowerCase().replace(/[\s_\-./，。；;、！？!?：:（）()【】\[\]]/g, '')
    const latinTerms = raw.match(/[a-z0-9][a-z0-9._/-]*/gi) || []
    const chineseTerms = (raw.match(/[\u4e00-\u9fff]{2,}/g) || []).flatMap(value => [value, ...Array.from({ length: Math.max(value.length - 1, 0) }, (_, index) => value.slice(index, index + 2))])
    const terms = [...new Set([raw, compact, ...raw.split(/[\s,，。；;、！？!?的了是和与及在]/).map(term => term.trim()), ...latinTerms, ...chineseTerms].filter(term => term.length >= 2))].slice(0, 20)
    if (!terms.length) return null
    const normalizedContent = "LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(chunk.content, ' ', ''), '-', ''), '_', ''), '/', ''), '.', ''), '，', ''), '。', ''), '：', ''))"
    const normalizedTitle = "LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(document.title, ' ', ''), '-', ''), '_', ''), '/', ''), '.', ''), '，', ''), '。', ''), '：', ''))"
    const where = terms.map(() => `(chunk.content LIKE ? OR document.title LIKE ? OR ${normalizedContent} LIKE ? OR ${normalizedTitle} LIKE ?)`).join(' OR ')
    const perTerm = term => { const normalized = escapeLike(term.toLowerCase().replace(/[\s_\-./，。；;、！？!?：:（）()【】\[\]]/g, '')); const rawTerm = escapeLike(term); return [`%${rawTerm}%`, `%${rawTerm}%`, `%${normalized}%`, `%${normalized}%`] }
    const whereParams = terms.flatMap(perTerm)
    const scoreExpr = terms.map(() => `(CASE WHEN chunk.content LIKE ? THEN 1 ELSE 0 END) + (CASE WHEN document.title LIKE ? THEN 3 ELSE 0 END) + (CASE WHEN ${normalizedContent} LIKE ? THEN 1 ELSE 0 END) + (CASE WHEN ${normalizedTitle} LIKE ? THEN 3 ELSE 0 END)`).join(' + ')
    const scoreParams = terms.flatMap(perTerm)
    return { terms, where, scoreExpr, whereParams, scoreParams }
  }

  async keywordSearch(query, limit = 20, securityLevels = ['public', 'internal', 'confidential', 'restricted']) {
    const clauses = this.searchClauses(query)
    if (!clauses) return []
    const { terms, where, scoreExpr, whereParams, scoreParams } = clauses
    const securityPlaceholders = securityLevels.map(() => '?').join(', ')
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50)
    const [rows] = await this.pool.execute(
      `SELECT chunk.chunk_id AS chunkId, document.document_id AS documentId, chunk.version_id AS versionId,
              document.title, document.document_type AS documentType, version.original_filename AS originalFilename,
              chunk.heading_path AS headingPath, chunk.content, (${scoreExpr}) AS score
       FROM knowledge_document_chunks chunk
       JOIN knowledge_document_versions version ON version.version_id = chunk.version_id
       JOIN knowledge_documents document ON document.document_id = version.document_id
       WHERE document.status = 'active' AND document.security_level IN (${securityPlaceholders})
         AND version.version_id = document.current_version_id AND (${where})
       ORDER BY score DESC, document.updated_at DESC
       LIMIT ${safeLimit}`,
      [...scoreParams, ...securityLevels, ...whereParams],
    )
    const results = []
    const seen = new Set()
    for (const row of rows) {
      if (seen.has(row.documentId)) continue
      seen.add(row.documentId)
      results.push({ chunkId: row.chunkId, documentId: row.documentId, versionId: row.versionId, title: row.title, documentType: row.documentType, originalFilename: row.originalFilename, snippet: buildSnippet(row.content, terms), score: Number(row.score) })
      if (results.length >= limit) break
    }
    return results
  }

  // 供 AI 回答取证的完整片段（含正文），按相关度排序后返回。
  async keywordSearchSources(query, limit = 5, securityLevels = ['public', 'internal', 'confidential', 'restricted']) {
    const clauses = this.searchClauses(query)
    if (!clauses) return []
    const { where, scoreExpr, whereParams, scoreParams } = clauses
    const securityPlaceholders = securityLevels.map(() => '?').join(', ')
    const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 20)
    const [rows] = await this.pool.execute(
      `SELECT chunk.chunk_id AS chunkId, document.document_id AS documentId, chunk.version_id AS versionId,
              document.title, document.document_type AS documentType, version.original_filename AS originalFilename,
              chunk.heading_path AS headingPath, chunk.content, (${scoreExpr}) AS score
       FROM knowledge_document_chunks chunk
       JOIN knowledge_document_versions version ON version.version_id = chunk.version_id
       JOIN knowledge_documents document ON document.document_id = version.document_id
       WHERE document.status = 'active' AND document.security_level IN (${securityPlaceholders})
         AND version.version_id = document.current_version_id AND (${where})
       ORDER BY score DESC, document.updated_at DESC, chunk.ordinal ASC
       LIMIT ${safeLimit}`,
      [...scoreParams, ...securityLevels, ...whereParams],
    )
    return rows.filter(row => String(row.content || '').trim()).map(row => ({ ...row, score: Number(row.score) }))
  }

  async listManageableDocuments() {
    const [rows] = await this.pool.execute(
      `SELECT document.document_id AS documentId, document.title, document.document_type AS documentType, document.status,
              version.version_label AS versionLabel, version.created_at AS updatedAt
       FROM knowledge_documents document
       JOIN knowledge_document_versions version ON version.version_id = document.current_version_id
       WHERE document.status IN ('draft', 'review', 'approved', 'active', 'obsolete', 'archived')
       ORDER BY document.updated_at DESC`,
    )
    return rows
  }

  async listComments(documentId) {
    const [comments] = await this.pool.execute('SELECT comment.comment_id AS commentId, comment.parent_comment_id AS parentCommentId, comment.comment_kind AS commentKind, comment.content, comment.created_by AS createdBy, comment.author_name AS authorName, comment.created_at AS createdAt FROM knowledge_document_comments comment LEFT JOIN knowledge_document_comments parent ON parent.comment_id = comment.parent_comment_id WHERE comment.document_id = ? ORDER BY COALESCE(parent.created_at, comment.created_at) DESC, comment.parent_comment_id IS NOT NULL ASC, comment.created_at ASC', [documentId])
    if (!comments.length) return comments
    const ids = comments.map(row => row.commentId); const placeholders = ids.map(() => '?').join(',')
    const [attachments] = await this.pool.execute(`SELECT attachment_id AS attachmentId, comment_id AS commentId, original_filename AS originalFilename, mime_type AS mimeType, byte_size AS byteSize FROM knowledge_comment_attachments WHERE comment_id IN (${placeholders}) ORDER BY created_at`, ids)
    const [mentions] = await this.pool.execute(`SELECT comment_id AS commentId, mention_value AS mentionValue FROM knowledge_comment_mentions WHERE comment_id IN (${placeholders}) ORDER BY created_at`, ids)
    return comments.map(comment => ({ ...comment, attachments: attachments.filter(item => item.commentId === comment.commentId), mentions: mentions.filter(item => item.commentId === comment.commentId).map(item => item.mentionValue) }))
  }

  async createComment({ documentId, parentCommentId = null, kind, content, actorId, authorName }) {
    const commentId = `kcom_${randomUUID()}`
    if (parentCommentId) {
      const [parents] = await this.pool.execute('SELECT comment_id FROM knowledge_document_comments WHERE comment_id = ? AND document_id = ? AND parent_comment_id IS NULL', [parentCommentId, documentId])
      if (!parents[0]) throw new Error('PARENT_COMMENT_NOT_FOUND')
    }
    await this.pool.execute('INSERT INTO knowledge_document_comments (comment_id, document_id, parent_comment_id, comment_kind, content, created_by, author_name) VALUES (?, ?, ?, ?, ?, ?, ?)', [commentId, documentId, parentCommentId, kind, content, actorId, authorName])
    return { commentId, documentId, parentCommentId, kind, content, createdBy: actorId, authorName }
  }
  async addCommentAttachment({ attachmentId, commentId, uploaded, originalFilename, mimeType }) { await this.pool.execute('INSERT INTO knowledge_comment_attachments (attachment_id, comment_id, object_key, original_filename, mime_type, byte_size) VALUES (?, ?, ?, ?, ?, ?)', [attachmentId, commentId, uploaded.objectKey, originalFilename, mimeType, uploaded.byteSize]); return { attachmentId, originalFilename, mimeType, byteSize: uploaded.byteSize } }
  async addCommentMentions({ commentId, mentions }) { for (const mention of [...new Set(mentions)].slice(0, 20)) await this.pool.execute('INSERT INTO knowledge_comment_mentions (comment_id, mention_value) VALUES (?, ?)', [commentId, mention]) }
  async getCommentAttachment(attachmentId) { const [rows] = await this.pool.execute("SELECT attachment.object_key AS objectKey FROM knowledge_comment_attachments attachment JOIN knowledge_document_comments comment ON comment.comment_id = attachment.comment_id JOIN knowledge_documents document ON document.document_id = comment.document_id WHERE attachment.attachment_id = ? AND document.status <> 'archived'", [attachmentId]); return rows[0] }
}
