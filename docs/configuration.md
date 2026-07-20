# BrainHub MCP 配置与部署

## 配置文件

- macOS：`~/Library/Application Support/BrainHub/config.toml`
- Linux：`${XDG_CONFIG_HOME:-~/.config}/brain-mcp/config.toml`

优先级为：命令行一次性参数 > 环境变量 > `config.toml` > 自动发现/默认值。

```toml
version = 1

[device]
name = "macbook"

[drive]
root_folder_id = ""
root_folder_name = "brain-hub"
oauth_client_file = "~/Downloads/google-oauth-client.json"
account_email = ""
account_display_name = ""
account_permission_id = ""

[capture]
claude_paths = ["~/.claude/projects"]
codex_paths = ["~/.codex/sessions"]
grok_paths = ["~/.grok/sessions"]
include_subagents = false
internal_domains = []
internal_cidrs = []

[publish]
fallback_path = ""

[upload]
batch_size = 100
concurrency = 4

[search]
model = "Xenova/multilingual-e5-small"
model_revision = "ae61bf0193ce3851dc8a45147e459b04ed783d8a"
dimensions = 384
chunk_tokens = 448
chunk_overlap = 64
default_limit = 10
max_limit = 50

[scheduler]
at = "02:00"
```

常用环境变量包括 `BRAINHUB_CONFIG`、`BRAINHUB_DRIVE_ROOT_ID`、`BRAINHUB_GOOGLE_OAUTH_CLIENT_FILE`、`BRAINHUB_PUBLISH_FALLBACK_PATH`、`BRAINHUB_CLAUDE_PATHS`、`BRAINHUB_CODEX_PATHS`、`BRAINHUB_GROK_PATHS`、`BRAINHUB_INCLUDE_SUBAGENTS`、`BRAINHUB_MODEL_CACHE` 和 `BRAINHUB_SCHEDULE_AT`。多路径值使用操作系统路径分隔符。

## Google OAuth 与 Drive

1. 在 Google Cloud 项目启用 Google Drive API。
2. 创建 Desktop application 类型的 OAuth 客户端，下载 JSON。
3. 将 JSON 路径写入 `drive.oauth_client_file`。
4. 执行 `brain-mcp auth login`。浏览器会始终显示账号选择页；选中的账号就是当前配置实际使用的 Drive 账号。
5. 授权完成后，BrainHub 会读取所选账号的 Drive 身份，创建或复用该账号中的 `brain-hub`，再提交凭证和配置。无需额外执行 `drive init`。

授权范围是完整 Drive scope，因为还要读取 Codex Cloud 等其他客户端生成的文件。OAuth 流程使用 state 校验和 PKCE S256。新凭证在账号身份和根目录绑定成功前只暂存在内存；任何一步失败都会保留旧账号绑定。

检查、切换和退出：

```bash
brain-mcp auth status --json
brain-mcp drive status --json
brain-mcp auth login       # 重新选择账号
brain-mcp auth logout      # 同时清除凭证、账号身份和 root 绑定
```

`drive init` 仍可用于旧配置补录，但它现在也会验证并保存实际账号身份。`account_email`、`account_display_name`、`account_permission_id` 和 `root_folder_id` 均由上述命令维护，不应手工复制自其他用户。

OAuth client JSON 标识的是应用，不会把授权固定到创建该 client 的 gcloud 账号。其他用户可以选择自己的 Google 账号并上传到自己的 Drive，前提是 OAuth consent screen 允许该用户：Testing 状态下需加入 test users；面向外部用户发布时需满足 Google 对完整 Drive scope 的验证要求。每台电脑、每份配置都必须自行完成授权，禁止共享 refresh token 或他人的 `root_folder_id`。

refresh token 不进入 TOML、环境变量或 SQLite：macOS 存在登录钥匙串，Linux 存在 Secret Service。凭证按配置文件路径隔离，因此同一电脑上的两个 `--config` 不会互相覆盖；旧版按设备名保存的凭证会在首次读取时迁移。代码对所有 Drive ID 操作验证根目录祖先关系，MCP 工具不接受任意 Drive file ID。

