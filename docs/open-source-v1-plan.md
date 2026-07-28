# BrainHub MCP 开源 v1 改造计划

## 目标

通过 npm 独立发布仅支持 macOS 的 BrainHub MCP。普通用户运行 `npm install -g brainhub-mcp` 和 `brainhub-mcp setup`，即可连接自己选择的 Google 账号，上传 Claude Code、Codex CLI 与 Grok Build 会话，搜索和读取 `inbox/` 会话，并读取 My Drive 根目录的 `/Digital_Twin_Profile.md`。

## P0：包与公开 API

- 将 npm 包、bin、MCP server、配置目录和用户文档中的 `brain-mcp` 统一为 `brainhub-mcp`；仓库名可以继续使用 `ai-session-mcp`。
- 删除 `private: true`，增加 `license: Apache-2.0`、`files` 白名单、`repository`、`homepage`、`bugs`、`keywords` 和标准 `LICENSE`。
- 将 Node 要求修正为 `>=22.12.0`，在最低版本和当前 Node 22 LTS 的干净 macOS 环境验证原生依赖安装。
- 第一版删除 Linux Secret Service、systemd、Linux 路径和相关正式支持表述，只保留 macOS Keychain 与 launchd。
- MCP server 只公开 `upload_sessions`、`search_sessions`、`get_session`、`get_portrait`、`hub_status`。
- 删除 `pull_portrait`、`include_original`、cards、周报、蒸馏、`sessions/` 和旧服务名，不提供兼容别名。

## P1：授权、账号与 setup

- 官方 npm 包内置经维护的 Desktop OAuth 配置；源码构建和 fork 必须提供自己的 Google Cloud OAuth Client。
- 保留完整 Drive scope，用于读取其他产品之后创建的 `/Digital_Twin_Profile.md`；完成 restricted-scope OAuth 验证与所需安全审查。
- refresh token 只存入 macOS Keychain；授权前先验证 Keychain，不提供明文文件降级。
- 新增幂等、可恢复的 `brainhub-mcp setup`，分步记录授权、模型、回填、Obsidian、客户端和 launchd 状态。
- setup 默认下载固定版本本地 E5 模型并显示大小、进度和缓存路径；失败时继续其他步骤并提供重试。
- 扫描三类 CLI 后展示每类会话数量和预计字节数，一次确认后默认回填；拒绝则建立当前水位，只上传未来会话。
- 自动注册本机已检测到的 Claude Code、Codex CLI、Grok Build，并安装每日上传任务；缺失客户端不报错。
- Obsidian 为可选步骤；选择后固定写入 `<vault>/BrainHub/portrait.md` 并安装独立画像同步任务。
- 一份配置只绑定一个当前 Google 账号；切换账号时按账号隔离 root ID、水位和重试状态，切回时恢复原状态。

## P2：Drive 与会话生命周期

- 每个账号只绑定 My Drive 根目录下唯一的 `brain-hub/`，按 folder ID 操作；同名冲突必须由用户选择。
- Capture 与 MCP 的所有会话只写入 `brain-hub/inbox/<device>/`，图片只写入 inbox 资产目录。
- 远端会话身份固定为 `source + conversation_id`；多台 macOS 设备并发上传时收敛为一个最新快照。
- 不创建、读取或迁移 `sessions/`，不因组件升级批量改写、移动或删除任何 Drive 内容。
- `get_session` 只接受搜索返回的 `{source, conversation_id}`，从 inbox 返回完整会话，拒绝任意 Drive file ID 或路径。

## P3：本地搜索

- 删除 Drive `_meta/search/`；向量、脱敏文本分块、manifest 和 Drive change cursor 全部存入每台设备的本地 SQLite。
- `search_sessions` 只索引 inbox 会话；查询前消费 Drive 变更游标，增量处理新增、修改、移动和删除。
- 正常模式使用固定版本 `Xenova/multilingual-e5-small` 本地语义搜索，不把会话或查询发送到远程模型 API。
- 模型不可用时返回关键词结果，并明确设置 `search_mode: keyword` 与降级警告。
- Drive 刷新失败时使用最近有效本地索引，并明确设置 `index_status: stale`。
- 完整卸载删除本地文本索引和模型缓存；`get_session` 始终以 Drive 为权威内容源。

## P4：画像与状态

- `get_portrait` 只读取 My Drive 根目录精确路径 `/Digital_Twin_Profile.md`，返回完整内容且无本地写入副作用。
- 文件未生成时返回稳定的 not-found 错误，不影响授权、上传或搜索。
- 每日 launchd 任务原子覆盖固定 Obsidian 路径；失败时保留旧文件并在下次任务重试，不保留历史版本。
- `hub_status` 只报告当前账号、root、上传、模型/索引、launchd、画像存在性和 Obsidian 同步结果。

## P5：卸载、升级与发布

- 新增 `brainhub-mcp uninstall`：一次确认后注销客户端、移除 launchd、撤销 Google 授权并删除本地配置、凭据、索引、缓存和状态；保留 Drive 与 Obsidian 内容。
- 不安装自更新器；`hub_status` 最多每日查询一次 npm 新版本，用户主动运行 `npm install -g brainhub-mcp@latest`。
- 本地配置和索引迁移必须事务化；失败时保留旧状态并停止不兼容版本，绝不迁移 Drive 内容。
- 补充 `SECURITY.md`、`CONTRIBUTING.md`、隐私说明、OAuth 数据使用/删除说明、故障排查和 changelog。
- 使用 npm trusted publishing、provenance、2FA 和最小 `files` 白名单；发布前执行 `npm pack --dry-run` 并在干净 macOS 用户环境安装 tarball。

## 验收

- 全新 macOS 用户仅用两条标准命令完成 setup；流程中断后重跑不会重复回填、注册或创建 launchd job。
- 五个 MCP 工具的协议测试覆盖正常、未授权、账号切换、stale、关键词降级、画像缺失和超长内容。
- 两台 macOS 设备对同一账号并发上传不会产生逻辑重复会话。
- npm tarball 不含测试、开发 OAuth 配置、源码缓存或本机路径，安装后 bin 与原生依赖可直接运行。
- 测试、类型检查、lint、格式、构建、npm pack 安装冒烟和 macOS launchd 集成测试全部通过。
