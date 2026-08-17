# Vigor 企业知识库

独立部署的企业知识库应用，正式接入工作台路径为 `/apps/knowledge-base/`。

## 当前阶段

已提供独立服务、健康检查、文件安全策略和 MySQL/COS 入库链路。只有同时配置 MySQL、COS 区域和腾讯云密钥后，上传接口才启用；索引、OIDC 与 DeepSeek 尚未启用。实施范围和上线门槛以 `企业知识库应用_目标规格与核对清单.md` 为准。

## COS 存储约定

知识库没有本地文件回退。只有配置的 `COS_BUCKET` 才会被使用；对象键固定为：

```text
{COS_PREFIX}/documents/{document_id}/versions/{version_id}/source
```

默认前缀为 `knowledge-base`。例如：`knowledge-base/documents/kdoc_.../versions/kver_.../source`。后续 OCR、解析文本和预览文件也必须放在相同文档版本目录下，不覆盖原始文件。

## 本地验证

```bash
cp .env.example .env
npm start
curl http://127.0.0.1:4180/api/health
```

浏览器入口为 `http://127.0.0.1:4180/apps/knowledge-base/`。
