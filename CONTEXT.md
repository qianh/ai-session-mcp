# BrainHub Personal Data

BrainHub Personal Data defines the ownership and authorization language shared by local capture, retrieval, and publishing workflows.

## Language

**BrainHub**:
以用户自己的个人 Drive 为数据空间的个人 AI 知识产品。BrainHub 由可独立使用的 **BrainHub Capture** 和 **BrainHub MCP** 等组件组成。
_Avoid_: AI Session、Brain Capture

**BrainHub MCP**:
BrainHub 的本地会话采集与知识访问组件，负责上传 Claude Code、Codex CLI、Grok Build 和 Cursor 的本地 AI 编程会话、执行 **会话搜索**，以及读取和同步 **每日画像**。它不生成画像，不处理周报，也不使用卡片。
_Avoid_: brain-mcp、ai-session-mcp、Capture MCP

**Cursor 会话**:
Cursor 写入 `~/.cursor/projects/**/agent-transcripts/*/*.jsonl` 的本地 agent transcript。BrainHub MCP 只把 user 记录中 `<user_query>` 内的内容视为用户输入，丢弃动态工具、MCP 与 Hook 注入上下文，并保留助手可见内容；它不读取 Cursor 的私有 SQLite/KV 状态或 `agent-tools/`。
_Avoid_: state.vscdb 会话、Cursor 工具日志、任意 Cursor 项目文件

**会话搜索**:
从用户 **个人 Drive** 的 **Inbox 会话** 中查找相关内容，并返回摘要及 **会话引用**。搜索对象始终是会话，不包括卡片、其他蒸馏中间产物或未定义的归档目录。
_Avoid_: 卡片搜索、知识卡片检索、蒸馏搜索

**Inbox 会话**:
BrainHub Capture 与 BrainHub MCP 写入 `brain-hub/inbox/<device>/` 的会话内容，是第一版唯一的 Drive 会话集合。系统不创建 `sessions/`，也不自动移动或归档 Inbox 会话。
_Avoid_: sessions 目录、已处理会话、自动归档、待蒸馏队列

**本地语义搜索**:
使用设备上的固定版本嵌入模型理解查询与会话片段的语义关联。会话内容和查询不发送给远程模型 API，搜索索引也不写入个人 Drive。
_Avoid_: 云端 embedding、纯关键词搜索、生成式回答、Drive 搜索索引、维护者托管索引

**本地搜索索引**:
每台 MCP 设备根据 **Inbox 会话** 独立维护的可重建搜索状态，包括脱敏文本分块、向量、manifest 和 Drive 变更游标。索引不缓存图片，受当前系统用户文件权限保护，并在完整卸载时删除；它不是完整会话的权威来源。
_Avoid_: _meta/search、跨设备索引、图片缓存、权威内容源、Drive 迁移

**搜索降级**:
本地模型未就绪或加载失败时，`search_sessions` 继续执行关键词搜索，并明确返回关键词模式与降级警告。模型恢复后自动回到本地语义搜索。
_Avoid_: 搜索完全不可用、伪装成语义结果、自动调用云端模型

**索引新鲜度**:
`search_sessions` 查询前基于 Drive 变更游标增量刷新 **Inbox 会话** 索引。刷新失败时使用最近一次有效索引返回结果，并明确标记索引为 stale。
_Avoid_: 每次全量扫描、失败即无结果、隐瞒旧索引

**会话引用**:
由来源与来源内会话标识共同组成的稳定身份，用于在 **会话搜索** 后读取一条完整会话。会话引用不是 Drive 文件 ID 或路径。
_Avoid_: Drive ID、文件路径、只有 conversation_id

**完整会话读取**:
根据 **会话引用** 从 **Inbox 会话** 中返回一条完整会话原文的操作。完整会话读取不能访问任意 Drive 文件。
_Avoid_: 搜索结果展开、任意文件读取

**首次回填**:
首次设置时，在展示各来源会话数量和预计体积并获得确认后，上传设备上已发现的全部本地 AI 编程历史会话，并持久化本次获准的来源集合。用户拒绝首次回填时，从确认时刻开始只处理后续新增会话；未来新增来源不能继承旧回填授权。
_Avoid_: 静默上传、仅未来同步、子代理回填

**客户端自动注册**:
首次设置时，在展示并获得一次确认后，把 BrainHub MCP 注册到本机已检测到的受支持 CLI 客户端，并安装每日会话上传与 **画像同步** 任务。未安装的客户端被跳过，不导致设置失败。
_Avoid_: 注册所有已知客户端、缺失即失败、静默修改

