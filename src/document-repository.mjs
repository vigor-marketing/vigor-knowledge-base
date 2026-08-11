import mysql from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { chunkExtractedText } from './chunker.mjs'

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
      throw error
    } finally {
      connection.release()
    }
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
      `SELECT version.object_key AS objectKey
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
              chunk.content AS content, chunk.heading_path AS headingPath, document.document_type AS documentType,
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
}
