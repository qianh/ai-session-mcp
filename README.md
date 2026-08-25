# BrainHub MCP

BrainHub MCP 是一个仅在本机运行的 macOS MCP 服务。它读取 Claude Code、Codex CLI、Grok Build 和 Cursor 的本地会话，脱敏后上传到用户自己选择的 Google Drive，并提供本地语义搜索、完整会话读取和数字画像读取。

原始会话始终只读。BrainHub MCP 不包含 cards、周报、云端处理、遥测或自更新器。

## 安装

第一版要求 macOS 与 Node.js `>=22.12.0`。

```bash
npm install -g brainhub-mcp
brainhub-mcp setup
```

`setup` 会依次完成：

1. 打开浏览器，让用户选择自己的 Google 账号并授权 Google Drive。
2. 创建或绑定该账号 My Drive 根目录下的 `brain-hub/`。若存在多个同名目录，流程会停止并要求用户明确选择。
3. 下载固定版本的 `Xenova/multilingual-e5-small`，并显示进度。
4. 统计本机可回填会话的数量与字节数；默认确认后上传历史会话。
5. 自动注册已安装的 MCP 客户端，并安装每日上传 launchd 任务。
6. 如显式指定 Obsidian vault，安装独立的每日画像覆盖任务。

流程可以重复运行。`setup` 会实时验证已有 Google 凭据与账号身份，并复用已完成的账号绑定、回填决定、客户端注册和 launchd 配置；未完成且仍有待重试项的回填会继续执行，不会再次询问。

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
- `get_portrait`：只读并完整返回 My Drive 根目录的 `Digital_Twin_Profile.md`。
- `hub_status`：返回账号、root、上传、模型、索引、launchd、画像、Obsidian 和 npm 版本状态。

`get_portrait` 不写 Obsidian。只有每日 `portrait sync` 任务会原子覆盖 `<vault>/BrainHub/portrait.md`；它不生成历史版本，也不读取周报。

## 账号与数据

一份配置只绑定一个当前 Google 账号，但可随时切换：

```bash
brainhub-mcp auth switch
# 非交互接受新绑定的首次历史回填
brainhub-mcp auth switch --yes
```

每个“Google 账号 + 选定的 `brain-hub` root”绑定都有独立的上传水位、回填决定、重试状态和本地搜索索引。切换到首次使用的绑定时会执行与 `setup` 相同的历史回填确认；切回已完成的绑定时直接恢复原状态。refresh token 只进入 macOS Keychain，不写入 TOML、SQLite 或日志。

会话与图片只写入 `brain-hub/inbox/`。搜索的脱敏文本分块、向量、manifest 和 Drive change cursor 只保存在当前 Mac 的 SQLite 中，不写回 Drive。模型不可用时自动降级为关键词搜索，恢复后自动补齐缺失向量；Drive 刷新失败时保留旧 cursor 和最近有效索引并标记 stale。

## 升级与卸载

`hub_status` 最多每 24 小时查询一次 npm 最新版本。升级必须由用户主动执行：

```bash
npm install -g brainhub-mcp@latest
```

从不支持 Cursor 的旧版本升级后，运行一次 `brainhub-mcp setup` 或 `brainhub-mcp scheduler install`，以便用新的来源无关任务替换旧的三来源 launchd 参数。历史回填决定会保存当时获准的来源范围；旧版未完成回填重试时仍只处理原三来源，不会静默上传旧 Cursor 会话。如需回填，显式执行：

```bash
brainhub-mcp upload --sources cursor --backfill
```

完整卸载：

```bash
brainhub-mcp uninstall
```

卸载会移除 MCP 客户端注册、launchd、Google OAuth 授权、Keychain 凭据、配置、本地索引、状态和模型缓存。它不会删除或改写 Google Drive 与 Obsidian 中的任何内容。

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
