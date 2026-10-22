import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeStdoutJson, safeExit } from "../hooks/scripts/lib/hook-io.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("hook-io: writeStdoutJson writes valid json to stdout", () => {
  // Capture stdout
  let captured = "";
  const originalWrite = process.stdout.write;
  try {
    process.stdout.write = (chunk) => {
      captured += chunk;
      return true;
    };
    writeStdoutJson({ status: "ok", count: 42 });
    assert.equal(captured, JSON.stringify({ status: "ok", count: 42 }) + "\n");
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("hook-io: writeStdoutJson defaults null or undefined to empty object", () => {
  let captured = "";
  const originalWrite = process.stdout.write;
  try {
    process.stdout.write = (chunk) => {
      captured += chunk;
      return true;
    };
    writeStdoutJson(null);
    assert.equal(captured, "{}\n");
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("hook-io: safeExit sets exitCode without killing immediately", () => {
  const originalCode = process.exitCode;
  try {
    safeExit(0);
    assert.equal(process.exitCode, 0);
    safeExit(2);
    assert.equal(process.exitCode, 2);
  } finally {
    process.exitCode = originalCode;
  }
});

test("hook-io: readStdinJson & wrapHook fail-open in actual child process", () => {
  const snippet = `
    import { readStdinJson, writeStdoutJson, wrapHook } from "./hooks/scripts/lib/hook-io.js";
    wrapHook(async () => {
      const input = readStdinJson();
      if (input.triggerError) {
        throw new Error("Simulated fatal failure in hook");
      }
      writeStdoutJson({ received: input.message || "none" });
    });
  `;

  // Case 1: valid input
  const res1 = spawnSync(process.execPath, ["--input-type=module", "-e", snippet], {
    input: JSON.stringify({ message: "hello" }),
    encoding: "utf8",
    cwd: path.resolve(__dirname, ".."),
  });
  assert.equal(res1.status, 0);
  assert.deepEqual(JSON.parse(res1.stdout.trim()), { received: "hello" });

  // Case 2: malformed input (fail-open returns {})
  const res2 = spawnSync(process.execPath, ["--input-type=module", "-e", snippet], {
    input: "NOT_VALID_JSON{[[",
    encoding: "utf8",
    cwd: path.resolve(__dirname, ".."),
  });
  assert.equal(res2.status, 0);
  assert.deepEqual(JSON.parse(res2.stdout.trim()), { received: "none" });

  // Case 3: hook throws unhandled exception -> wrapHook outputs {} with code 0 and logs stderr
  const res3 = spawnSync(process.execPath, ["--input-type=module", "-e", snippet], {
    input: JSON.stringify({ triggerError: true }),
    encoding: "utf8",
    cwd: path.resolve(__dirname, ".."),
  });
  assert.equal(res3.status, 0);
  assert.deepEqual(JSON.parse(res3.stdout.trim()), {});
  assert.match(res3.stderr, /Simulated fatal failure in hook/);

  // Case 4: double stdout protection: if output already written, do not write {} again
  const doubleSnippet = `
    import { writeStdoutJson, wrapHook } from "./hooks/scripts/lib/hook-io.js";
    wrapHook(async () => {
      writeStdoutJson({ injectSteps: ["step1"] });
      throw new Error("Post-write explosion");
    });
  `;
  const res4 = spawnSync(process.execPath, ["--input-type=module", "-e", doubleSnippet], {
    encoding: "utf8",
    cwd: path.resolve(__dirname, ".."),
  });
  assert.equal(res4.status, 0);
  // Stderr has the warning
  assert.match(res4.stderr, /Post-write explosion/);
  // Stdout must contain EXACTLY ONE JSON line (no trailing {})
  const lines = res4.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { injectSteps: ["step1"] });
});
