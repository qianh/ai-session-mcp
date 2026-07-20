# BrainHub MCP

BrainHub MCP 是一个本地 Node.js/TypeScript stdio MCP 服务。它只读取 Claude Code、Codex CLI 和 Grok Build 的顶层会话，过滤系统提示、推理、工具参数/结果与子代理内容，在本地脱敏后将规范化快照写入 Google Drive，并提供混合语义搜索、画像拉取和状态查询。

原生会话文件始终只读，不会删除或改写。Gemini CLI 暂未接入。

## 功能

- `upload_sessions`：全量回填或增量上传，图片按 SHA-256 去重并转为 WebP。
- `search_sessions`：依次检索 `cards`、`sessions`、`inbox`，结合关键词和本地 E5 向量排序。
- `get_portrait`：始终读取 Drive 最新画像，并尝试刷新本地 `portrait.md`。
- `pull_portrait`：覆盖写入 `portrait.md` 和 `weekly-latest.md`，返回本期 Diff。
- `hub_status`：汇总 Drive 配额、inbox 积压、蒸馏状态、容量和本地适配器/调度状态。

## 安装与验证

要求 Node.js 22+ 和 pnpm。

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm link --global
```

先运行不接触 Google Drive 的真实扫描：

```bash
brain-mcp upload --backfill --dry-run --json
```

dry-run 不需要 OAuth 或 Drive 根目录，不写状态数据库、不下载向量模型，也不修改客户端和系统调度配置。输出只有数量、字节估算和警告，不包含消息正文。

## 部署门

完成 dry-run 审阅后，才执行 live 初始化：

```bash
brain-mcp config init
brain-mcp auth login
brain-mcp auth status --json
brain-mcp upload --backfill --json
brain-mcp clients install --all
brain-mcp scheduler install --at 02:00
```

`auth login` 会打开 Google 账号选择页。用户在浏览器中选中的账号会成为当前配置的 BrainHub 账号；命令随后读取该账号的 Drive 身份并创建或复用它自己的 `brain-hub` 根目录。重新运行该命令即可切换账号。OAuth token 不会出现在命令输出或 TOML 中。

OAuth client JSON 只标识 BrainHub 应用，不决定最终使用哪个 Google 账号。其他电脑或其他用户应独立安装、运行 `auth login` 并选择自己的账号，不能复制他人的 refresh token 或 `root_folder_id`。如果 OAuth consent screen 仍处于 Testing，Google Cloud 项目还必须允许该账号作为 test user；正式供外部用户使用前，需要按 Google 对完整 Drive scope 的要求完成发布/验证。

历史会话很多时，可先完成 Drive 回填而不等待搜索索引：

```bash
BRAINHUB_UPLOAD_CONCURRENCY=32 brain-mcp upload --backfill --skip-index --json
```

`--skip-index` 只跳过本轮索引刷新，不影响会话和图片上传；结果会包含 `INDEX_SKIPPED` warning。默认并发由 `upload.concurrency` 控制，环境变量 `BRAINHUB_UPLOAD_CONCURRENCY` 可只覆盖当前命令。

Claude Desktop 是显式可选项：

```bash
brain-mcp clients install claude --desktop
```

本仓库实现阶段不会自动执行上述 live 命令。

## 本地磁盘

默认使用量化 `Xenova/multilingual-e5-small`，模型缓存约 118 MB，首次 live 搜索索引同步时下载一次。384 维向量对象存入 Drive，本地不保留向量数据库或会话正文；本地长期数据只有模型缓存及一个仅含哈希、水位、设备 ID 和错误码的 SQLite 文件。

缓存位置：

- macOS：`~/Library/Caches/BrainHub/models`
- Linux：`${XDG_CACHE_HOME:-~/.cache}/brain-mcp/models`

查看或清理：

```bash
brain-mcp search model status --json
brain-mcp search model clear --json
```

详细配置、隐私边界和每日调度行为见 [docs/configuration.md](docs/configuration.md)。
