import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const libDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "scripts", "lib");

function writeProbe(dir, body) {
  const file = path.join(dir, "probe.mjs");
  fs.writeFileSync(file, `import { runHook } from ${JSON.stringify(path.join(libDir, "hook-io.js"))};\n${body}\n`);
  return file;
}

function run(file, stdinObject, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(stdinObject));
  });
}

test("a handler returning context produces the hook envelope", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-io-"));
  const file = writeProbe(dir, `runHook("UserPromptSubmit", async (input) => ({ additionalContext: "ctx:" + input.prompt, systemMessage: "note" }));`);
  const { code, stdout } = await run(file, { prompt: "hello" });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx:hello" },
    systemMessage: "note",
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a handler returning nothing writes nothing at all", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-io-"));
  const file = writeProbe(dir, `runHook("Stop", async () => undefined);`);
  const { code, stdout } = await run(file, { session_id: "s" });
  assert.equal(code, 0);
  assert.equal(stdout, "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a throwing handler still exits 0 with empty stdout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-io-"));
  const file = writeProbe(dir, `runHook("Stop", async () => { throw new Error("boom"); });`);
  const { code, stdout, stderr } = await run(file, {});
  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.ok(stderr.includes("boom"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unhandled rejection still exits 0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-io-"));
  const file = writeProbe(dir, `runHook("Stop", async () => { Promise.reject(new Error("late boom")); await new Promise((r) => setTimeout(r, 50)); return undefined; });`);
  const { code, stdout } = await run(file, {});
  assert.equal(code, 0);
  assert.equal(stdout, "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("malformed stdin exits 0 without output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-io-"));
  const file = writeProbe(dir, `runHook("Stop", async () => ({ systemMessage: "should not appear" }));`);
  const child = spawn(process.execPath, [file], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stdin.end("{not json");
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0);
  assert.equal(stdout, "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("debug output lands in the data directory only when debug is on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-io-"));
  const file = writeProbe(dir, `runHook("Stop", async (input, ctx) => { ctx.debug("hello debug"); return undefined; });`);
  await run(file, {}, { EVEROS_CC_DATA_DIR: dir });
  assert.equal(fs.existsSync(path.join(dir, "debug.log")), false);
  await run(file, {}, { EVEROS_CC_DATA_DIR: dir, EVEROS_CC_DEBUG: "1" });
  assert.ok(fs.readFileSync(path.join(dir, "debug.log"), "utf8").includes("hello debug"));
  fs.rmSync(dir, { recursive: true, force: true });
});
