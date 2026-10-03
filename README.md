# BrainHub MCP

BrainHub MCP 是一个仅在本机运行的 MCP 服务，支持 macOS 与 Linux。它读取 Claude Code、Codex CLI、Grok Build 和 Cursor 的本地会话，脱敏后上传到用户自己选择的 Google Drive，并提供本地语义搜索、完整会话读取和数字画像读取。

原始会话始终只读。BrainHub MCP 不包含 cards、周报、云端处理、遥测或自更新器。

## 安装

要求 macOS 或 Linux，以及 Node.js `>=22.12.0`。

Linux 使用 XDG 路径：配置在 `${XDG_CONFIG_HOME:-~/.config}/brainhub-mcp/config.toml`，状态在 `${XDG_STATE_HOME:-~/.local/state}/brainhub-mcp/`，模型缓存在 `${XDG_CACHE_HOME:-~/.cache}/brainhub-mcp/models/`。refresh token 只进入 Secret Service（`secret-tool`）。Arch Linux 需要安装 `libsecret`，并运行一个 Secret Service 提供者，例如 `gnome-keyring`。每日任务是 systemd user timer，单元写在 `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`。用户未登录时 timer 不会运行；需要登出后继续执行时，运行 `loginctl enable-linger "$USER"`。

```bash
npm install -g brainhub-mcp
brainhub-mcp
```

npm 安装或升级会自动为检测到的客户端安装 Skill，并注册尚未注册的 MCP；已有 MCP 启动配置会保留。Skill 安装无需单独执行 `setup`。

首次运行 `brainhub-mcp` 会直接进入配置引导（也可显式运行 `brainhub-mcp setup`），依次完成：

1. 打开浏览器，让用户选择自己的 Google 账号并授权 Google Drive。
2. 创建或绑定该账号 My Drive 根目录下的 `brain-hub/`。若存在多个同名目录，流程会停止并要求用户明确选择。
3. 下载固定版本的 `Xenova/multilingual-e5-small`，并显示进度。
4. 统计本机可回填会话的数量与字节数；默认确认后上传历史会话。
5. 自动注册已安装的 MCP 客户端，并安装每日上传定时任务。macOS 使用 launchd，Linux 使用 systemd user timer。
6. 为已检测到的 Codex、Grok Build、Claude Code 和 Cursor 安装 BrainHub 的 5 个独立 Skill；用户只需安装一次 BrainHub。
7. 如显式指定 Obsidian vault，安装独立的每日画像覆盖任务。

流程可以重复运行。`setup` 会实时验证已有 Google 凭据与账号身份，并复用已完成的账号绑定、回填决定、客户端注册和定时任务；未完成且仍有待重试项的回填会继续执行，不会再次询问。

## 会话来源

- Claude Code：`~/.claude/projects/**/*.jsonl`
- Codex CLI：`~/.codex/sessions/**/rollout-*.jsonl`
- Grok Build：`~/.grok/sessions/**/chat_history.jsonl`
- Cursor：`~/.cursor/projects/**/agent-transcripts/*/*.jsonl`

默认只保留用户与助手的可见文本和图片；system/developer prompt、隐藏推理、工具调用参数与结果、环境快照和 shell 输出不会进入规范化会话。Claude Code、Codex CLI 和 Grok Build 的 sidechain/subagent 默认排除；Cursor 只采集 user 记录中显式的 `<user_query>` 内容，并丢弃动态工具、MCP 与 Hook 注入上下文。Cursor 采集只扫描上述精确的 agent transcript 层级，不读取 `state.vscdb` 或 `agent-tools/`。

## MCP 工具

- `upload_sessions`：上传新增或变化的本地 AI 编程会话到 `brain-hub/inbox/<device>/`。
- `search_sessions`：刷新本地 inbox 索引并执行语义与关键词混合搜索。
- `get_session`：使用 `{source, conversation_id}` 返回 Drive 中的完整 inbox 会话。
- `get_portrait`：只读并完整返回配置的 Google Drive 目录和文件。

画像来源可在配置文件中设置：`portrait.directory`（相对 My Drive 根目录的目录，可为空）和 `portrait.fileName`（文件名）。默认值仍为根目录下的 `Digital_Twin_Profile.md`。

