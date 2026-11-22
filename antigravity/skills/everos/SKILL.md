---
name: everos
description: EverOS 智能记忆引擎统一运维总控台。提供当前工程记忆健康状态自检、手动两阶段提交封箱（flush）与自然语言记忆检索（search）。输入 /everos 呼出控制台分流面板。
---

# EverOS Memory Engine Unified Console

EverOS 为 Google Antigravity 提供跨会话的自进化长期记忆与工程规约。执行驱动位于 [cli.js](cli.js)。

## 命令调度与交互分流规约

根据用户附带的子参数调度执行 [cli.js](cli.js)：

### 1. 无参裸敲 `/everos`：呼出统一指令分流窗口
如果用户输入了 `/everos` 且未提供明确的子指令，若宿主提供交互式问答工具（如 `ask_question`）则呼出原生交互式分流窗口，否则默认执行状态自检并提示用户选择期望的操作：
- 选项 1: `查看当前工程记忆引擎健康状态 (/everos status)`
- 选项 2: `执行当前会话两阶段提交封箱 (/everos flush)`
- 选项 3: `检索历史工程沉淀架构决策与范例 (/everos search)`

用户做出选择后，直接执行对应分支。

### 2. 状态自检: `/everos status`
立即执行：
```bash
node "${PLUGIN_ROOT}/skills/everos/cli.js" status
```
直接原样向用户输出返回的诊断看板。

### 3. 两阶段封箱: `/everos flush`
立即执行两阶段提交封箱：
```bash
node "${PLUGIN_ROOT}/skills/everos/cli.js" flush
```
向用户展示两阶段提交与后台萃取调度状态。

### 4. 记忆检索: `/everos search <关键词>`
立即执行检索：
```bash
node "${PLUGIN_ROOT}/skills/everos/cli.js" search "<关键词>"
```
若用户追加了 `--raw` 参数，传递 `--raw` 获取原始 JSON。
