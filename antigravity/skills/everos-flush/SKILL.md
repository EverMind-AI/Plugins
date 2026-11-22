---
name: everos-flush
description: 立即将当前工程的最新会话与沉淀记忆提交封箱（两阶段提交 2PC），安全触发 EverOS 后台知识萃取与长期画像演进更新。支持 /everos flush 与 /everos-flush 快捷调用。
---

# EverOS Fast Seal & Flush

手动显式触发当前工程的记忆封箱。驱动脚本位于 [cli.js](../everos/cli.js)。

## 执行指令

执行底层两阶段提交封箱脚本：
```bash
node "${PLUGIN_ROOT}/skills/everos/cli.js" flush
```

向用户报告封箱确认结果（HTTP 200 Ack 或 Nack 容灾提示）。
