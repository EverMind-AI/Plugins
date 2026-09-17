#!/usr/bin/env node
// Guard the two ways this plugin can ship looking installed and do nothing.
//
// Both were found by installing it and watching no hook fire. Neither produces
// an error anywhere: `codex plugin list` reports `installed, enabled` either
// way. A unit test cannot see them - they are facts about where files sit and
// what a path expands to - so they are checked here and in CI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

// 1. Location. A plugin's hooks.json is read from hooks/, never from the plugin
//    root - measured by varying one thing at a time against Codex 0.149.0. The
//    shipped figma and replayio plugins keep theirs at the root, so the wrong
//    answer is the one you get by copying an official example.
const hooksPath = path.join(root, "hooks", "hooks.json");
check(fs.existsSync(hooksPath), "hooks/hooks.json is missing - at the plugin root it is never read");
check(
  !fs.existsSync(path.join(root, "hooks.json")),
  "hooks.json is at the plugin root, where Codex does not read it; it belongs in hooks/",
);

if (fs.existsSync(hooksPath)) {
  const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const events = Object.entries(hooks.hooks ?? {});
  check(events.length > 0, "hooks.json registers no events");

  for (const [event, matchers] of events) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks ?? []) {
        const command = String(hook.command ?? "");

        // 2. The variable. Codex sets CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA
        //    and nothing with a CODEX_ prefix, so the obvious name expands to an
        //    empty string and the hook silently finds no script.
        check(
          !/\$\{?CODEX_PLUGIN_(ROOT|DATA)/.test(command),
          `${event}: uses CODEX_PLUGIN_*, which Codex does not set - use CLAUDE_PLUGIN_ROOT`,
        );

        // 3. The script it names has to exist. This is what catches a rename, a
        //    move, or a variable that expands to nothing.
        const relative = command.replace(/^.*\$\{CLAUDE_PLUGIN_ROOT:-\.\}\//, "").replace(/"/g, "").trim();
        if (relative && !relative.startsWith("$")) {
          check(
            fs.existsSync(path.join(root, relative)),
            `${event}: command points at ${relative}, which does not exist`,
          );
        }
      }
    }
  }
}

// 4. The manifest must parse and name itself; an unparseable one is skipped by
//    the marketplace without comment.
const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
check(fs.existsSync(manifestPath), ".codex-plugin/plugin.json is missing");
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const key of ["name", "version", "description"]) {
    check(typeof manifest[key] === "string" && manifest[key] !== "", `plugin.json is missing ${key}`);
  }
  // A declared directory that does not exist is a broken pointer, and the
  // manifest is the only place it would ever be noticed.
  if (manifest.skills) {
    check(fs.existsSync(path.join(root, manifest.skills)), `plugin.json declares skills at ${manifest.skills}, which does not exist`);
  }
}

// 5. Zero runtime dependencies is a promise the README makes.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
  // Compute once: a template literal is evaluated whether or not the check
  // passes, so reading pkg[field] inside the message throws when it is absent.
  const declared = Object.keys(pkg[field] ?? {});
  check(declared.length === 0, `${field} must stay empty, found ${declared.join(", ")}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  FAIL  ${problem}`);
  process.exit(1);
}
console.log(`  PASS  manifests, hook locations and hook targets (${root})`);
