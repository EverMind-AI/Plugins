# ArtEmis：面向 Google Antigravity 的 EverOS 记忆插件

为 **Google Antigravity** 打造的跨会话、自进化长期认知记忆插件，底层对接 [EverOS](https://github.com/EverMind-AI/EverOS) 认知记忆引擎（本地默认 `http://127.0.0.1:8000`）。

严格遵循 EverOS v2 后端协议（`/api/v2/memory/*`），采用**纯 ESM 架构、零第三方运行时依赖（Zero-Dependency）**，深度兼容 Windows 11 环境，并引入首创的**三层渐进式披露（Three-Tier Progressive Disclosure）**上下文组装机制。

---

## 目录

- [一、 认知动力源：双模型前置配置（重要！）](#一-认知动力源双模型前置配置重要)
- [二、 部署指南：AI Agent 一键式自动装配 Prompt](#二-部署指南ai-agent-一键式自动装配-prompt)
- [三、 手动安装指南](#三-手动安装指南)
- [四、 核心功能与架构特性](#四-核心功能与架构特性)
- [五、 四大分类锚点（中英双语自适应）](#五-四大分类锚点中英双语自适应)
- [六、 原生 MCP 工具与统一运维控制台](#六-原生-mcp-工具与统一运维控制台)
- [七、 环境变量配置参考](#七-环境变量配置参考)
- [八、 自动化验收套件与实证](#八-自动化验收套件与实证)
- [开源协议](#开源协议)

---

## 一、 认知动力源：双模型前置配置（重要！）

> [!IMPORTANT]
> **认知引擎双模型依赖说明**：
> 本插件（前端适配层）遵循纯 ESM 架构，**没有任何第三方运行时依赖**且原生具备 Fail-Open 容灾能力；
> 但底层的 **EverOS 认知引擎必须同时接入两套模型服务**，才能真正完成知识提炼与语义检索：
> 1. **归纳推理模型 (Extractor LLM)**：用于从长对话中提取关键事实、代码规约、归纳决策纪事并演进用户画像；
> 2. **密集嵌入模型 (Dense Embedding Model)**：用于对用户提问和记忆库执行稠密向量化，驱动毫秒级语义与混合检索。
>
> 若未配置上述模型，EverOS 无法生成向量索引或萃取记忆。

### 推荐配置模板（`~/.everos/everos.toml`）

在用户主目录下创建或编辑 `~/.everos/everos.toml`（Windows 下对应 `%USERPROFILE%\.everos\everos.toml`）：

```toml
[server]
host = "127.0.0.1"
port = 8000

# 1. 归纳推理模型：负责记忆萃取、实体提炼与画像演进
[llm]
provider = "openai"
base_url = "https://api.example.com/v1"       # 您的通用推理模型服务商端点
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
model = "your-chat-model-name"
temperature = 0.2

# 2. 密集嵌入模型：负责语义相似度计算与知识库密集向量索引
[embedding]
provider = "openai"
base_url = "https://api.example.com/v1"       # 您的嵌入模型服务商端点
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
model = "your-embedding-model-name"
dimension = 4096                              # 必须与模型输出维度严格一致
query_max_concurrent = 8                      # 检索并发槽位（根据 API 速率配额设置）

[storage]
backend = "lancedb"                           # 默认向量数据库
```

### 连通性自检
配置完成后启动 EverOS，访问健康探测端点验证：
```bash
curl http://127.0.0.1:8000/health
```
**正常响应示例**：
```json
{
  "healthy": true,
  "embed": true,
  "version": "1.5.1"
}
```
> 必须确保响应中 `"healthy": true` 且 `"embed": true`，方可开启完整的语义检索与认知沉淀！

---

## 二、 部署指南：AI Agent 一键式自动装配 Prompt

如果您使用 AI Agent（如 Antigravity、Codex、Claude Code、Deepseek Harness 等）进行开发，只需将以下提示词**复制并粘贴给您的 Agent**，Agent 将全自动完成环境检测、依赖引导与全局注册：

````markdown
# ArtEmis 全自动装配任务

请帮我在当前机器上全自动配置、部署并验证 ArtEmis (EverOS Google Antigravity) 记忆插件。
仓库根目录为当前工作区（若未在插件根目录，请先向我询问或定位插件路径）。

请严格按照以下五个阶段依次推进，前一阶段未通过时请停下排查或向我确认：

## 阶段一：运行环境与底层依赖探测
- 检查系统 Node.js 运行时版本（需满足 `>= 20.0.0`）；
- 检查系统 Python 环境（需满足 `>= 3.10`）以及 EverOS 核心库的安装状态（通过 `everos --version` 或当前虚拟环境探测）；若未安装，引导我执行 `pip install everos`。

## 阶段二：认知引擎双模型配置核查（LLM 归纳 + 嵌入模型）
- 检查配置文件 `~/.everos/everos.toml`（Windows 下对应 `%USERPROFILE%\.everos\everos.toml`）是否存在且已配置有效的 `[llm]` 与 `[embedding]`；
- 若配置缺失或未填入凭据，请向我索取并引导我提供以下两组模型参数：
  1. **Extractor LLM（归纳模型）**：Base URL、API Key、Model 名称（用于对话长文提炼、规约抽取与长期画像演进）；
  2. **Embedding Model（嵌入模型）**：Base URL、API Key、Model 名称、输出维度 Dimension（用于知识库密集向量索引与语义召回）；
- 获得参数后，全自动生成并原子化写入标准的 `~/.everos/everos.toml`。

## 阶段三：认知后端启动与健康端点深度校验
- 启动或确认 EverOS 服务正在运行（默认监听 `http://127.0.0.1:8000`）；
- 向 `http://127.0.0.1:8000/health` 发起探测，严格校验响应体必须同时满足：
  * `healthy === true`
  * `embed === true`
  确保嵌入模型与归纳推理通道均处于就绪状态。

## 阶段四：插件全局部署、原生 Sidecar 注册与门禁验证
- 进入插件代码根目录，运行清单静态安全门禁：
  `node scripts/check-manifests.mjs`（确认 16 项门禁 0 FAIL）；
- 执行一键全局插件安装与 Antigravity 原生 Sidecar 常驻守护注册：
  `node scripts/install.mjs -g -s`（部署至 `~/.gemini/config/plugins/everos/` 并注册 `~/.gemini/config/sidecars/everos/` 守护）；
- 运行全量单元与集成测试套件验证环境兼容性：
  `npm test`（确保 120 项测试全部通过）。

## 阶段五：交付摘要与使用指引
- 输出格式化的部署状态看板（包含 EverOS 服务地址、双模型连通状态、插件安装目录与 Sidecar 守护路径）；
- 提示我重启或刷新 Antigravity，即可通过 `/everos status` 控制台或日常对话开始体验自进化长期认知记忆。
````

---

## 三、 手动安装指南

如果您希望手动安装，请按照以下步骤操作：

### 1. 全局安装与 Sidecar 守护注册（推荐）
在插件代码目录下执行：
```bash
# -g: 注册全局插件 (~/.gemini/config/plugins/everos)
# -s: 注册 Antigravity 原生常驻 Sidecar 守护进程
node scripts/install.mjs -g -s
```

### 2. 单工作区独立挂载
若仅希望在特定工程工作区启用记忆：
```bash
node scripts/install.mjs --workspace /path/to/your/workspace
```
安装器会自动将钩子与 MCP 注册至目标工作区的 `.agents/hooks.json` 与 `.agents/mcp_config.json`，并安全备份已有配置（`.bak`）。

### 3. 一键卸载与配置回滚
```bash
node scripts/install.mjs -g --uninstall
```

---

## 四、 核心功能与架构特性

```
       Google Antigravity IDE (Host)
┌───────────────────────────────────────────────┐
│ System Context: <everos_profile> (L1 画像)    │ ─── 既定规约 & 意趣默契 (99% KV 缓存物理命中)
│ History Trajectory                            │
│ Ephemeral Turn: <everos_memory> (L2 瞬态记忆) │ ─── 曾有范例 & 交互脉络 (单轮阅后即焚，0 污染)
│ Current User Prompt                           │
└───────────────────────────────────────────────┘
                       ▲
                       │ stdio JSON-RPC 2.0 / Hook Ingestion
                       ▼
┌───────────────────────────────────────────────┐
│ everos-antigravity (Pure ESM, Zero-Dep)       │
│ - Hook IO & Windows 11 自然排空协议           │
│ - Detached 异步派发（SessionStart 降至 ~300ms）│
│ - 两阶段提交 (2PC) 事务账本 (分片幂等防重发)  │
│ - Dummy Tool Synth 拓扑闭环防线               │
│ - 原生 stdio MCP Server & 统一运维控制台      │
└───────────────────────────────────────────────┘
                       ▲
                       │ HTTP REST (Loopback)
                       ▼
┌───────────────────────────────────────────────┐
│ EverOS 认知记忆后端 (:8000)                   │
│ - LLM 归纳蒸馏 + 密集嵌入索引 (LanceDB)       │
└───────────────────────────────────────────────┘
```

1. **纯 ESM 零运行时依赖 (Pure ESM, Zero-Dep)**：
   仅使用 Node.js `>=20.0.0` 原生标准库（`node:fs`、`node:child_process`、`node:readline`、原生 `fetch` 与 `crypto`），无需安装任何 npm 运行时依赖，开箱即跑。
2. **Fail-Open 绝对容灾**：
   若 EverOS 离线、端口被占或网络波动，插件以毫秒级安全退出并向宿主返回 `{}`。宿主绝不报错、不卡顿、不打断开发者交互。
3. **两阶段提交 (2PC) 事务账本**：
   本地维护精确到每会话的状态机，观察阶段（`observed_turn_index`）与结算阶段（`settled_turn_index`）解耦。针对上游 `/add` 引入客户端 `acked_chunks` 账本，网络重试时仅增量补发失败分片，彻底杜绝数据重复膨胀。
4. **增量 Byte Offset 游标读取**：
   在 `Stop` 钩子中采用底层文件字节偏移切片读取，长会话下捕获耗时恒定在 `< 5ms`，彻底消除大文件磁盘 I/O 放大。
5. **Windows 11 自然排空协议 (Natural Drain Protocol)**：
   强制执行 `process.exitCode = 0`，让事件循环自然完成管道排空，彻底杜绝 Windows 平台因 `process.exit(0)` 强杀引发的管道截断与空 JSON 报错。
6. **代码泛型与正文完整性防护**：
   定向精准匹配 `<everos_memory>` 与 `<everos_profile>` 标签，绝不误伤用户代码中的 `Array<T>`、JSX 标签及代码正文。

---

## 五、 四大分类锚点（中英双语自适应）

记忆渲染引擎内置中英双语自适应锚点注册表（通过环境变量 `EVEROS_AG_LOCALE=zh` 或 `en` 切换）：

| 数据桶 (Data Bucket) | 中文自然语言锚点 | 英文自然语言锚点 | 语义内涵与注入策略 |
|---|---|---|---|
| `explicit_info` | **【既定规约】** | **[Prescriptive Covenants]** | 开发者亲口声明的技术栈硬约束、依赖规范与架构铁律（注入 L1 Profile） |
| `implicit_traits` | **【意趣默契】** | **[Tacit Affinities]** | 模型从长期对话中观察归纳出的开发者编程品味、思维逻辑与习惯倾向（注入 L1 Profile） |
| `agent_cases` | **【曾有范例】** | **[Erstwhile Exemplars]** | 复杂的工程排错复盘、突破性攻坚案例与解决方案（PreInvocation 瞬态注入） |
| `episodes` | **【交互脉络】** | **[Interwoven Vestiges]** | 跨会话的架构演进事实、技术决策纪事与工作记忆轨迹（PreInvocation 瞬态注入） |

---

## 六、 原生 MCP 工具与统一运维控制台

### 1. 暴露给大模型的自主工具 (MCP Tools)
- `everos_search_memory`：主动语义检索历史工程记忆；
- `everos_get_profile`：获取开发者的既定规约与意趣默契画像；
- `everos_add_memory`：显式摄入高价值技术决策或复盘；
- *(注意：严禁向模型暴露 `flush` 封箱权限，封箱权严格由生命周期与人类掌控)*。

### 2. 统一运维控制台命令 (`/everos`)
- **/everos status**（或直接输入 **/everos**）：打印诊断看板，查看服务连通性、当前工程 ID、用户分区与待封箱状态；
- **/everos flush**（或 **/everos-flush**）：对当前活跃会话执行两阶段提交显式封箱，安全触发后台知识萃取；
- **/everos search <关键词>**：在控制台直接执行跨会话记忆检索。

---

## 七、 环境变量配置参考

插件前端适配器支持通过环境变量自定义运行时参数：

| 环境变量 | 默认值 | 作用与说明 |
|---|---|---|
| `EVEROS_AG_BASE_URL` | `http://127.0.0.1:8000` | EverOS 认知引擎的 HTTP 地址（非回环地址时会跨网络传输） |
| `EVEROS_AG_SEARCH_METHOD` | `keyword` | 默认检索策略模式 (`keyword`, `vector`, `hybrid`) |
| `EVEROS_AG_PROJECT_ID` | 根据 Git Remote 自动推导 | 规范化项目空间隔离分区 (Agent Track) |
| `EVEROS_AG_USER_ID` | 系统当前用户名 (`USERNAME`) | 开发者用户身份隔离分区 (User Track，跨工程穿透) |
| `EVEROS_AG_LOCALE` | `zh` | 语义注入锚点语种 (`zh` 中文 或 `en` 英文) |
| `EVEROS_AG_DATA_DIR` | `~/.everos/antigravity` | 本地 2PC 会话状态账本与索引存储路径 |
| `EVEROS_AG_RECALL_TIMEOUT_MS` | `5000` | 检索超时上限阈值 (500~10000ms 自动钳制) |

---

## 八、 自动化验收套件与实证

项目内置零依赖的自动化测试矩阵与实机模拟套件：

```bash
# 运行 16 项自动化清单门禁与 120 项单元/集成测试
npm test

# 运行完整宿主生命周期实机模拟套件
npm run verify:live
```

测试覆盖了包括单调状态合并、分片重试账本、Windows 盘符防漂移、管道自然排空、Detached 后台派发、双轨检索防饿死等在内的全部边界场景。

---

## 开源协议

Apache-2.0 © 2026 Sethyrial
