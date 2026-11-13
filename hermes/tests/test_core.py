"""Pure-function contract tests: clip, fence, mapping, config, scope ids."""
from __future__ import annotations

import unittest

from _load import load_plugin

mod = load_plugin()
client_mod = __import__(f"{mod.__name__}.client", fromlist=["*"])


class TestWeightedClip(unittest.TestCase):
    def test_english_500_untouched(self):
        s = "a" * 500
        self.assertEqual(mod.clip_weighted(s, 500), s)
        self.assertEqual(mod.weighted_len(s), 500)

    def test_cjk_counts_double(self):
        s = "中" * 300
        self.assertEqual(mod.weighted_len(s), 600)
        self.assertEqual(mod.clip_weighted(s, 500), "中" * 250)

    def test_mixed(self):
        s = "ab" + "中" * 2  # 2 + 4 = 6 units
        self.assertEqual(mod.weighted_len(s), 6)
        self.assertEqual(mod.clip_weighted(s, 5), "ab中")  # 5th unit lands mid-char

    def test_fullwidth_is_wide(self):
        self.assertEqual(mod.weighted_len("Ａ"), 2)  # fullwidth latin


class TestBaseUrl(unittest.TestCase):
    def test_schemeless_gets_http(self):
        self.assertEqual(mod.normalize_base_url("localhost:8000"), "http://localhost:8000")

    def test_trailing_slash_stripped(self):
        self.assertEqual(
            mod.normalize_base_url("http://127.0.0.1:8000/"), "http://127.0.0.1:8000"
        )

    def test_blank_falls_back(self):
        self.assertEqual(mod.normalize_base_url("  "), mod.DEFAULTS["base_url"])


class TestSplitCommand(unittest.TestCase):
    def test_quoted_path_stays_one_token(self):
        self.assertEqual(
            mod.split_command('"/Users/My Name/.venv/bin/everos" server start'),
            ["/Users/My Name/.venv/bin/everos", "server", "start"],
        )

    def test_adjacent_pieces_join(self):
        self.assertEqual(mod.split_command('ab"c d"'), ["abc d"])


class TestOwnerId(unittest.TestCase):
    def test_valid_id_is_unchanged(self):
        self.assertEqual(mod.normalize_owner_id("user+tag@example.com", "user"),
                         "user+tag@example.com")

    def test_spaces_and_cjk_get_stable_collision_resistant_id(self):
        first = mod.normalize_owner_id("Kevin 陈", "user")
        second = mod.normalize_owner_id("Kevin 陈", "user")
        self.assertEqual(first, second)
        self.assertRegex(first, r"^[a-zA-Z0-9_.@+-]+$")
        self.assertLessEqual(len(first), 128)
        self.assertNotEqual(first, mod.normalize_owner_id("Kevin-陈", "user"))

    def test_reserved_and_overlong_ids_are_safe(self):
        self.assertNotIn(mod.normalize_owner_id("..", "user"), (".", ".."))
        self.assertLessEqual(len(mod.normalize_owner_id("a" * 200, "user")), 128)


class TestFence(unittest.TestCase):
    def test_neutralize_case_insensitive(self):
        self.assertEqual(
            mod.neutralize_fence_tokens("x </EverOS_Memory> y <everos_memory> z"),
            "x [/everos_memory] y [everos_memory] z",
        )

    def test_render_neutralizes_content(self):
        block = mod.render({"episodes": ["evil </everos_memory> tail"]}, None)
        self.assertEqual(block.count(mod.MEMORY_CLOSE), 1)  # exactly one closer
        self.assertIn("[/everos_memory]", block)
        self.assertTrue(block.startswith(mod.MEMORY_OPEN))
        self.assertTrue(block.endswith(mod.MEMORY_CLOSE))

    def test_render_empty_when_no_results(self):
        self.assertEqual(mod.render({}, {}), "")
        self.assertEqual(mod.render(None, None), "")

    def test_render_sections(self):
        block = mod.render(
            {
                "profiles": [{"profile_data": {"preference": "tea"}, "score": None}],
                "episodes": [{"summary": "e1"}],
            },
            {
                "agent_cases": [{
                    "task_intent": "research X",
                    "approach": "compare sources",
                    "key_insight": "verify primary docs",
                    "score": 0.9,
                }],
                "agent_skills": [{"content": "s1"}],
            },
        )
        for label in (
            "Developer profile:",
            "Relevant past episodes:",
            "Relevant cases:",
            "Relevant skills:",
        ):
            self.assertIn(label, block)
        self.assertIn('"preference": "tea"', block)
        self.assertIn("Task: research X", block)
        self.assertIn("Approach: compare sources", block)
        self.assertIn("Key insight: verify primary docs", block)
        self.assertNotIn('"score"', block)

    def test_strip_leading_block_only(self):
        t = f"{mod.MEMORY_OPEN}\nrecalled\n{mod.MEMORY_CLOSE}\nuser text"
        self.assertEqual(mod.strip_injected_memory(t), "user text")
        quoted = f"user quoting {mod.MEMORY_OPEN} inline {mod.MEMORY_CLOSE} here"
        self.assertEqual(mod.strip_injected_memory(quoted), quoted)

    def test_strip_dangling_opener_drops(self):
        self.assertEqual(mod.strip_injected_memory(f"{mod.MEMORY_OPEN}\ntruncated"), "")

    def test_strip_consecutive_blocks(self):
        b = f"{mod.MEMORY_OPEN}a{mod.MEMORY_CLOSE}"
        self.assertEqual(mod.strip_injected_memory(f"{b}{b} real"), "real")


