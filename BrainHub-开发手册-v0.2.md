# 个人 AI 数据中心 · 开发手册 v0.2(定稿)

> 代号:**Brain Hub**
> 一句话定义:以 Google Drive 为唯一全量存储,自动聚合所有 AI 会话,通过 L1–L3 蒸馏管道持续生成"自我画像",让数据记录自己、反馈自己。
>
> v0.2 变更:①执行器定为 Codex Cloud 自动化(移除模型 API 方案);②Obsidian 改为 MCP 拉取式更新(移除同步插件方案);③新增订阅制约束。

---

## 0. 系统总览

### 0.1 硬约束(所有模块必须遵守)

| # | 约束 | 含义 |
|---|------|------|
| C1 | 多终端 | 用户在多台电脑 + 手机间切换,任何模块不得假设"某台特定机器在线" |
| C2 | 无本地持久化 | 终端设备不保存历史数据;唯一例外是 Obsidian vault 中一份**每期覆盖**的最新蒸馏结果 |
| C3 | Drive 唯一全量 | Google Drive(5T)是唯一数据主存储,按 5T 上限做长期设计 |
| C4 | 全自动 | 采集与蒸馏链路无人工介入;仅 Obsidian 更新为低频手动拉取(用户明确接受) |
| C5 | 暂不删数据 | 本期只做容量水位监控与告警,不做清理/降级 |
| C6 | 只用订阅制 AI | 不使用任何按量付费的模型 API;AI 能力全部来自订阅产品额度 |
| C7 | Claude 不进关键路径 | 因封号风险,Claude 系产品不承担任何无人值守职责 |
| C8 | Obsidian 保持纯净 | 不安装同步类插件,vault 只作记录用途 |

### 0.2 架构与数据流

```
┌─ 模块一:本地 MCP(每台电脑)──┐
│  CLI 会话(claude code/codex…) │──move──▶ Drive:/inbox/<device>/
└───────────────────────────────┘
┌─ 模块二:浏览器插件(每个浏览器)┐
│  Web 会话(claude/chatgpt/…)   │──push──▶ Drive:/inbox/web-<profile>/
└───────────────────────────────┘
                                      │
                ┌─ 模块三:Codex Cloud 自动化(纯云端)────┐
                │ 每日: inbox → 规整/去重/抽图 → L1 卡片 │
                │ 每周: L2 周报 → L3 自画像(diff 增量)   │
                │ 发布: 覆盖写 Drive:/publish/ + 更新     │
                │       2 个固定 Google Doc               │
                └─────────────────────────────────────────┘
                                      │
        ┌──────────────┬──────────────┴──────────────┐
   NotebookLM     网页版 AI(Drive 连接器)    模块一 MCP 拉取
  (挂2个固定Doc,                          (pull_portrait 手动更新
   打开时点 sync)                           Obsidian;get_portrait
                                            对话时直读+顺手刷新)
```

### 0.3 Drive 目录规范

```
gdrive:brain-hub/
├── inbox/                  # 采集落地区,蒸馏后清空
│   ├── <device-name>/      # 模块一写入
│   └── web-<profile>/      # 模块二写入
├── sessions/YYYY-MM/       # 规整后的原始会话(Markdown)
├── images/sha256/xx/…webp  # 内容寻址图片库(全局去重)
├── cards/YYYY-MM/          # L1 卡片
├── weekly/                 # L2 周报(+合并大文件供 NotebookLM)
├── publish/                # 对外发布区
│   ├── portrait.md         # L3 自画像·最新版(覆盖式)
│   └── weekly-latest.md    # 最新周报(覆盖式)
└── _meta/                  # 水位报告、运行状态、去重索引
```

### 0.4 统一会话格式(采集端输出契约)

文件名:`{source}-{YYYYMMDD}-{conversation_id前8位}.md`

```markdown
---
source: claude-code | codex | claude-web | chatgpt-web | gemini-web | grok-web
conversation_id: <原始ID>
device: <设备/浏览器profile名>
started_at / updated_at: ISO8601
turn_count: N
---
## User
…
## Assistant
…(图片替换为 ![](images/sha256/xx/xxxx.webp) 引用;网页端图片本期保留 URL)
```

> 两个采集模块只负责产出符合此契约的文件;蒸馏模块只消费此契约。三个模块可完全并行开发。

---

## 模块一:本地 MCP 服务(brain-mcp)

### 1.1 产品说明

**目标**:在任意一台电脑上,通过 MCP 完成四件事——上传本机 CLI 会话、检索 Drive 历史沉淀、AI 对话时读取画像、手动拉取蒸馏结果更新 Obsidian。

**用户故事**
- 我不做任何操作,本机新产生的 CLI 会话每天自动进入 Drive inbox
- 我在对话中问"我上个月研究过哪些部署方案",AI 通过 MCP 检索会话库回答
- 我说"结合我的画像给建议",AI 读到最新画像
- 每周蒸馏完成后,我说一句"更新我的画像",最新结果写入 Obsidian,并当场看到本期变化

### 1.2 技术方案

