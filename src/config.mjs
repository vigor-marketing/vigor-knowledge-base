export function loadConfig(environment = process.env) {
  const port = Number(environment.PORT || 4180)
  const maxUploadBytes = Number(environment.MAX_UPLOAD_BYTES || 50 * 1024 * 1024)
  if (!Number.isSafeInteger(port) || !Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) throw new Error('Invalid service configuration.')
  return {
    port,
    maxUploadBytes,
    testAdmin: environment.KNOWLEDGE_BASE_TEST_ADMIN === 'true',
    basePath: environment.APP_BASE_PATH || '/apps/knowledge-base/',
    mysqlUrl: environment.MYSQL_URL,
    redisUrl: environment.REDIS_URL,
    search: environment.QDRANT_URL && ((environment.EMBEDDING_API_URL && environment.EMBEDDING_API_KEY) || (environment.HUNYUAN_EMBEDDING === 'true' && environment.TENCENTCLOUD_SECRET_ID && environment.TENCENTCLOUD_SECRET_KEY))
      ? {
          node: environment.QDRANT_URL,
          apiKey: undefined,
          indexName: environment.QDRANT_INDEX || 'knowledge_chunks_v1',
          embeddingUrl: environment.EMBEDDING_API_URL,
          embeddingApiKey: environment.EMBEDDING_API_KEY,
          embeddingModel: environment.HUNYUAN_EMBEDDING === 'true' ? 'hunyuan-embedding' : environment.EMBEDDING_MODEL || 'bge-m3',
          embeddingDimensions: Number(environment.EMBEDDING_DIMENSIONS || 1024),
          hunyuan: environment.HUNYUAN_EMBEDDING === 'true'
            ? { secretId: environment.TENCENTCLOUD_SECRET_ID, secretKey: environment.TENCENTCLOUD_SECRET_KEY, region: environment.HUNYUAN_REGION || 'ap-shanghai' }
            : undefined,
        }
      : undefined,
    deepseek: environment.DEEPSEEK_API_KEY
      ? { baseUrl: environment.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', apiKey: environment.DEEPSEEK_API_KEY, model: environment.DEEPSEEK_MODEL || 'deepseek-chat' }
      : undefined,
    oidc: environment.OIDC_ISSUER && environment.OIDC_AUDIENCE && environment.OIDC_JWKS_URI
      ? { issuer: environment.OIDC_ISSUER, audience: environment.OIDC_AUDIENCE, jwksUri: environment.OIDC_JWKS_URI }
      : undefined,
    cos: environment.COS_BUCKET && environment.COS_REGION && environment.TENCENTCLOUD_SECRET_ID && environment.TENCENTCLOUD_SECRET_KEY
      ? { bucket: environment.COS_BUCKET, region: environment.COS_REGION, prefix: environment.COS_PREFIX || 'knowledge-base', secretId: environment.TENCENTCLOUD_SECRET_ID, secretKey: environment.TENCENTCLOUD_SECRET_KEY }
      : undefined,
  }
}
