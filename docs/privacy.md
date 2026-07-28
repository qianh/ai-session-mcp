# 数据、隐私与删除

BrainHub MCP 在用户自己的 Mac 上运行，不经过 BrainHub 采集服务器，也不包含产品遥测或远程崩溃上报。

## 读取与上传

MCP 只读取 Claude Code、Codex CLI 和 Grok Build 的顶层会话。默认排除 system/developer prompt、隐藏推理、工具参数和结果、环境快照、shell 输出与子代理会话。原始文件始终只读。

上传前会处理 bearer token、密码赋值、私钥、常见 API key、凭据 URL，以及用户配置的内部域名和 CIDR。规范化后的会话与图片只写入所选 Google 账号的 `brain-hub/inbox/`。

## 本地数据

- Google refresh token：macOS Keychain。
- 配置、上传水位和重试状态：账号隔离的本地状态目录。
- 搜索：本地 SQLite 中的脱敏文本分块、向量、manifest 和 Drive change cursor。
- 模型：本地 Hugging Face 模型缓存。
- Obsidian：可选的固定 `BrainHub/portrait.md`。

`get_session` 每次从 Drive 读取权威全文。`get_portrait` 只读取 My Drive 根目录的 `Digital_Twin_Profile.md`，不会自动写 Obsidian。

## 网络请求

产品只连接完成所选功能所需的服务：Google OAuth、Google Drive API、首次模型下载所需的 Hugging Face，以及用户调用 `hub_status` 时最多每 24 小时一次的 npm 最新版本查询。会话和搜索查询不会发送给远程模型 API。

## 授权与删除

`brainhub-mcp auth logout` 撤销当前 Google 授权并清除账号绑定。`brainhub-mcp uninstall` 还会移除客户端注册、launchd、Keychain 凭据、配置、状态、索引和模型缓存。

这些命令都不会删除或改写 Google Drive 与 Obsidian 内容。用户如需删除云端数据，应直接在自己的 Drive 中操作；如需删除画像副本，应直接删除 vault 中的 `BrainHub/portrait.md`。