**形态**:单个 Node.js/TypeScript MCP Server(stdio),注册到 Claude Desktop / Codex 等 MCP 客户端;附带 launchd/systemd 定时器每日调用上传逻辑(上传不依赖 AI 客户端打开)。

**MCP 工具清单**

| 工具 | 功能 | 说明 |
|------|------|------|
| `upload_sessions` | 扫描本机各 CLI 会话目录 → 转统一格式 → 抽图去重 → 上传 inbox → 清空本地暂存 | 幂等:按 conversation_id+updated_at 水位增量 |
| `search_sessions` | 关键词/时间范围检索 Drive 的 cards+sessions | 优先搜 cards(信息密度高),命中后按需取原文 |
| `get_portrait` | 返回最新自画像供 AI 对话使用 | **直读 Drive:/publish/ 最新版**,并静默刷新 vault 副本——对话永远用最新,且减少手动拉取需求 |
| `pull_portrait` | 手动更新 Obsidian:拉取 publish/ 覆盖写入 `<vault>/BrainHub/` | **返回值直接展示 L3 的"变更 Diff"段落**,拉取动作同时是每周自我回顾 |
| `hub_status` | 返回 inbox 积压、上次蒸馏时间、容量水位 | 读 Drive:/_meta/ |

**会话源适配器**(可插拔)

| 来源 | 本地路径 | 格式 |
|------|----------|------|
| Claude Code | `~/.claude/projects/**/*.jsonl` | jsonl,含 base64 图片 |
| Codex CLI | `~/.codex/sessions/` | jsonl |
| Gemini CLI | 待确认 | — |

**图片处理**:抽出 base64 → sha256 → 查 `_meta/image-index.json` 去重 → 新图转 WebP(质量80)上传 → 正文替换为引用。

**Drive 访问**:内嵌 rclone 或 googleapis SDK,OAuth 凭证存系统钥匙串。上传语义一律 `move`,成功校验后即删本地(C2)。

**Obsidian 写入**:仅 `pull_portrait` / `get_portrait` 写 `<vault>/BrainHub/` 目录,覆盖式,不触碰 vault 其他内容(C8)。

### 1.3 验收标准

- 新会话 24h 内到达 inbox;本机除 vault/BrainHub 外无残留;重复上传零重复
- 四个工具在 MCP 客户端中可自然语言触发;`pull_portrait` 返回可读的本期 diff

---

## 模块二:浏览器插件(brain-capture)

### 2.1 产品说明

**目标**:自动捕获 claude.ai / chatgpt.com / gemini / grok 网页端会话上传 Drive。手机端会话与网页端同账号同步,由任一电脑浏览器代为捕获,手机零部署。

### 2.2 技术方案

**形态**:Chrome MV3 扩展。

**捕获策略(双路径)**
1. **主路径·定时拉取内部会话 API**:每 30 分钟(页面空闲时)带登录态调用各站内部接口(如 ChatGPT `backend-api/conversations`),按 `updated_at` 水位增量拉取。可补拉、不依赖实时监听。
2. **兜底路径·fetch 拦截**:注入脚本 monkey-patch `fetch`,从 SSE 流攒取当次对话,应对内部 API 改版的过渡期。

**站点适配器**:每站一个 adapter(会话列表接口/详情接口/鉴权/响应映射),改版只改对应 adapter。

**上传**:扩展内转统一格式后经 Drive API(chrome.identity OAuth,`drive.file` 最小权限)写入 `inbox/web-<profile>/`。扩展本地仅存水位游标(IndexedDB),不存会话内容(C2)。

**图片**:本期保留 URL 引用,不在扩展内下载;实体归档由模块三在云端按需拉取。

### 2.3 风险与对策

| 风险 | 对策 |
|------|------|
| 内部 API 非公开、随时改版 | adapter 隔离 + 兜底路径 + 扩展角标告警 |
| ToS 灰色地带 | 仅个人自用、低频轮询、不分发 |
| 多设备重复捕获 | conversation_id 全局唯一,蒸馏端按 id 去重,天然幂等 |

### 2.4 验收标准

- 四站点新会话在下一轮询周期内入库,零重复;单站失效不影响其他站点且有告警

---

## 模块三:云端定时蒸馏(brain-distill)

### 3.1 产品说明

**目标**:每日将 inbox 原始会话规整并蒸馏为 L1 卡片;每周聚合 L2 周报、增量更新 L3 自画像;发布到 Drive 供三类消费端使用。全程零本地、零 API 付费,AI 能力来自 ChatGPT 订阅额度。

### 3.2 执行器:Codex Cloud 自动化(定稿)

**选型结论**(约束 C1/C6/C7 叠加后的唯一完整解):

| 候选 | 判定 |
|------|------|
| **Codex Cloud 自动化** | ✅ 云端沙箱执行、连接 GitHub 仓库、可跑脚本、支持定时自动化、订阅内含 |
| ChatGPT 计划任务 | ❌ 提醒级,无文件操作,不活跃自动暂停 |
| Claude Code /schedule | ❌ C7 排除 |
| Grok Build / Grok Tasks | ❌ 本地执行 / 提醒级 |
| Google Jules + Gemini | 备选:与 Drive 同生态,定时能力待验证 |