**标准安装**:
用户通过 `npm install -g brainhub-mcp` 安装正式包，再运行 `brainhub-mcp setup` 完成 Google 授权、搜索模型预下载、首次回填确认、Obsidian vault 选择、客户端自动注册和定时任务安装。npm 安装阶段本身不发起交互授权。
_Avoid_: pnpm link、交互式 postinstall、克隆源码安装、手改客户端配置

**可恢复设置**:
可以安全中断并重复运行的 `setup` 流程。再次运行时识别已完成步骤，只继续缺失或失败的步骤，不重复授权、客户端注册、定时任务或已完成的首次回填。
_Avoid_: 全部重跑、失败后清空、重复注册、重复回填

**搜索模型预下载**:
`setup` 默认下载并缓存 **本地语义搜索** 所需的固定版本模型，同时向用户显示下载体积、实时进度和缓存位置。模型不在首次搜索时才静默下载；下载失败时其他安装步骤继续完成，运行状态提供失败原因和重试入口。
_Avoid_: 首次搜索下载、静默下载、远程推理、阻断其他功能

**官方发行物**:
由 BrainHub 维护者发布到 npm 的 BrainHub MCP，使用经维护和验证的官方 OAuth 应用身份，为普通用户提供 **零配置授权**。
_Avoid_: 源码构建、第三方修改版、用户自建 OAuth

**源码构建**:
用户自行从源码或 fork 构建的 BrainHub MCP。源码构建必须使用构建者自己的 Google Cloud OAuth 应用身份，不能默认作为 **官方发行物** 运行。
_Avoid_: 官方 npm 包、复用官方 OAuth 身份

**每日画像**:
由其他产品每天覆盖生成在 My Drive 根目录 `/Digital_Twin_Profile.md` 的文件，是 **BrainHub MCP** 唯一读取和同步的外部发布结果。不存在与之配套的周报或卡片。
_Avoid_: 周报、卡片、MCP 产物

**画像来源路径**:
My Drive 根目录下唯一且固定的 `/Digital_Twin_Profile.md`。BrainHub MCP 只读取这个精确路径，不读取 `brain-hub/` 内的同名文件，也不在整个 Drive 搜索同名文件。
_Avoid_: brain-hub/Digital_Twin_Profile.md、同名文件搜索、可配置画像路径

**画像读取**:
`get_portrait` 读取完整的最新 **每日画像** 并把内容返回给 MCP 客户端的无副作用操作。不存在单独的拉取或 Diff 工具，画像读取不写入 Obsidian。
_Avoid_: pull_portrait、画像 Diff、画像同步、顺带刷新

**画像同步**:
每日后台任务把最新 **每日画像** 原子覆盖写入安装时选定的固定 Obsidian vault 中的 `BrainHub/portrait.md`。画像同步不保存历史版本、不切换到最近使用的 vault，也不是 `get_portrait` 的副作用。
_Avoid_: 画像读取、手动拉取、最近 vault、历史快照、周报同步

**Obsidian 集成**:
用户可选的每日画像本地同步能力。没有检测到 vault 或用户暂不选择时，标准安装仍然完成，`get_portrait` 仍可用，但不安装画像同步任务；之后可以通过可恢复设置补齐。
_Avoid_: MCP 安装前提、画像读取前提、自动选择最近 vault

**运行状态**:
`hub_status` 返回当前 Google 账号、BrainHub 根目录、会话上传、定时任务、每日画像存在性和最近一次 Obsidian 同步结果的只读诊断信息。运行状态不包含卡片、蒸馏或周报状态。
_Avoid_: 内容搜索、配置修改、卡片状态、蒸馏状态、周报状态

**MCP 升级**:
`hub_status` 最多每日向 npm 查询一次新版本并提示，用户通过 `npm install -g brainhub-mcp@latest` 主动升级。BrainHub MCP 不安装自更新后台程序；新版本首次运行时事务化迁移本地配置和索引。
_Avoid_: 静默自更新、维护者更新服务、非事务迁移、破坏旧状态

**Drive 内容稳定性**:
BrainHub MCP 已上传到个人 Drive 的会话是用户内容，不属于组件升级状态。MCP 升级只处理本机配置、缓存和可重建索引，不批量迁移、改写、移动或删除 Drive 历史内容。
_Avoid_: 内容迁移、升级时重写、远端格式升级

**公开工具集**:
BrainHub MCP 首个公开版本仅提供 `upload_sessions`、`search_sessions`、`get_session`、`get_portrait` 和 `hub_status`。这是干净的新契约，不保留内部原型中的旧工具或无效参数别名。
_Avoid_: pull_portrait、include_original、兼容别名、卡片工具、周报工具

**个人 Drive**:
用户在授权时所选择 Google 账号对应的个人数据空间。写入其中的 BrainHub 数据归该用户所有，应用发行方不是数据所有者。
_Avoid_: BrainHub 云盘、发行方云盘、共享后端

