# BrainHub MCP 配置

## 普通安装

官方 npm 包内置 BrainHub 的 Desktop OAuth 应用配置。用户不需要创建 Google Cloud 项目：

```bash
npm install -g brainhub-mcp
brainhub-mcp setup
```

配置文件位于 `~/Library/Application Support/BrainHub/config.toml`。refresh token 只保存在 macOS Keychain，“Google 账号 permission ID + root folder ID”绑定对应的上传状态和搜索索引位于 `~/Library/Application Support/BrainHub/accounts/<hash>/`，模型缓存位于 `~/Library/Caches/BrainHub/models/`。升级旧版状态时，全局旧库只会被首个绑定认领一次，不会复制到之后切换的账号。

## setup 选项

```text
--yes                    默认确认历史回填，适合非交互安装
--drive-root-id <id>     同名 brain-hub 冲突时明确选择一个目录
--obsidian-vault <path>  将每日画像写入该 vault/BrainHub/portrait.md
--json                   最终结果使用 JSON 输出
```

setup 会先实时验证 Keychain 凭据和 Google Drive 账号身份，再复用已经完成的绑定。首次回填的接受或拒绝决定会持久化；接受后若仍有待重试会话，下次 setup 直接续传，不会重新扫描或询问。模型下载失败不会阻止授权、回填和客户端注册；搜索会暂时使用关键词模式，之后重新运行 setup 即可重试下载。使用全局 `--config <path>` 时，自动注册的 MCP 客户端和 launchd 都会保留该路径。

没有配置 Obsidian 时只安装每日会话上传任务。发现或显式指定可写 vault 后，才额外安装每日画像同步任务。

## 本地会话来源

| 来源        | `source`      | 默认读取路径                                        | 环境变量                |
| ----------- | ------------- | --------------------------------------------------- | ----------------------- |
| Claude Code | `claude-code` | `~/.claude/projects/**/*.jsonl`                     | `BRAINHUB_CLAUDE_PATHS` |
| Codex CLI   | `codex`       | `~/.codex/sessions/**/rollout-*.jsonl`              | `BRAINHUB_CODEX_PATHS`  |
| Grok Build  | `grok-build`  | `~/.grok/sessions/**/chat_history.jsonl`            | `BRAINHUB_GROK_PATHS`   |
| Cursor      | `cursor`      | `~/.cursor/projects/**/agent-transcripts/*/*.jsonl` | `BRAINHUB_CURSOR_PATHS` |

路径环境变量使用当前平台的路径分隔符，可配置多个扫描根目录。Cursor 采集只读取精确的 agent transcript 层级，只把 user 记录中的 `<user_query>` 内容识别为用户输入，并排除动态工具、MCP 与 Hook 注入记录。它不读取 Cursor 的 `state.vscdb`、`conversation-search.db` 或 `agent-tools/`；会话 ID 取 transcript 文件名，时间范围取文件 birthtime/mtime。

可用 `--sources` 限定一次上传，例如：

```bash
brainhub-mcp upload --sources cursor --backfill --dry-run --json
```

## Google 账号

授权页始终允许用户选择自己的 Google 账号。当前配置一次只绑定一个账号，切换命令为：

```bash
brainhub-mcp auth switch
brainhub-mcp auth switch --drive-root-id <id>
brainhub-mcp auth switch --yes       # 非交互接受新绑定的首次回填
brainhub-mcp auth status --json
brainhub-mcp auth logout
```

切换后使用新“账号 + root”绑定自己的上传水位、回填状态、重试状态和本地索引。首次使用的绑定会先确认历史回填；切回已完成的绑定时恢复原有本地状态。重新选择另一个 root 会创建新的状态分区，不会让旧 root 的 uploaded 记录或 Drive cursor 阻止回填。

BrainHub MCP 使用完整 Google Drive scope，因为它需要读取同一账号中由其他产品生成的 My Drive 根文件 `Digital_Twin_Profile.md`，并维护 `brain-hub/inbox/`。MCP 工具不接受任意 Drive 路径或 file ID。

## Drive 数据结构

```text
My Drive/
  Digital_Twin_Profile.md
  brain-hub/
    inbox/
      <device>/
      _assets/sha256/
```

MCP 不创建、读取或迁移 `sessions/`，也不因组件升级移动、改写或删除 Drive 内容。远端会话身份固定为 `source + conversation_id`。

## Obsidian 与 launchd

每日上传默认在本地时间 02:00 运行。配置 Obsidian 后，画像同步默认在 06:00 运行，并原子覆盖固定文件：

```text
<vault>/BrainHub/portrait.md
```

画像源由 `portrait.directory` 和 `portrait.fileName` 配置，目录相对于 My Drive 根目录；目录为空时读取根目录文件。默认是 `Digital_Twin_Profile.md`。任务失败会保留旧文件并在下次重试；不保存历史版本，不读取或生成周报。

```bash
brainhub-mcp scheduler status --json
brainhub-mcp scheduler install --at 02:00 --sync-at 06:00
brainhub-mcp scheduler uninstall --json
```

每日上传任务不固定来源参数，而是在执行时使用当前版本支持的默认来源。从旧版升级后需运行一次 `brainhub-mcp setup` 或 `brainhub-mcp scheduler install` 来覆盖旧的三来源 plist。回填决定会持久化确认时的来源集合；旧版未完成的 accepted 回填仍只重试原三来源，declined 决定也不会被重置。普通增量上传只从升级后的首次 Cursor 扫描开始，旧 Cursor 历史必须由用户显式执行 `brainhub-mcp upload --sources cursor --backfill`。

## 本地语义搜索

模型固定为 `Xenova/multilingual-e5-small` revision `ae61bf0193ce3851dc8a45147e459b04ed783d8a`。脱敏文本分块、384 维向量、manifest 和 Drive change cursor 都只在当前 Mac 的账号级 SQLite 中。

```bash
brainhub-mcp search query "查询内容" --json
brainhub-mcp search sync --json
brainhub-mcp search reindex --json
brainhub-mcp search model status --json
```

模型不可用时返回关键词结果并标记 `MODEL_UNAVAILABLE_KEYWORD_FALLBACK`；缺失向量会让下一次同步重试完整索引，模型恢复后自动回到语义搜索。模型、revision、维度、分块大小或重叠大小变化时会重建索引。Drive 临时错误会保留旧 cursor、使用最近有效索引并标记 stale；目录移动会重列 `inbox/` 子树，避免遗漏或残留后代文件。`hub_status` 只有在当前模型成功加载并写入匹配的完成标记后才报告 ready，缓存残片不算就绪。

## 源码构建 OAuth

源码构建和 fork 不包含官方 OAuth 值。请在自己的 Google Cloud 项目中创建 Desktop application OAuth Client，启用 Drive API，并把下载的 JSON 路径提供给配置或环境变量：

```bash
BRAINHUB_GOOGLE_OAUTH_CLIENT_FILE="$PWD/oauth-client.json" pnpm dev -- setup
```

OAuth consent screen、外部用户验证、安全审查和数据使用披露由 fork 维护者负责。不得提交 OAuth JSON、client secret、refresh token 或本地配置。
