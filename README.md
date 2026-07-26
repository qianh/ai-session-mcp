# BrainHub MCP

BrainHub MCP 是一个本地 Node.js/TypeScript stdio MCP 服务。它只读取 Claude Code、Codex CLI 和 Grok Build 的顶层会话，过滤系统提示、推理、工具参数/结果与子代理内容，在本地脱敏后将规范化快照写入 Google Drive，并提供混合语义搜索、画像拉取和状态查询。

原生会话文件始终只读，不会删除或改写。Gemini CLI 暂未接入。

## 功能

- `upload_sessions`：全量回填或增量上传；会话写入 `inbox/<device>/`，图片按 SHA-256 去重、转为 WebP 后写入 `inbox/_assets/sha256/`。
- `search_sessions`：依次检索 `cards`、`sessions`、`inbox`，结合关键词和本地 E5 向量排序。
- `get_portrait`：始终读取 My Drive 根目录的 `Digital_Twin_Profile.md`，并尝试刷新本地 `portrait.md`。
- `pull_portrait`：将数字分身同步为本地 `portrait.md`，同时拉取 BrainHub 最新周报；周报尚未发布时仍会独立更新画像。
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
```

`clients install` 在成功注册 MCP 客户端后，会自动安装两份本地任务：默认 `02:00` 执行 `upload --sources claude-code,codex,grok-build --json`，默认 `06:00` 检查 Drive 发布结果并将新版画像和周报同步到 Obsidian。时间可通过配置或 `BRAINHUB_SCHEDULE_AT`、`BRAINHUB_SYNC_AT` 修改。正常安装不需要再执行单独的 scheduler 命令；`--no-scheduler` 会同时跳过上传和同步任务。

每日上传按来源分别维护本地 SQLite 水位，只扫描水位后的文件和待重试文件。单一来源解析失败不会推进该来源水位，也不会阻塞其他来源。上传过程只读取和修改 `brain-hub/inbox/`，不会枚举或更新远程其他目录。

`auth login` 会打开 Google 账号选择页。用户在浏览器中选中的账号会成为当前配置的 BrainHub 账号；命令随后读取该账号的 Drive 身份并创建或复用它自己的 `brain-hub` 根目录。重新运行该命令即可切换账号。OAuth token 不会出现在命令输出或 TOML 中。

OAuth client JSON 只标识 BrainHub 应用，不决定最终使用哪个 Google 账号。其他电脑或其他用户应独立安装、运行 `auth login` 并选择自己的账号，不能复制他人的 refresh token 或 `root_folder_id`。如果 OAuth consent screen 仍处于 Testing，Google Cloud 项目还必须允许该账号作为 test user；正式供外部用户使用前，需要按 Google 对完整 Drive scope 的要求完成发布/验证。

历史会话很多时，可提高并发执行一次显式回填：

```bash
BRAINHUB_UPLOAD_CONCURRENCY=32 brain-mcp upload --backfill --json
```

默认并发由 `upload.concurrency` 控制，环境变量 `BRAINHUB_UPLOAD_CONCURRENCY` 可只覆盖当前命令。会话上传不再自动刷新搜索索引；需要维护索引时单独执行 `brain-mcp search sync --json`，需要完整重建时执行 `brain-mcp search reindex --json`。

Claude Desktop 是显式可选项：

```bash
brain-mcp clients install claude --desktop
```

调度器的状态检查、修复安装和卸载仍可通过 `brain-mcp scheduler status|install|uninstall` 单独完成。

本仓库实现阶段不会自动执行上述 live 命令。

## 本地磁盘

默认使用量化 `Xenova/multilingual-e5-small`，模型缓存约 118 MB，首次显式执行搜索索引同步时下载一次。384 维向量对象存入 Drive，本地不保留向量数据库或会话正文；本地长期数据只有模型缓存及一个仅含哈希、水位、设备 ID 和错误码的 SQLite 文件。

缓存位置：

- macOS：`~/Library/Caches/BrainHub/models`
- Linux：`${XDG_CACHE_HOME:-~/.cache}/brain-mcp/models`

查看或清理：

```bash
brain-mcp search model status --json
brain-mcp search model clear --json
```

详细配置、隐私边界和每日调度行为见 [docs/configuration.md](docs/configuration.md)。
