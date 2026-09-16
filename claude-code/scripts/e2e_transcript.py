#!/usr/bin/env python3
"""Build a two-turn Claude Code transcript for the end-to-end acceptance run.

Turn A is a linear setup task. Turn B carries a failed tool call and a course
correction: everalgo's agent-case extractor rejects trajectories with no detour
and a single user message, so a one-turn transcript can never produce a case and
would leave the full-trajectory capture unverified on the agent track.

Usage: e2e_transcript.py <out.jsonl> <prompt_id_a> <prompt_id_b>
"""

from __future__ import annotations

import json
import sys

BASE = {
    "sessionId": "e2e",
    "cwd": "/tmp/e2e",
    "version": "2.1.235",
    "userType": "external",
    "entrypoint": "cli",
    "gitBranch": "main",
    "isSidechain": False,
}


def main() -> None:
    path, prompt_a, prompt_b = sys.argv[1], sys.argv[2], sys.argv[3]
    rows: list[dict] = []
    clock = [0]

    def stamp() -> str:
        clock[0] += 7
        return f"2026-09-10T10:{clock[0] // 60:02d}:{clock[0] % 60:02d}.000Z"

    def add(**kw) -> None:
        row = dict(BASE)
        row.update(kw)
        rows.append(row)

    def turn(prompt_id: str, prompt_text: str, steps, closing: str) -> None:
        add(
            type="user", uuid=f"u-{prompt_id}", promptId=prompt_id, promptSource="typed",
            timestamp=stamp(),
            message={"role": "user", "content": [{"type": "text", "text": prompt_text}]},
        )
        for index, (name, args, result, is_error, said) in enumerate(steps):
            call_id = f"{prompt_id}-tool-{index}"
            add(
                type="assistant", uuid=f"a-{call_id}", requestId=f"req-{call_id}",
                timestamp=stamp(),
                message={"role": "assistant", "content": [{"type": "text", "text": said}]},
            )
            add(
                type="assistant", uuid=f"b-{call_id}", requestId=f"req-{call_id}",
                timestamp=stamp(),
                message={
                    "role": "assistant",
                    "content": [{"type": "tool_use", "id": call_id, "name": name, "input": args}],
                },
            )
            block = {"type": "tool_result", "tool_use_id": call_id, "content": result}
            if is_error:
                block["is_error"] = True
            add(
                type="user", uuid=f"r-{call_id}", promptId=prompt_id,
                toolUseResult={"success": not is_error}, timestamp=stamp(),
                message={"role": "user", "content": [block]},
            )
        add(
            type="assistant", uuid=f"end-{prompt_id}", requestId=f"req-end-{prompt_id}",
            timestamp=stamp(),
            message={"role": "assistant", "content": [{"type": "text", "text": closing}]},
        )

    turn(
        prompt_a,
        "For this project we standardise on ruff and never use black. "
        "My favourite coffee is espresso.",
        [
            ("Read", {"file_path": "/tmp/e2e/pyproject.toml"},
             "[tool.ruff]\nline-length = 88", False, "Reading the project configuration."),
            ("Bash", {"command": "ruff check ."},
             "All checks passed!", False, "Running ruff to confirm it is wired up."),
        ],
        "Confirmed: lint is ruff, black is not used here.",
    )

    turn(
        prompt_b,
        "The pre-commit hook still runs black. Make the whole repo use ruff only, "
        "and make sure CI agrees.",
        [
            ("Bash", {"command": "grep -rn black .pre-commit-config.yaml"},
             "3:  - repo: https://github.com/psf/black", False,
             "Finding where black is still configured."),
            ("Edit", {"file_path": "/tmp/e2e/.pre-commit-config.yaml"},
             "Applied 1 edit", False, "Replacing the black hook with ruff-format."),
            ("Bash", {"command": "pre-commit run --all-files"},
             "ruff-format....Failed\n- hook id: ruff-format\n- files were modified by this hook",
             True, "Running the hooks to verify."),
            ("Bash", {"command": "git diff --stat"},
             " 14 files changed, 62 insertions(+), 62 deletions(-)", False,
             "The hook reformatted files rather than failing outright, so this is a "
             "first-run reformat, not a broken config."),
            ("Bash", {"command": "pre-commit run --all-files"},
             "ruff-format....Passed\nruff....Passed", False,
             "Re-running now that the reformat is committed."),
            ("Edit", {"file_path": "/tmp/e2e/.github/workflows/ci.yml"},
             "Applied 1 edit", False,
             "Dropping the separate black step from CI so it matches the hooks."),
        ],
        "Done: black is gone from the hooks and from CI, and ruff-format owns formatting. "
        "The first pre-commit run failing was the reformat itself, not a misconfiguration.",
    )

    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    print(f"{len(rows)} entries across 2 turns")


if __name__ == "__main__":
    main()
