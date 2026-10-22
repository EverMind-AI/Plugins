import { createClient } from "../hooks/scripts/lib/everos.js";

async function seed() {
  const client = createClient({ baseUrl: "http://127.0.0.1:8000" });
  const projectId = "antigravity-demo";
  const now = Date.now();

  console.log("Adding case conversation to EverOS...");
  await client.add({
    session_id: "seed-session-002-case",
    project_id: projectId,
    app_id: "antigravity",
    messages: [
      {
        sender_id: "developer",
        sender_name: "Developer",
        role: "user",
        timestamp: now - 15000,
        content: "我们在 Windows 11 环境下遇到了 NTFS 瞬态并发写锁 EBUSY 问题，以及子进程管道截断导致输出丢失。你是怎么彻底解决的？",
      },
      {
        sender_id: "antigravity_assistant",
        sender_name: "Antigravity Assistant",
        role: "assistant",
        timestamp: now - 10000,
        content: "我们在 atomicWriteFileSync 中引入了多层防御：1. 使用 pid + 时间戳 + 随机数命名临时文件；2. renameSync 遇 EBUSY/EACCES 时，采用 Atomics.wait 结合 Int32Array 挂起当前线程 10ms 进行退避重试，最多重试 3 次；3. 退出时严格使用 process.exitCode = 0，确保 Node.js 事件循环自然排空 stdout 管道，彻底根绝了 Windows 下的输出截断与文件锁死。",
        tool_calls: [
          {
            id: "call_fix_lock_001",
            type: "function",
            function: {
              name: "edit_file",
              arguments: JSON.stringify({
                Path: "state.js",
                Target: "fs.renameSync",
                Replacement: "retryRenameSync",
              }),
            },
          },
        ],
      },
      {
        sender_id: "antigravity_assistant",
        sender_name: "Tool Execution",
        role: "tool",
        tool_call_id: "call_fix_lock_001",
        timestamp: now - 5000,
        content: JSON.stringify({ success: true, retries: 1, duration_ms: 12 }),
      },
      {
        sender_id: "antigravity_assistant",
        sender_name: "Antigravity Assistant",
        role: "assistant",
        timestamp: now,
        content: "复盘总结：该方案已作为我们的【曾有范例】沉淀，在后续遇到类似文件并发或管道排空场景时直接复用此模式。",
      },
    ],
  });

  console.log("Flushing case session...");
  const flushRes = await client.flush({
    session_id: "seed-session-002-case",
    project_id: projectId,
    app_id: "antigravity",
  });
  console.log("Flush result:", JSON.stringify(flushRes));
}

seed().catch(console.error);
