---
name: everos-status
description: 查看 EverOS 长期记忆引擎的连接状态、当前工程空间分区、用户信息与待补偿会话诊断看板。
---

# EverOS Status Diagnostic Console

本技能用于即时输出 EverOS 记忆引擎的健康诊断看板。

## 执行步骤

1. 立即执行自检驱动：
   ```bash
   node "${PLUGIN_ROOT}/skills/everos/cli.js" status
   ```
2. **输出规范**：
   直接将命令的标准输出以代码块或原生文本原样呈现给用户，不要添加任何冗余的寒暄或多余的解释。