- `hub_status`：返回账号、root、上传、模型、索引、定时任务、画像、Obsidian 和 npm 版本状态。定时任务状态的字段名仍是 `launchd`。

## Skill 调用

npm 安装时，BrainHub 会为检测到的客户端安装对应以下 5 个 MCP 方法的独立 Skill：

```text
get_portrait
search_sessions
get_session
upload_sessions
hub_status
```

这些是普通 Skill，名称分别为 `brainhub-get-portrait`、`brainhub-search-sessions`、`brainhub-get-session`、`brainhub-upload-sessions`、`brainhub-hub-status`。在客户端的 Skill 选择界面中按名称调用；Codex 示例：`$brainhub-get-portrait`。Skill 只负责路由到对应 MCP 方法，参数仍遵循 MCP 工具定义。

npm 升级会自动补装 Skill；MCP 服务启动时也会为已有客户端目录补装，覆盖安装脚本被禁用或之后新增客户端的情况。已打开的客户端可能需要重启或刷新 Skill 列表。安装保留已有同名目录；卸载只删除本安装器创建且内容未改动的 Skill 文件，保留用户自定义文件和旧的 `brainHub` 目录。

`get_portrait` 不写 Obsidian。只有每日 `portrait sync` 任务会原子覆盖 `<vault>/BrainHub/portrait.md`；它不生成历史版本，也不读取周报。

## 账号与数据

一份配置只绑定一个当前 Google 账号，但可随时切换：

```bash
brainhub-mcp auth switch
# 非交互接受新绑定的首次历史回填
brainhub-mcp auth switch --yes
```

每个“Google 账号 + 选定的 `brain-hub` root”绑定都有独立的上传水位、回填决定、重试状态和本地搜索索引。切换到首次使用的绑定时会执行与 `setup` 相同的历史回填确认；切回已完成的绑定时直接恢复原状态。refresh token 只进入操作系统密钥环：macOS Keychain 或 Linux Secret Service。它不写入 TOML、SQLite 或日志。

会话与图片只写入 `brain-hub/inbox/`。搜索的脱敏文本分块、向量、manifest 和 Drive change cursor 只保存在当前设备的 SQLite 中，不写回 Drive。模型不可用时自动降级为关键词搜索，恢复后自动补齐缺失向量；Drive 刷新失败时保留旧 cursor 和最近有效索引并标记 stale。

## 升级与卸载

`hub_status` 最多每 24 小时查询一次 npm 最新版本。升级必须由用户主动执行：

```bash
npm install -g brainhub-mcp@latest
```

从不支持 Cursor 的旧版本升级后，运行一次 `brainhub-mcp setup` 或 `brainhub-mcp scheduler install`，以便用新的来源无关任务替换旧的三来源定时任务参数。历史回填决定会保存当时获准的来源范围；旧版未完成回填重试时仍只处理原三来源，不会静默上传旧 Cursor 会话。如需回填，显式执行：

```bash
brainhub-mcp upload --sources cursor --backfill
```

完整卸载：

```bash
brainhub-mcp uninstall
```

卸载会移除 MCP 客户端注册、定时任务、Google OAuth 授权、系统密钥环凭据、配置、本地索引、状态和模型缓存。它不会删除或改写 Google Drive 与 Obsidian 中的任何内容。

## 源码开发

官方 npm 包在发布时注入 BrainHub 的 Desktop OAuth 配置。源码构建与 fork 必须使用自己的 Google Cloud Desktop OAuth Client，不得提交 client secret 或 refresh token。

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

推送到 `master` 后，GitHub Actions 会根据 Conventional Commits 自动决定版本、创建 Git tag 与 GitHub Release，并通过 npm Trusted Publishing 发布：

- `fix:` 或 `perf:` 发布补丁版本。
- `feat:` 发布次版本。
- 提交正文包含 `BREAKING CHANGE:` 时发布主版本。
- `docs:`、`chore:`、`test:` 等不会发布 npm 新版本。

不要手工修改版本号、创建 Release 或运行 `npm publish`。

详细配置与源码 OAuth 方法见 [docs/configuration.md](docs/configuration.md)，数据使用与删除说明见 [docs/privacy.md](docs/privacy.md)。

## 许可

Apache License 2.0。安全问题请使用 GitHub Security Advisory 私下报告。