`upload.concurrency` 控制同时处理的会话数，范围为 1-32。大型首次回填可使用 `--skip-index` 先完成 Drive 文件上传；该选项不会改变上传内容，只会返回 `INDEX_SKIPPED` warning 并跳过本轮自动搜索索引刷新。后续不带该选项的上传仍会按默认行为刷新索引。

## 采集与隐私

采集内容仅包括顶层会话里的用户文本、可见助手文本和显式消息图片。默认排除：

- system/developer prompt；
- reasoning/thinking；
- 工具参数、工具结果和 shell 输出；
- 环境快照；
- Claude sidechain、Codex subagent 和 Grok subagent。

本地规则在上传前处理 bearer token、密码赋值、凭据 URL、私钥、常见 API key、配置的内部域名和 CIDR。原生会话文件始终只读。BrainHub 只清理自己创建且已经校验的临时候选，不清理任何 CLI 历史。

## Obsidian 写入

每次拉取先读取 Obsidian 的 vault 注册表，选择当前打开或最近使用且可写的 vault，写入 `<vault>/BrainHub/`。只有未发现可写 vault 时，才使用 `publish.fallback_path`。

- `get_portrait`：读取 Drive `publish/portrait.md` 并尝试原子刷新本地画像；没有可写目录时仍返回 Drive 内容和警告。
- `pull_portrait`：原子覆盖 `portrait.md` 与 `weekly-latest.md`，并返回 `变更 Diff`、`本期变化` 或 `Diff` 章节。

不会安装 Obsidian 同步插件，也不会触碰 `BrainHub/` 之外的 vault 内容。

## 每日上传任务

### macOS launchd

`brain-mcp scheduler install --at 02:00` 生成用户级 `~/Library/LaunchAgents/com.brainhub.upload.plist`：

- `StartCalendarInterval` 在本地时间 02:00 触发；
- `RunAtLoad=true`，首次安装/用户 LaunchAgent 加载时立即补跑一次；
- 电脑在计划时间睡眠时，launchd 会在唤醒后处理错过的日历触发；
- 以当前登录用户运行，因此可以访问该用户的 Keychain、会话目录和配置；
- stdout/stderr 写入 `~/Library/Logs/BrainHub/`，上传命令只输出聚合 JSON，不输出会话正文。

### Linux systemd user timer

安装后生成 `~/.config/systemd/user/brainhub-upload.service` 和 `.timer`：

- service 使用 `Type=oneshot`；
- timer 使用 `OnCalendar=*-*-* 02:00:00`；
- `Persistent=true`，关机或睡眠错过后，用户 manager 下次启动时补跑；
- 安装器显式启动一次 service，不等待第二天；
- 使用 `systemctl --user`，不需要 root。

如果 Linux 用户完全退出后仍需运行，必须保证 user manager 常驻，例如由管理员启用 `loginctl enable-linger <user>`。Secret Service/桌面 keyring 也必须能在该用户会话中解锁；无桌面服务器建议先验证 `secret-tool lookup ...` 在 user service 环境可用。

查看和删除：

```bash
brain-mcp scheduler status --json
brain-mcp scheduler uninstall --json
```

调度器与手动/MCP 上传共享进程锁；并发触发时第二个任务返回 `UPLOAD_BUSY`，不会重叠写 Drive。

## MCP 客户端

安装器在修改前检查各 CLI 的 `mcp add --help`，不支持约定语法时返回 `CLIENT_VERSION_UNSUPPORTED`。

```text
claude mcp add --scope user brain-hub -- <brain-mcp> serve
codex mcp add brain-hub -- <brain-mcp> serve
grok mcp add --scope user brain-hub -- <brain-mcp> serve
```

Claude Desktop 配置采用保留未知字段的 JSON 合并，并在覆盖前创建备份；必须通过 `--desktop` 显式启用。

## 语义索引

E5 输入使用 `query:` / `passage:` 前缀，单块不超过 448 个估算 token，保留 64 token 重叠。向量对象按内容 SHA-256 寻址，带模型版本、维度和校验和；manifest 使用 ETag 条件写和冲突重试。损坏或版本不匹配的对象会从 Drive Markdown 重建。

本地不保存向量索引。查询时从 Drive 读取所需向量到内存，结果按 `cards > sessions > inbox` 加权并按 conversation ID 去重。索引刷新失败时返回已有结果，同时明确标记 `INDEX_STALE`。
