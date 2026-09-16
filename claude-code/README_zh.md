# EverOS Claude Code 插件

为 **Claude Code** 提供跨会话的持久记忆，后端是你自己部署的
[EverOS](https://github.com/EverMind-AI/EverOS)。你不需要调用任何工具，也不需要记得做任何事。

插件在**每条 prompt 之前**召回相关记忆并注入上下文，在**每个回合结束后**保存对话文本和完整的工具调用轨迹，并在会话结束或上下文压缩前**封存会话**。你只管干活。

几点需要知道：

- **失败即静默（fail-open）。** EverOS 挂了或连不上时，Claude Code 的表现和没装插件完全一样。记忆暂停，别的都不受影响。
- **只在本机。** 你的对话记录只发给本机回环地址上的 EverOS，不去别处。
- **零运行时依赖** —— 用原生 `fetch`，不需要 npm install。
- 记忆**按仓库分区**，同一个仓库的所有 worktree 共用一个分区。唯一的例外是开发者画像，EverOS 只按用户索引，见[记忆如何分区](#记忆如何分区)。

## 环境要求

| | |
|---|---|
| Node | ≥ 20，且在 `PATH` 上（hook 通过 `node` 运行） |
| EverOS | ≥ 1.3.0，已执行 `everos init`，且 `~/.everos/everos.toml` 里的 `api_key` 已填 |
| Claude Code | 支持插件的版本（`claude plugin --help` 能跑通） |

## 安装

```bash
claude plugin marketplace add EverMind-AI/Plugins
claude plugin install everos@everos --scope user
```

启用插件时会问两个问题，都可以直接回车：

- **EverOS base URL** —— 除非你改过地址，否则就是 `http://127.0.0.1:8000`。
- **EverOS checkout directory** —— 除非 `everos` 不在 `PATH` 上，否则留空（见[从源码目录运行](#从源码目录运行)）。

后续更新：

```bash
claude plugin marketplace update everos
claude plugin update everos@everos
```

从零搭建 EverOS：

```bash
git clone https://github.com/EverMind-AI/EverOS.git
cd EverOS
uv sync
uv run everos init      # 生成 ~/.everos/everos.toml —— 首次启动前必须执行
# 编辑 ~/.everos/everos.toml，填入 api_key（llm / embedding / rerank）
uv run everos server start
```

## 第一次运行

插件在会话开始时探测 EverOS；如果没起来且地址是回环地址，就替你启一个。你可能看到这几行之一：

| 提示 | 含义 |
|---|---|
| *（无输出）* | EverOS 本来就在运行。这是常态。 |
| `⚡ EverOS started — memory is on.` | 插件起了一个，并且已经响应。 |
| `⏳ EverOS is starting in the background…` | 已启动但慢于 5 秒的等待窗口，记忆稍后自行恢复。 |
| `⚠️ EverOS could not be started (…)` | 启动命令执行失败，跑 `/everos:status`。 |
| `⚠️ EverOS unreachable at …` | 连不上，且无法从这里启动，跑 `/everos:status`。 |

**插件启动的 server 会在 Claude Code 退出后继续运行。** hook 是个两秒就结束的进程，没有常驻父进程能托管它，所以是刻意 detach 的。想停就停：

```bash
pkill -f "everos server start"
```

同时开多个 Claude Code 窗口是安全的。EverOS 有单实例锁，后启动的会退出，第一个为所有窗口服务。

## 验证它真的能用

三项检查。**每一项都要对着磁盘上的文件确认** —— 会话还开着的时候，「看起来记得」什么都证明不了，因为它答的可能就是自己当前的上下文。

**1. 跨会话记得你。**

```text
My favourite coffee is espresso.
```

等几秒（抽取是异步的），`/clear`，然后问：

```text
What coffee do I like?
```

凭证：`~/.everos/claude-code/<repo>/users/<你>/episodes/` 下有提到 espresso 的 markdown 文件。

**2. 记得工程决策。** 在某个仓库里约定一件事，比如「本项目用 ruff，不用 black」，然后开新会话（同仓库或它的任一 worktree），让它加个 lint 步骤。这条决策应该出现在召回的上下文里。

凭证：回复上方出现 `🧠 EverOS: …` 那一行；当某个回合的工具调用足够多、值得记录时，`~/.everos/claude-code/<repo>/agents/claude-code/.cases/` 下会开始积累文件。

**3. 失败即静默。** 停掉 EverOS（`pkill -f "everos server start"`）继续干活。每个会话只出现一行警告，Claude Code 正常回答，不报 hook 错误。

## 记忆如何分区

一个 EverOS 服务所有宿主。你的 Claude Code 记忆通过 `app_id` 与 OpenClaw、Hermes 隔开，通过 `project_id` 与你的其他仓库隔开。

| EverOS 字段 | 取值 | 如何确定 |
|---|---|---|
| `app_id` | `claude-code` | 固定。 |
| `project_id` | 主机 + owner + 仓库名 | `git config --get remote.origin.url` 的最后三段拼接，例如 `github.com_EverMind-AI_Plugins`；否则 git 顶层目录名；否则当前目录名。可用 `EVEROS_CC_PROJECT_ID` 覆盖。 |
| `user_id` | 你的系统用户 | `$USER`、`$USERNAME`、系统账号。可用 `EVEROS_CC_USER_ID` 覆盖。 |
| `agent_id` | `claude-code` | 固定。 |

优先用 remote，是为了让同一仓库的多个 worktree（`repo`、`repo-a`、`repo-b`）共用一份记忆，而不是分成三份；同一个仓库的 ssh / https、带不带 `.git` 的各种 clone 地址也都会归到同一个 id。

之所以带上主机和 owner：光有仓库名不构成命名空间。两个不同 owner 的 `api` 仓库很常见，只用仓库名的话它们会互相读到对方的决策。

**有一个例外，而且是 EverOS 的行为，不是插件的。** 开发者画像只按 `user_id` 索引：无论搜索请求里的 `app_id` / `project_id` 是什么，EverOS 都会把它返回，而且返回的那条自报的 scope 是它**写入时**的 scope，不是请求的。已对 1.3.1 实测确认。所以 episode、case、skill 是按仓库分区的，**画像是跨你所有仓库、甚至跨所有写同一个 EverOS 的宿主共享的**。对「喜欢简短回答」这类偏好这是好事，对画像从某个具体项目里总结出来的内容就尴尬了。真要分开，就给不同仓库设不同的 `EVEROS_CC_USER_ID`。

落盘结构：

```
~/.everos/claude-code/<project_id>/users/<user_id>/     episode、atomic fact、profile
~/.everos/claude-code/<project_id>/agents/claude-code/  case、skill
```

**想让所有项目共用一份记忆？** 把 `EVEROS_CC_PROJECT_ID` 设成一个固定值，全部落到同一个分区。

## 配置

优先级：**环境变量** > **插件选项**（安装时问的那两项，存在 `~/.claude/settings.json`）> **默认值**。空字符串或纯空白视为未设置，不会遮蔽下一层。

| 变量 | 插件选项 | 默认值 | 作用 |
|---|---|---|---|
| `EVEROS_CC_BASE_URL` | `base_url` | `http://127.0.0.1:8000` | EverOS 地址。缺协议头会自动补全；无法解析时回落到默认值。 |
| `EVEROS_CC_EVEROS_DIR` | `everos_dir` | 未设置 | 启动命令的工作目录。 |
| `EVEROS_CC_START_CMD` | — | `everos server start` | 支持引号，例如 `uv run everos server start`。 |
| `EVEROS_CC_USER_ID` | — | 系统用户 | 个人记忆的身份。 |
| `EVEROS_CC_PROJECT_ID` | — | 自动推断 | 强制指定分区。 |
| `EVEROS_CC_RECALL_TIMEOUT_MS` | — | `5000` | 两路召回搜索的总预算，取值被限制在 500–7000；推断 project_id 会在这个预算开始前先花掉 hook 那 10 秒里的至多 2 秒。 |
| `EVEROS_CC_VERBOSE` | — | 关 | 额外打印「没有相关记忆」「已保存 N 条消息」，以及 SessionStart 时的 EverOS 版本行。 |
| `EVEROS_CC_DEBUG` | — | 关 | 把 hook 诊断信息写入数据目录下的 `debug.log`。 |
| `EVEROS_CC_DATA_DIR` | — | `$CLAUDE_PLUGIN_DATA`，否则 `~/.everos/.claude-code` | 会话状态、`debug.log`、`everos-server.log` 的位置。 |

热查询耗时 0.3–0.8 秒，所以召回预算几乎不会真的花掉；它是为长尾情况准备的。如果 `/everos:status` 显示服务器慢就调大，如果你宁可一秒都不等就调小。

### 从源码目录运行

当 `everos` 不在 `PATH` 上时（用 `uv` 管理项目的常见情况），把插件指向你的 checkout：

```bash
export EVEROS_CC_EVEROS_DIR="$HOME/EverOS"
export EVEROS_CC_START_CMD="uv run everos server start"
```

从图形界面启动的 Claude Code 继承不到 shell 环境变量。需要长期生效的值，写进 `~/.claude/settings.json` 的 `env` 一节，或者在插件选项里回答 `base_url` 和 `everos_dir`。

> 插件代启的 EverOS 会被强制带上 `EVEROS_MEMORIZE__MODE=agent` 和取自 `base_url` 的端口，
> 两者都经环境变量注入。环境变量优先于 `~/.everos/everos.toml`，而这台 server 之后服务本机
> 所有宿主——所以如果你的配置里另有 `[memorize] mode`，请自己把 EverOS 起起来。

## 命令

| 命令 | 作用 |
|---|---|
| `/everos:status` | 服务健康状况、捕获与召回所用的身份、生效配置（走分层解析的那四项会标出来自哪一层）、当前生效的召回预算、最近几行 debug 日志。记忆看起来不工作时先跑这个。 |
| `/everos:search <query>` | 用与召回 hook 完全相同的身份跑同样的两路搜索，并原样打印那个块 —— 你看到的就是 prompt 会拿到的。 |

## 捕获什么，不捕获什么

**每个完成的回合捕获**：

- 你的 prompt，其中插件自己注入的记忆块会被剥掉
- 助手的文本回复
- 每次工具调用，按 OpenAI 的 `tool_calls` 形状（名称与参数）
- 每个工具结果，与对应的调用配对

发送完整轨迹是刻意的：EverOS 的 case 抽取需要这些工具轮次才能识别出可复用的做法，而且它自己会做裁剪。单条超过 20000 字符的工具结果会先做首尾截断，这只是防止请求体失控。

**不捕获**：thinking 块；子代理（Task 工具）的流量；skill 正文、斜杠命令脚手架等并非你亲手输入的宿主注入文本；图片和其他附件。

## 排查

**先跑 `/everos:status`。** 它报告健康状态和解析出来的身份，然后列出一份排查清单让你逐条走。

| 现象 | 原因与处理 |
|---|---|
| 从来召回不到东西 | 抽取是异步的，几秒前的对话还没进索引。然后看 `/everos:status` 里的 `project_id`：别的仓库的记忆在这里看不到。 |
| 既没有 `🧠 EverOS` 行也没有警告 | 这条 prompt 被跳过了：斜杠命令和不足三个词的输入不会触发搜索。 |
| `agents/` 下始终没有 case | EverOS 会拒绝「没有迂回、只有一条用户消息」的轨迹。case 来自真实的多轮工作，不是一问一答。 |
| hook 完全没反应 | 启动 Claude Code 的那个环境的 `PATH` 上没有 `node`。用 `/everos:status` 确认；如果它也跑不起来，就是这个原因。 |
| `SessionEnd hook … Hook cancelled` | 正常现象，无害。宿主在关停后几百毫秒就不再等这个 hook 了，交互式终端和 `claude -p` 一样。此时请求早已发出，EverOS 会在没有客户端连着的情况下把抽取做完；只有请求根本没送到时，后续会话才会补封。 |
| 召回超时 | 调大 `EVEROS_CC_RECALL_TIMEOUT_MS`。同时看 `/everos:status` 里的索引队列是否积压。 |

日志在数据目录下（`/everos:status` 会打印路径）：`debug.log`（需要先设 `EVEROS_CC_DEBUG=1`）和 `everos-server.log`（插件启动的 server 才有）。

## 隐私

所有数据都留在你的机器上。插件只与 `base_url` 通信，发送的内容就是你预期的那些：你的 prompt、助手的回复、工具调用及其结果。

**工具结果也在其中。** 如果某条命令打印了密钥，这个密钥就会进入 EverOS。EverOS 自身没有鉴权，所以除非你自己做了防护，否则 `base_url` 要留在回环地址上。插件不会为非回环地址启动 server；如果 `base_url` 指向别的机器，每个会话开头会提示一次并写明是哪台。

## 开发

```bash
cd claude-code
npm test                          # node:test，无依赖
claude plugin validate . --strict
./scripts/hooks-contract.sh       # 四个 hook 对真实 EverOS
./scripts/e2e-claude-code.sh      # 真实 Claude Code 会话对真实 EverOS
```

两个端到端脚本，回答的是不同的问题。

`scripts/hooks-contract.sh` 用构造的 stdin 喂 hook。它验的是线协议契约，以及算法能确定性给出的那部分——包括「带迂回的轨迹能产出 agent case」——但它从不启动 Claude Code，所以证明不了宿主还在调用这些 hook。

`scripts/e2e-claude-code.sh` 启动真实的 Claude Code 会话（headless 和 tmux 里的真实终端各一种），问的是记忆到底生没生效。判据是后端凭证：磁盘上的 markdown、一次真实搜索，以及**插件实际塞到模型面前的那段上下文**（从 transcript 里读回来）。会话还开着的时候它总能从自己的上下文里作答，所以这里每条用例都跨进程。八条：跨会话召回、别的仓库看不到、同仓 worktree 看得到、带工具的会话发出的轨迹、fail-open、补封、宿主噪声不入库、交互式终端。

两个都需要 LLM 凭据，因此都不进 CI。各自在独立端口、独立 root 上起自己的 EverOS，绝不碰你正在用的那个。

```bash
# 指到别处，或只覆盖 llm 一段
E2E_PORT=8899 E2E_LLM_API_KEY=sk-... ./scripts/e2e-claude-code.sh
./scripts/e2e-claude-code.sh 1 5          # 只跑 1 和 5
```

设计与取舍：[`docs/DESIGN_DOC.md`](docs/DESIGN_DOC.md)。

## 许可证

[Apache-2.0](../LICENSE)
