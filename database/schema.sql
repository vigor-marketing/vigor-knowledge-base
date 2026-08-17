CREATE TABLE knowledge_documents (
  document_id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  document_type VARCHAR(64) NOT NULL,
  language VARCHAR(16) NOT NULL,
  department_id VARCHAR(64) NULL,
  product_id VARCHAR(64) NULL,
  security_level ENUM('public', 'internal', 'confidential', 'restricted') NOT NULL DEFAULT 'internal',
  ai_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  status ENUM('draft', 'review', 'approved', 'active', 'obsolete', 'archived') NOT NULL DEFAULT 'draft',
  current_version_id VARCHAR(64) NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX knowledge_documents_status_idx (status),
  INDEX knowledge_documents_product_idx (product_id)
);

CREATE TABLE knowledge_document_versions (
  version_id VARCHAR(64) PRIMARY KEY,
  document_id VARCHAR(64) NOT NULL,
  version_label VARCHAR(64) NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  parsing_status ENUM('pending', 'processing', 'review', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  permission_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY knowledge_document_versions_document_label_uq (document_id, version_label),
  UNIQUE KEY knowledge_document_versions_hash_uq (content_hash),
  CONSTRAINT knowledge_document_versions_document_fk FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id)
);

CREATE TABLE knowledge_ingestion_jobs (
  job_id VARCHAR(64) PRIMARY KEY,
  version_id VARCHAR(64) NOT NULL,
  status ENUM('queued', 'processing', 'review', 'completed', 'failed') NOT NULL DEFAULT 'queued',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_code VARCHAR(128) NULL,
  error_message VARCHAR(1024) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX knowledge_ingestion_jobs_status_idx (status, created_at),
  CONSTRAINT knowledge_ingestion_jobs_version_fk FOREIGN KEY (version_id) REFERENCES knowledge_document_versions(version_id)
);

CREATE TABLE knowledge_document_extractions (
  version_id VARCHAR(64) PRIMARY KEY,
  extracted_text LONGTEXT NOT NULL,
  parser_status ENUM('completed', 'review') NOT NULL,
  parser_reason VARCHAR(128) NULL,
  char_count INT UNSIGNED NOT NULL,
  replacement_character_count INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT knowledge_document_extractions_version_fk FOREIGN KEY (version_id) REFERENCES knowledge_document_versions(version_id)
);

CREATE TABLE knowledge_document_chunks (
  chunk_id VARCHAR(64) PRIMARY KEY,
  version_id VARCHAR(64) NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  heading_path VARCHAR(512) NULL,
  content MEDIUMTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY knowledge_document_chunks_version_ordinal_uq (version_id, ordinal),
  CONSTRAINT knowledge_document_chunks_version_fk FOREIGN KEY (version_id) REFERENCES knowledge_document_versions(version_id)
);

CREATE TABLE knowledge_document_types (
  type_code VARCHAR(64) PRIMARY KEY,
  display_name VARCHAR(64) NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
INSERT INTO knowledge_document_types (type_code, display_name, sort_order) VALUES
  ('PRODUCT', '产品资料', 10), ('TECHNICAL', '技术资料', 20), ('SOP', 'SOP / 制度', 30);

CREATE TABLE knowledge_document_comments (
  comment_id VARCHAR(64) PRIMARY KEY,
  document_id VARCHAR(64) NOT NULL,
  parent_comment_id VARCHAR(64) NULL,
  comment_kind ENUM('comment', 'suggestion') NOT NULL DEFAULT 'comment',
  content VARCHAR(2000) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  author_name VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX knowledge_document_comments_document_idx (document_id, created_at),
  INDEX knowledge_document_comments_parent_idx (parent_comment_id, created_at),
  CONSTRAINT knowledge_document_comments_parent_fk FOREIGN KEY (parent_comment_id) REFERENCES knowledge_document_comments(comment_id),
  CONSTRAINT knowledge_document_comments_document_fk FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id)
);
CREATE TABLE knowledge_comment_attachments (
  attachment_id VARCHAR(64) PRIMARY KEY, comment_id VARCHAR(64) NOT NULL, object_key VARCHAR(512) NOT NULL, original_filename VARCHAR(255) NOT NULL, mime_type VARCHAR(128) NOT NULL, byte_size BIGINT UNSIGNED NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX knowledge_comment_attachments_comment_idx (comment_id, created_at), CONSTRAINT knowledge_comment_attachments_comment_fk FOREIGN KEY (comment_id) REFERENCES knowledge_document_comments(comment_id)
);
CREATE TABLE knowledge_comment_mentions (
  comment_id VARCHAR(64) NOT NULL, mention_value VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (comment_id, mention_value), CONSTRAINT knowledge_comment_mentions_comment_fk FOREIGN KEY (comment_id) REFERENCES knowledge_document_comments(comment_id)
);