**BrainHub 根目录**:
每个 Google 账号的 My Drive 根目录下唯一的 `brain-hub` 文件夹。BrainHub Capture 与 BrainHub MCP 复用该目录保存采集和上传的内容，用户不能为单个组件改用其他路径；画像来源路径不在该目录内。
_Avoid_: 自定义目录、组件专属根目录、多个 brain-hub

**根目录冲突**:
My Drive 根目录下同时存在多个 `brain-hub` 时的阻塞状态。用户必须明确选择其中一个作为 **BrainHub 根目录**；系统不自动合并、删除或猜测使用哪个目录。
_Avoid_: 自动选最新、自动合并、清理重复目录

**零配置授权**:
用户只需选择自己的 Google 账号并同意所需权限即可开始使用的授权体验。普通用户不创建 Google Cloud 项目，也不提供 OAuth 客户端配置。
_Avoid_: 自带 OAuth、开发者配置、手工凭据安装

**安全凭据存储**:
保存 Google 长期授权凭据的 macOS Keychain。`setup` 在授权前验证 Keychain 可用性，不允许把 refresh token 明文写入配置或普通文件。
_Avoid_: 明文 token、文件权限降级、自建凭据文件

**正式支持系统**:
BrainHub MCP 第一版正式支持 macOS，并使用 Keychain、launchd 与 macOS 平台路径完成零配置安装。Linux 和 Windows 不属于第一版的安装、测试或支持承诺。
_Avoid_: Linux、Windows、跨平台承诺、systemd

**当前 MCP 账号**:
一份 BrainHub MCP 配置在任一时刻绑定的唯一 Google 账号。用户可以显式切换当前 MCP 账号，各账号的 Drive 根目录、上传水位和重试状态彼此隔离。
_Avoid_: 多账号并发、共享水位、Capture 账号

**MCP 设备**:
安装 BrainHub MCP 的一台 macOS 设备。每台设备具有不可变的设备 ID 和可修改的显示名称；主机名只用于生成初始显示名称，不能作为远端会话身份。
_Avoid_: 主机名身份、账号身份、可变设备 ID

**跨设备会话**:
同一 Google 账号下由一个或多个 **MCP 设备** 发现的本地 AI 编程会话。远端以来源和来源内会话标识去重，使多台设备上传同一会话时收敛为一条内容。
_Avoid_: 按设备复制会话、按文件路径去重、按主机名去重

**账号切换**:
通过重新授权改变 **当前 MCP 账号** 的操作。首次切到一个账号时执行默认 **首次回填**，切回已使用账号时恢复该账号原有水位；账号切换不删除任何 Drive 数据。
_Avoid_: 新增第二活跃账号、清空旧 Drive、沿用其他账号水位

**完整卸载**:
`brainhub-mcp uninstall` 经用户确认后撤销 Google 授权，注销已安装的客户端配置和定时任务，并删除本地凭据、索引、缓存与运行状态。完整卸载不删除 **BrainHub 根目录**、其中的内容或已写入 Obsidian 的画像。
_Avoid_: npm 卸载脚本、删除 Drive 数据、删除 Obsidian 文件、残留后台任务

## Example dialogue

> 开发：用户要先创建 Google Cloud 项目，才能连接自己的 Drive 吗？
>
> 领域专家：不需要。普通用户只选择自己的 Google 账号并同意授权；数据仍写入该用户的个人 Drive。

> 开发：可以为了以后支持 Linux，把 refresh token 暂时写到 0600 文件吗？
>
> 领域专家：不可以。第一版只支持 macOS Keychain，不提供明文凭据降级。
>
> 开发：应用发行方会代用户保存这些数据吗？
>
> 领域专家：不会。应用只连接用户选择的个人 Drive，发行方不是数据所有者。

> 开发：MCP 可以使用与 Capture 不同的 Drive 文件夹吗？
>
> 领域专家：不可以。同一账号上的所有 BrainHub 组件都复用唯一的 BrainHub 根目录。

> 开发：发现两个同名根目录时，可以选最新的继续写吗？
>
> 领域专家：不可以。进入根目录冲突，等用户明确选择；其他目录保持不变。

> 开发：用户从账号 A 切到账号 B 后，还沿用 A 的上传水位吗？
>
> 领域专家：不沿用。每个账号独立保存水位；首次使用 B 时回填，切回 A 时恢复 A 的进度。

> 开发：两台同名电脑上传同一个本地 AI 编程会话时，要保留两个副本吗？
>
> 领域专家：不要。设备 ID 彼此独立，但同一来源中的同一会话应收敛为一条内容。

