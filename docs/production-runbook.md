# 企业知识库｜生产接入运行手册

## 必填配置

| 配置 | 说明 |
| --- | --- |
| `COS_BUCKET` / `COS_REGION` / `COS_PREFIX` | 用户自己的腾讯云 COS；文件对象键为 `{prefix}/documents/{document}/versions/{version}/source` |
| `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` | 仅通过密钥管理或容器运行时注入 |
| `MYSQL_URL` | 知识库专属 MySQL，执行 `database/schema.sql` 后启用 |
| `REDIS_URL` | BullMQ 入库、索引和下架队列 |
| `QDRANT_URL` / `QDRANT_INDEX` | 混合检索向量索引 |
| `EMBEDDING_API_URL` / `EMBEDDING_API_KEY` | bge-m3 兼容 Embedding 服务 |
| `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URI` | 工作台 OIDC 验证；令牌 `sub` 必须是 `usr_...`，管理员角色为 `general_manager` 或 `admin_specialist` |
| `DEEPSEEK_API_KEY` | 仅用于有证据的最终回答 |

## 上线顺序

1. 创建或明确指定 COS Bucket 和 `knowledge-base/` 前缀；为运行时身份授予限定读写权限。不得使用 CloudBase 或其他应用的默认 Bucket。
2. 在 CVM 的知识库目录复制 `.env.selfhosted.example` 为 `.env.selfhosted`，只在该文件填入密钥，并限制为 `chmod 600`。
3. 用 `docker compose -f docker-compose.selfhosted.yml --env-file .env.selfhosted up -d --build` 启动专属 MySQL、Redis、Qdrant、知识库 API 和 Worker；除 API 的 4180 测试端口外，不公开任何数据服务端口。
4. 在工作台同域网关配置 `/apps/knowledge-base/`，并由 OIDC 网关注入 HTTPS、HttpOnly、Secure 的 `workbench_access_token` Cookie。
5. 以管理员上传一份非敏感 TXT 文件，确认 COS 对象、MySQL 文档/版本/任务、Worker 解析和审核状态。
6. 发布文档，确认 Qdrant Chunk 索引、向量搜索、引用来源和 DeepSeek 回答。
7. 下架文档，确认搜索和问答均不再返回其内容；随后完成备份恢复和权限绕过测试。

## 禁止项

- 不使用产品编码器或其他应用的默认 Bucket，除非业务负责人明确授权。
- 不在浏览器、Git 仓库、日志或普通文档保存任何密钥。
- 未完成 OIDC、HTTPS 和私网数据服务前，不上传真实或敏感资料。