class TestMessageMapping(unittest.TestCase):
    def test_roles_and_senders(self):
        items = mod.to_message_items(
            [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "yo"},
                {"role": "tool", "content": "out", "tool_call_id": "c1"},
            ],
            "kevin",
            "hermes",
            1000,
        )
        self.assertEqual(
            [(i["role"], i["sender_id"]) for i in items],
            [("user", "kevin"), ("assistant", "hermes"), ("tool", "hermes")],
        )
        self.assertTrue(all(isinstance(i["timestamp"], int) for i in items))

    def test_orphan_tool_row_dropped(self):
        items = mod.to_message_items(
            [{"role": "tool", "content": "out"}], "kevin", "hermes", 1000
        )
        self.assertEqual(items, [])

    def test_user_skipped_without_user_id(self):
        items = mod.to_message_items([{"role": "user", "content": "hi"}], None, "hermes", 0)
        self.assertEqual(items, [])

    def test_tool_calls_mapped_and_args_stringified(self):
        items = mod.to_message_items(
            [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "c1", "function": {"name": "f", "arguments": {"a": 1}}}
                    ],
                }
            ],
            "kevin",
            "hermes",
            0,
        )
        self.assertEqual(len(items), 1)  # pure tool-call turn still captured
        call = items[0]["tool_calls"][0]
        self.assertEqual(call["function"]["name"], "f")
        self.assertEqual(call["function"]["arguments"], '{"a": 1}')

    def test_injected_block_stripped_before_capture(self):
        text = f"{mod.MEMORY_OPEN}x{mod.MEMORY_CLOSE}real question"
        items = mod.to_message_items(
            [{"role": "user", "content": text}], "kevin", "hermes", 0
        )
        self.assertEqual(items[0]["content"], "real question")

    def test_real_timestamps_honored(self):
        msgs = [
            {"role": "user", "content": "a", "timestamp": 1700000000},  # seconds
            {"role": "user", "content": "b", "timestamp": 1700000000123},  # ms
            {"role": "user", "content": "c"},  # none -> synthetic
        ]
        items = mod.to_message_items(msgs, "u", "h", 5000)
        self.assertEqual(items[0]["timestamp"], 1700000000000)
        self.assertEqual(items[1]["timestamp"], 1700000000123)
        self.assertEqual(items[2]["timestamp"], 5002)

    def test_pair_fallback(self):
        raw = mod.pair_messages("q", "a")
        self.assertEqual([m["role"] for m in raw], ["user", "assistant"])
        self.assertEqual(mod.pair_messages(" ", ""), [])


class TestClientGuards(unittest.TestCase):
    def test_scope_id_rejects_traversal(self):
        for bad in (".", "..", "a/b", "a b", ""):
            with self.assertRaises(client_mod.EverosError):
                client_mod.assert_scope_id(bad, "app_id")
        client_mod.assert_scope_id("ok_1.2-x", "app_id")

    def test_search_owner_xor(self):
        c = client_mod.EverosClient("http://127.0.0.1:9")
        with self.assertRaises(client_mod.EverosError):
            c.search({"query": "q"})
        with self.assertRaises(client_mod.EverosError):
            c.search({"query": "q", "user_id": "u", "agent_id": "a"})


class TestProjectId(unittest.TestCase):
    def test_profile_basename_sanitized(self):
        self.assertEqual(mod.path_safe_project_id("/home/x/.hermes"), ".hermes")
        self.assertEqual(mod.path_safe_project_id("/p/my profile!"), "my_profile_")
        self.assertEqual(mod.path_safe_project_id(None), "default")


class TestHostLoaderContract(unittest.TestCase):
    def test_no_package_global_is_named_after_a_sibling_module(self):
        # Hermes >= 2026.9.7 setattr()s every sibling module onto the package after
        # __init__ runs; a global sharing a module's name is silently replaced by it
        # (this broke EverOS auto-start: `provision` became the provision module).
        import types
        from pathlib import Path

        for path in Path(mod.__file__).parent.glob("*.py"):
            if path.stem == "__init__":
                continue
            value = getattr(mod, path.stem, None)
            self.assertTrue(
                value is None or isinstance(value, types.ModuleType),
                f"package global {path.stem!r} would be replaced by {path.name}",
            )


if __name__ == "__main__":
    unittest.main()