> 开发：完整卸载时要顺便清空 Drive 和 Obsidian 吗？
>
> 领域专家：不要。完整卸载只撤销访问并清理本机运行痕迹，用户内容始终保留。
>
> 开发：BrainHub MCP 必须和浏览器扩展一起安装吗？
>
> 领域专家：不需要。它们是 BrainHub 的独立组件，同时使用时通过用户的个人 Drive 协作。
>
> 开发：搜索时要优先返回 cards 里的摘要吗？
>
> 领域专家：不要。BrainHub MCP 只搜索 Inbox 会话；cards 与它没有关系。

> 开发：上传到 inbox 的会话之后要自动移动到 sessions 目录吗？
>
> 领域专家：不要。第一版只有 Inbox 会话，不存在 sessions 目录生命周期。

> 开发：语义搜索会把会话发送到云端模型吗？
>
> 领域专家：不会。模型和搜索索引都只在 MCP 设备本地运行与保存。

> 开发：为了多设备复用，可以把向量索引写到 Drive 的 _meta/search 吗？
>
> 领域专家：不要。每台设备独立维护可重建的本地搜索索引，Drive 只保存用户内容。

> 开发：本地索引可以缓存完整图片或替代 Drive 返回完整会话吗？
>
> 领域专家：不可以。索引只缓存脱敏文本分块和检索状态，get_session 始终从 Drive 读取完整会话。

> 开发：模型暂时加载失败时，search_sessions 要直接报错吗？
>
> 领域专家：不要。返回明确标记的关键词降级结果，模型恢复后再自动使用语义搜索。

> 开发：Drive 暂时不可用时，搜索必须直接失败吗？
>
> 领域专家：不要。使用最近一次有效索引，并明确告诉客户端索引已经 stale。
>
> 开发：搜索摘要不够时，怎样取得完整会话？
>
> 领域专家：使用搜索结果里的来源和会话标识调用完整会话读取，不要直接传 Drive 文件 ID。
>
> 开发：第一次安装只上传之后产生的新会话吗？
>
> 领域专家：默认执行首次回填，但必须先展示数量与预计体积并获得用户确认。
>
> 开发：某台电脑只安装了 Codex，设置时还要注册 Claude 和 Grok 吗？
>
> 领域专家：不要。客户端自动注册只修改实际检测到的受支持客户端。

> 开发：npm 安装完成时要在 postinstall 里立刻打开浏览器授权吗？
>
> 领域专家：不要。安装后由用户显式运行一次 setup，所有首次设置步骤都在该流程中完成。

> 开发：setup 下载模型时中断，重新运行要从授权步骤全部重来吗？
>
> 领域专家：不要。可恢复设置只继续未完成或失败的步骤。

> 开发：可以等用户第一次搜索时再静默下载模型吗？
>
> 领域专家：不要。setup 默认预下载，并明确显示大小和进度。

> 开发：模型下载失败后要撤销授权并终止整个安装吗？
>
> 领域专家：不要。继续完成其他步骤，只把语义搜索标记为暂不可用并允许重试。

> 开发：从 fork 自行构建时也能直接使用 BrainHub 官方 OAuth 身份吗？
>
> 领域专家：不能。零配置授权属于官方发行物；源码构建者必须配置自己的应用身份。
>
> 开发：画像和周报也由 BrainHub MCP 生成吗？
>
> 领域专家：不是。另一个产品每天覆盖生成唯一的每日画像；这里没有周报，BrainHub MCP 也不生成画像。

> 开发：get_portrait 要在 brain-hub 或整个 Drive 中查找同名画像吗？
>
> 领域专家：不要。它只读取 My Drive 根目录的 /Digital_Twin_Profile.md。
>
> 开发：调用 get_portrait 会顺便更新 Obsidian 或只返回 Diff 吗？
>
> 领域专家：不会。它只返回完整画像；只有每日画像同步任务写入 Obsidian。
>
> 开发：用户后来打开另一个 vault，画像同步要改写到那里吗？
>
> 领域专家：不要。每日任务始终覆盖安装时选定 vault 中的同一个画像文件。

> 开发：用户没有安装 Obsidian 时，MCP setup 应该失败吗？
>
> 领域专家：不要。跳过 Obsidian 集成并完成其他步骤，用户以后可以再配置。

> 开发：hub_status 还要显示 cards、蒸馏和周报进度吗？
>
> 领域专家：不要。它只报告 BrainHub MCP 自己负责的上传、读取和同步运行状态。

> 开发：MCP 可以在后台自动替换全局 npm 包吗？
>
> 领域专家：不要。只提示 npm 新版本，由用户主动升级。

> 开发：MCP 升级时要给 Drive 会话增加新版本字段吗？
>
> 领域专家：不要。组件升级与用户内容无关，只迁移必要的本机状态。

> 开发：公开版本要继续保留 pull_portrait 兼容旧客户端吗？
>
> 领域专家：不要。公开工具集是新的稳定边界，旧原型接口直接移除。
