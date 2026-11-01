# RelayDesk · OpenAI API 中转与管理控制台

一个轻量、自托管的 OpenAI-compatible API 中转服务，带有中文在线管理首页。支持查看服务健康、累计请求和脱敏请求摘要，在线配置上游地址、模型白名单、中转密钥、请求限制及 CORS 来源，并测试上游连通性。

> 中转服务只负责转发到你有权使用的模型 API，不包含模型或 API 额度。请自行准备上游服务商 API Key，并遵守服务商条款。ChatGPT 订阅与 API 计费通常是分开的。

## 快速启动（Node.js 20+）

```bash
cp .env.example .env
```

编辑 `.env`，至少设置以下值：

- `ADMIN_PASSWORD`：管理控制台密码。**必须设置**，否则管理功能保持关闭。
- `UPSTREAM_API_KEY`：上游模型 API 密钥。
- `RELAY_API_KEY`：App 使用的中转密钥。

然后运行：

```bash
npm start
```

打开 `http://localhost:3000/` 进入 RelayDesk 首页。登录后进入「接口与模型」管理上游和白名单，进入「系统设置」管理中转密钥、请求上限和浏览器跨域来源。管理页面保存的配置写入 `DATA_DIR/settings.json`，重启后仍生效；密钥不会再从页面读出。运行测试：`npm test`。

也可以使用 Docker：

```bash
cp .env.example .env
# 编辑 .env 后：
docker compose up -d --build
```

配置文件中的 `PORT` 是宿主机映射端口；服务容器内部监听 3000。持久化配置保存到 Docker volume `relay-data`。

## 在 App 里配置

在支持自定义 OpenAI API Base URL 的 App 中填写：

- **Base URL / API 地址**：`https://你的域名/v1`
- **API Key**：`RELAY_API_KEY` 中设置的值
- **模型**：上游账号实际可用的模型名称

如果启用了模型白名单，App 请求的模型名称还必须在白名单中。客户端的接口类型选择 OpenAI-compatible。部分客户端要求完整接口地址时，使用 `https://你的域名/v1/chat/completions`。

```bash
curl https://你的域名/v1/chat/completions \
  -H 'Authorization: Bearer 你的RELAY_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

## 支持的接口

- `GET /v1/models`
- `POST /v1/chat/completions`（支持 `stream: true` 和 SSE 透传）
- `POST /v1/responses`
- `POST /v1/embeddings`
- `POST /v1/images/generations`
- `POST /v1/audio/transcriptions`
- `POST /v1/audio/translations`
- `GET /healthz`（无需密钥，仅返回存活状态）

## 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 管理页面持久化设置目录，请限制文件系统访问权限 |
| `ADMIN_PASSWORD` | 空 | 管理后台密码；未设置时后台登录关闭 |
| `UPSTREAM_BASE_URL` | `https://api.openai.com/v1` | 初始上游 OpenAI-compatible API 根地址 |
| `UPSTREAM_API_KEY` | 空 | 初始上游密钥；也可登录后在控制台配置 |
| `RELAY_API_KEY` | 空 | 初始中转密钥；也可登录后在控制台配置 |
| `MODEL_ALLOWLIST` | 空 | 初始逗号分隔模型白名单；空表示不额外限制 |
| `ALLOWED_ORIGINS` | 空 | 初始浏览器来源白名单；原生 App 通常无需配置 |
| `MAX_BODY_BYTES` | `10485760` | 请求体上限，默认 10 MiB |
| `UPSTREAM_TIMEOUT_MS` | `300000` | 上游请求最长时间，默认 5 分钟 |

管理页面保存的配置优先于启动环境变量，并持久化至 `settings.json`。其中 API 密钥以明文保存在服务器本地配置文件中，文件权限会设为仅所有者可读写；请确保 `DATA_DIR` 和备份受服务器管理员保护。若需重置持久化设置，先停止服务，再删除该目录下的 `settings.json`，随后由环境变量重新初始化。

## 安全与部署建议

- 上游 Key 只放在服务器，切勿放进 App、网页前端、Git 仓库或日志。
- 管理控制台启用强 `ADMIN_PASSWORD`，并通过 HTTPS 对外服务。不要在无认证的情况下公开管理端口。
- 中转密钥为共享密钥，不是多用户/额度系统。若面向多位用户，请在前面接入网关，实现限流、配额、审计与密钥轮换。
- `ALLOWED_ORIGINS` 仅添加可信网页来源；原生 App 通常不需要跨域配置。避免使用 `*`。
- 请求记录只包含时间、路径、方法、状态码和耗时；保存在内存中，进程重启后清空，不记录请求正文、IP 或 API Key。
