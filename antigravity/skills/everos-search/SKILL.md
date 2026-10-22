---
name: everos-search
description: 在当前工程中检索历史沉淀的长期记忆（包含【既定规约】、【曾有范例】、【交互脉络】等）。
---

# EverOS Memory Search

本技能用于通过语义与关键词检索当前工作区历史沉淀的工程事实与经验范例。

## 执行步骤

1. 如果用户提供了检索词（例如 `/everos-search ESM 规约`）：
   ```bash
   node "${PLUGIN_ROOT}/skills/everos/cli.js" search "<用户检索词>"
   ```
2. 如果用户未提供检索词，先询问用户想检索什么内容，或提示用户输入检索关键字。
3. **输出规范**：
   直接将 CLI 检索到的 Markdown 格式记忆卡片呈现给用户。
