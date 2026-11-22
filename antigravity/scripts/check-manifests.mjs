#!/usr/bin/env node
/**
 * check-manifests.mjs — Antigravity 插件清单闭环校验
 *
 * 位于 scripts/check-manifests.mjs，由 `npm run check` 与 CI 调用。
 * 校验：宿主读哪份清单、清单指向的脚本是否存在、路径是否能跨 cwd 解析、无本地路径泄漏、零依赖。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, ".."));

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { failures++; console.error(`  FAIL  ${m}`); };

console.log(`[check-manifests] root = ${root}\n`);

// ── 1. package.json 零依赖 ────────────────────────────────────────────────
console.log("1) package.json");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const k of ["dependencies", "devDependencies", "peerDependencies"]) {
  const v = pkg[k];
  if (v && Object.keys(v).length) bad(`${k} 必须为空，实际: ${Object.keys(v)}`);
  else ok(`${k} 为空`);
}
if (!pkg.scripts?.ci) bad("scripts.ci 缺失");
else ok(`scripts.ci = "${pkg.scripts.ci}"`);
if (!pkg.scripts?.check) bad('scripts.check 缺失（CI 需要独立于 test 的清单门禁）');
else ok(`scripts.check = "${pkg.scripts.check}"`);

// ── 2. hooks 清单：只允许一份，且命令可跨 cwd 解析 ────────────────────────
console.log("\n2) hooks 清单");
const hookCandidates = [path.join(root, "hooks.json"), path.join(root, "hooks", "hooks.json")]
  .filter((p) => fs.existsSync(p));
if (hookCandidates.length === 0) bad("未找到 hooks.json");
if (hookCandidates.length > 1) {
  bad(`hooks 清单存在 ${hookCandidates.length} 份，宿主读哪份未定义: ${hookCandidates.map((p) => path.relative(root, p)).join(", ")}`);
} else ok("hooks 清单唯一");

const hookEvents = new Set(["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse", "PostInvocation", "Stop"]);
for (const hp of hookCandidates) {
  const rel = path.relative(root, hp);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(hp, "utf8")); }
  catch (e) { bad(`${rel} 不是合法 JSON: ${e.message}`); continue; }

  const namespaces = Object.keys(doc);
  if (namespaces.length !== 1 || typeof doc[namespaces[0]] !== "object") {
    bad(`${rel} 应为「单一顶层命名空间」包裹，实际顶层键: ${namespaces.join(", ")}`);
    continue;
  }
  ok(`${rel} 顶层命名空间 = ${namespaces[0]}`);

  const events = doc[namespaces[0]];
  for (const [ev, arr] of Object.entries(events)) {
    if (!hookEvents.has(ev)) bad(`${rel} 未知事件 ${ev}`);
    if (!Array.isArray(arr)) { bad(`${rel} ${ev} 不是数组`); continue; }
    for (const item of arr) {
      if (item.matcher !== undefined || item.hooks !== undefined) {
        bad(`${rel} ${ev} 使用了 Claude Code 的 matcher/hooks 双层包装`);
      }
      if (item.type !== "command") bad(`${rel} ${ev} type 应为 command`);
      if (typeof item.timeout !== "number") bad(`${rel} ${ev} timeout 应为数字（秒）`);

      const cmd = String(item.command || "");
      const hasVar = /\$\{?[A-Z_]*PLUGIN_ROOT/.test(cmd);
      if (hasVar && !/\$\{[A-Z_]*PLUGIN_ROOT:-\.?\}/.test(cmd)) {
        bad(`${rel} ${ev} 变量 ${cmd.match(/\$\{?[A-Z_]*PLUGIN_ROOT\}?/)[0]} 缺少 ":-." 兜底`);
      }
      const target = cmd.replace(/^node\s+/, "").replace(/^"|"$/g, "")
        .replace(/^\$\{[A-Z_]*PLUGIN_ROOT:-?\.?\}\//, "");
      if (!hasVar && !/^[A-Za-z]:[\\/]/.test(target)) {
        bad(`${rel} ${ev} 使用裸相对路径 "${target}"：宿主 cwd 非插件根时必然失败（应用 \${PLUGIN_ROOT} 或绝对路径）`);
      } else {
        const abs = path.resolve(root, target);
        if (!fs.existsSync(abs)) bad(`${rel} ${ev} 指向不存在的文件: ${target}`);
        else ok(`${ev} -> ${target}`);
      }
    }
  }
}

// ── 3. MCP 清单 ─────────────────────────────────────────────────────────
console.log("\n3) mcp_config.json");
const mcpPath = path.join(root, "mcp_config.json");
if (!fs.existsSync(mcpPath)) bad("mcp_config.json 缺失");
else {
  const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  const servers = mcp.mcpServers ?? {};
  if (!Object.keys(servers).length) bad("mcpServers 为空");
  for (const [name, cfg] of Object.entries(servers)) {
    const args = cfg.args ?? [];
    for (const a of args) {
      if (!/\$\{PLUGIN_ROOT\}/.test(a)) { bad(`mcpServers.${name} 参数未锚定插件根: ${a}`); continue; }
      const rel = a.replace("${PLUGIN_ROOT}/", "");
      if (!fs.existsSync(path.join(root, rel))) bad(`mcpServers.${name} 指向不存在的文件: ${rel}`);
      else ok(`mcpServers.${name} -> ${rel}`);
    }
  }
}

// ── 4. 本地绝对路径泄漏 ──────────────────────────────────────────────────
console.log("\n4) 本地路径泄漏");
// 只扫「随包交付的文档与源码」；tests/ 下的 /home/tester、/Users/me 是 fixture 常量，不算泄漏。
const LEAK = /[A-Za-z]:\\+(Users|ArtEmis|Tencent)\\+|\/Users\/(?!me\b)[a-z]|\/home\/(?!tester\b)[a-z]/i;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return e.name === "node_modules" || e.name === ".git" ? [] : walk(p);
  return [p];
});
const textExt = new Set([".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".txt"]);
let leaks = 0;
for (const f of walk(root)) {
  if (!textExt.has(path.extname(f))) continue;
  if (path.relative(root, f).split(path.sep)[0] === "tests") continue;
  const txt = fs.readFileSync(f, "utf8");
  txt.split("\n").forEach((ln, i) => {
    if (LEAK.test(ln)) { leaks++; bad(`${path.relative(root, f)}:${i + 1} 含本地绝对路径: ${ln.trim().slice(0, 90)}`); }
  });
}
if (!leaks) ok("无本地绝对路径");

// ── 5. Skills 与 CLI 路由闭环 ───────────────────────────────────────────
console.log("\n5) Skills");
const skillsDir = path.join(root, "skills");
if (!fs.existsSync(skillsDir)) bad("skills/ 缺失");
else {
  const skills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const s of skills) {
    const md = path.join(skillsDir, s.name, "SKILL.md");
    if (!fs.existsSync(md)) { bad(`skills/${s.name} 缺少 SKILL.md`); continue; }
    const body = fs.readFileSync(md, "utf8");
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) bad(`skills/${s.name}/SKILL.md 缺少 frontmatter`);
    else if (!/^name:/m.test(fm[1]) || !/^description:/m.test(fm[1])) bad(`skills/${s.name}/SKILL.md frontmatter 缺 name/description`);

    // SKILL.md 里出现的 cli 路径必须真实存在
    for (const m of body.matchAll(/node\s+"([^"]*cli\.js)"/g)) {
      const p = m[1];
      const rel = p.replace("${PLUGIN_ROOT}/", "");
      if (!fs.existsSync(path.resolve(root, rel))) bad(`skills/${s.name} 引用不存在的 ${p}`);
      else ok(`skills/${s.name} -> ${p}`);
      if (!/\$\{PLUGIN_ROOT\}/.test(p)) bad(`skills/${s.name} 使用裸相对路径 "${p}"，依赖宿主 cwd`);
    }
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