**职责**:Codex 自动化承担全部——数据搬运(inbox 规整、按 conversation_id 去重、网页图片归档)与 L1–L3 蒸馏推理,消耗订阅额度,不涉及任何 API 计费。

**兜底方案(不违反 C6)**:若 M0 验证发现 Codex 定时自动化绑定桌面 App 在线,则用 GitHub Actions 作纯"闹钟"——定时在仓库产生触发事件,经 Codex 的 GitHub 集成唤起云端任务执行。GitHub Actions 本身不含 AI、免费,AI 能力仍 100% 来自订阅。

### 3.3 仓库与任务编排

**GitHub 私有仓库 `brain-pipeline`**(Codex 云任务的工作目录):

```
brain-pipeline/
├── prompts/L1.md L2.md L3.md      # 已交付的三个蒸馏模板
├── pipeline/
│   ├── ingest.md     # 规整任务说明:inbox→去重→sessions/、图片归档
│   ├── distill.md    # 蒸馏任务说明:按 prompts 执行 L1/L2/L3
│   ├── publish.md    # 发布任务说明:更新 Google Docs + 覆盖 publish/
│   └── watermark.md  # 水位任务说明:读容量→写 _meta/→超阈值告警
├── scripts/          # 上述任务用到的辅助脚本(rclone 封装等)
└── AGENTS.md         # Codex 执行规范:目录契约、幂等要求、失败处理
```

> 说明:Codex 自动化以自然语言任务+仓库脚本混合驱动,AGENTS.md 约束其行为边界;所有任务要求幂等,失败保留现场并在 _meta/ 留错误记录。

**任务计划**

| 自动化 | 频率 | 内容 |
|--------|------|------|
| daily-distill | 每日 03:00 | ingest → L1 → watermark |
| weekly-distill | 每周日 04:00 | L2 → L3(单周波动不改画像)→ publish |

**凭证**:Drive 凭证以 Codex 环境 secrets 注入,不进仓库、不进任务描述。

### 3.4 M0 待验证清单(开发前置,预计 1 天)

1. **生死题**:Codex 定时自动化在所有设备关机、桌面 App 未开时是否照常执行(测试法:建一个"往 Drive 写时间戳文件"的定时任务,关机过夜验证)。失败→启用 3.2 兜底
2. Codex 云端沙箱能否网络直连 Drive API / 运行 rclone
3. 单次任务的执行时长与额度消耗,推算每日批量的可行规模

### 3.5 消费端衔接

- **Obsidian(拉取式,C8)**:蒸馏结果不主动推送到任何设备;用户在 MCP 客户端说"更新画像"触发 `pull_portrait`,覆盖写 vault 并返回本期 diff。`get_portrait` 在 AI 对话时直读 Drive 最新版并顺手刷新 vault,进一步降低手动频率
- **NotebookLM**:挂 publish 对应的 2 个固定 Google Doc,打开时点 sync 即最新
- **网页版 AI**:经 Drive 连接器直接检索 publish/ 与 weekly/

### 3.6 验收标准

- 连续 7 天全设备关机状态下,cards/weekly/portrait 按时更新,inbox 清空
- `pull_portrait` 后,Obsidian 内容与 Drive:/publish/ 一致且展示本期 diff
- NotebookLM 两个 Doc 点 sync 后为最新

---

## 模块四:容量水位监控(本期只告警,不删数据)

- watermark 任务随每日自动化执行:读取 Drive 已用/总量,追加写 `_meta/capacity.jsonl`,并统计各目录占比("谁在吃空间")
- 告警阈值:70% 一次性 / 85% 每日 / 95% 每次运行;通道:邮件通知
- 生命周期治理(温冷分级、图片降采样、水位驱动降级)设计已备,70% 告警触发后再立项开发

---

## 附录

### A. 里程碑

| 阶段 | 内容 | 交付判定 |
|------|------|----------|
| M0(1天) | 3.4 验证清单 | Codex 关机定时写 Drive 成功(或确认走兜底) |
| M1(1周) | 模块一:Claude Code adapter + upload_sessions | 本机会话自动进 inbox |
| M2(1周) | 模块三 daily-distill(ingest+L1) | cards/ 每日增长 |
| M3(1周) | weekly-distill + publish + pull_portrait | 说"更新画像"后 Obsidian 见到最新版及 diff |
| M4(2周) | 模块二插件(先 ChatGPT+Claude 两站) | 网页会话入库 |
| M5 | search_sessions、hub_status、模块四告警、其余 adapter 与站点 | — |

### B. 全局风险清单

1. **OpenAI 账号单点(结构性,已知情接受)**:C6+C7 约束下的必然代价;缓解:账号安全加固(两步验证、支付与登录环境稳定),GitHub 闹钟兜底可快速切换触发方式,蒸馏产物多端可读不受影响
2. 网页端内部 API 改版(高频低危):adapter 化 + 告警 + 补拉
3. Google 账号单点(低频高危):两步验证 + 实体密钥;portrait 在 vault 有副本
4. 隐私:ingest 阶段统一脱敏(客户名/密钥/内网地址→占位符),在数据进入 sessions/ 前完成
