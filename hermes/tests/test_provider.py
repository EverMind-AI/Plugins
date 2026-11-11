"""Provider contract tests against a fake client (no Hermes, no EverOS)."""
from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from _load import load_plugin

mod = load_plugin()
client_mod = __import__(f"{mod.__name__}.client", fromlist=["*"])
provision_mod = __import__(f"{mod.__name__}.provision", fromlist=["*"])


class FakeClient:
    """Records calls; canned per-owner search results; scriptable add errors."""

    def __init__(self):
        self.base_url = "http://127.0.0.1:8000"
        self.calls = []
        self.search_results = {}
        self.add_errors = []
        self.health_ok = False

    def health(self, timeout_s=None):
        self.calls.append(("health", None))
        if self.health_ok:
            return {"status": "ok"}
        raise client_mod.EverosError(0, "NETWORK_ERROR", "down")

    def search(self, req, timeout_s=None):
        self.calls.append(("search", req))
        owner = "user" if "user_id" in req else "agent"
        res = self.search_results.get(owner)
        if isinstance(res, Exception):
            raise res
        return res or {}

    def add(self, req, timeout_s=None):
        self.calls.append(("add", req))
        if self.add_errors:
            raise self.add_errors.pop(0)
        return {"message_count": len(req["messages"]), "status": "accumulated"}

    def flush(self, req, timeout_s=None):
        self.calls.append(("flush", req))
        return {"status": "extracted"}

    def of(self, kind):
        return [req for k, req in self.calls if k == kind]


def make_provider(tmp_home: str, agent_context: str = "primary", **init_kwargs):
    """Provider with inline daemons, provisioning stubbed, and a fake client."""
    provider = mod.EverosMemoryProvider()
    real_spawn, real_provision = mod._spawn_daemon, mod.provision
    mod._spawn_daemon = lambda fn: fn()
    mod.provision = lambda *a, **k: provision_mod.ProvisionResult("failed", "stubbed")
    try:
        provider.initialize(
            "session-1",
            hermes_home=tmp_home,
            platform="cli",
            agent_context=agent_context,
            **init_kwargs,
        )
    finally:
        mod._spawn_daemon = real_spawn
        mod.provision = real_provision
    fake = FakeClient()
    provider._client = fake
    # inline daemons for the provider's later background posts
    return provider, fake


class TestLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real_spawn = mod._spawn_daemon
        mod._spawn_daemon = lambda fn: fn()

    def tearDown(self):
        mod._spawn_daemon = self.real_spawn
        self.tmp.cleanup()

    def test_is_available_makes_no_network_calls(self):
        provider, fake = make_provider(self.tmp.name)
        fake.calls.clear()
        self.assertTrue(provider.is_available())
        self.assertEqual(fake.calls, [])

    def test_initialize_stores_and_clips_session_id(self):
        provider, _ = make_provider(self.tmp.name)
        self.assertEqual(provider._sid, "session-1")
        real_provision = mod.provision  # keep the re-init from real provisioning
        mod.provision = lambda *a, **k: provision_mod.ProvisionResult("failed", "stub")
        try:
            provider.initialize("x" * 200, hermes_home=self.tmp.name)
        finally:
            mod.provision = real_provision
        self.assertEqual(len(provider._sid), 128)

    def test_left_running_child_kept_for_shutdown(self):
        provider = mod.EverosMemoryProvider()
        real_spawn, real_provision = mod._spawn_daemon, mod.provision

        class DeadChild:
            def poll(self):
                return 0

        child = DeadChild()
        mod._spawn_daemon = lambda fn: fn()
        mod.provision = lambda *a, **k: provision_mod.ProvisionResult(
            "failed", "readiness timeout (left running)", child=child
        )
        try:
            provider.initialize("s", hermes_home=self.tmp.name)
        finally:
            mod._spawn_daemon = real_spawn
            mod.provision = real_provision
        self.assertIs(provider._child, child)

    def test_shutdown_flushes(self):
        provider, fake = make_provider(self.tmp.name)
        provider.shutdown()
        self.assertEqual(len(fake.of("flush")), 1)


class TestPrefetch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real_spawn = mod._spawn_daemon
        mod._spawn_daemon = lambda fn: fn()
        self.provider, self.fake = make_provider(self.tmp.name)

    def tearDown(self):
        mod._spawn_daemon = self.real_spawn
        self.tmp.cleanup()

    def test_two_owner_scoped_searches_with_matching_scope(self):
        self.fake.search_results = {
            "user": {"episodes": ["e1"], "profiles": ["p1"]},
            "agent": {"agent_cases": ["c1"], "agent_skills": []},
        }
        block = self.provider.prefetch("what was the port decision?")
        searches = self.fake.of("search")
        self.assertEqual(len(searches), 2)
        for req in searches:
            self.assertEqual(req["app_id"], "hermes")
            self.assertEqual(req["project_id"], self.provider._project)
        user_req = next(r for r in searches if "user_id" in r)
        self.assertTrue(user_req["include_profile"])
        self.assertIn("e1", block)
        self.assertIn("c1", block)
        self.assertTrue(block.startswith(mod.MEMORY_OPEN))

    def test_fail_open_on_search_error(self):
        self.fake.search_results = {
            "user": client_mod.EverosError(0, "NETWORK_ERROR", "down"),
            "agent": client_mod.EverosError(0, "NETWORK_ERROR", "down"),
        }
        self.assertEqual(self.provider.prefetch("q"), "")

    def test_empty_query_returns_empty(self):
        self.assertEqual(self.provider.prefetch("   "), "")
        self.assertEqual(self.fake.of("search"), [])

    def test_query_is_weight_clipped(self):
        self.fake.search_results = {"agent": {}}
        self.provider.prefetch("中" * 400)  # 800 units -> clipped to 250 chars
        q = self.fake.of("search")[0]["query"]
        self.assertEqual(q, "中" * 250)


class TestPrefetchHardening(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real_spawn = mod._spawn_daemon
        mod._spawn_daemon = lambda fn: fn()

    def tearDown(self):
        mod._spawn_daemon = self.real_spawn
        self.tmp.cleanup()

    def test_prefetch_skips_slash_and_skill_activation_turns(self):
        provider, fake = make_provider(self.tmp.name)
        self.assertEqual(provider.prefetch("/ship"), "")
        self.assertEqual(provider.prefetch("/i-have-adhd\n/caveman"), "")
        self.assertEqual(fake.of("search"), [])

    def test_prefetch_shared_recall_app_id(self):
        (Path(self.tmp.name) / "everos.json").write_text(
            json.dumps({"recall_app_id": "shared"}), encoding="utf-8"
        )
        provider, fake = make_provider(self.tmp.name)
        fake.search_results = {"user": {"episodes": ["cross-harness fact"]}, "agent": {}}
        block = provider.prefetch("what is the deployment topology?")
        self.assertIn("cross-harness fact", block)
        for req in fake.of("search"):
            self.assertEqual(req["app_id"], "shared")
            self.assertEqual(req["project_id"], "default")
        # Capture still writes to app_id="hermes"
        provider.sync_turn("question", "answer", session_id="s-shared")
        adds = fake.of("add")
        self.assertEqual(len(adds), 1)
        self.assertEqual(adds[0]["app_id"], "hermes")

    def test_prefetch_augments_cwd_from_agent_workspace(self):
        provider, fake = make_provider(self.tmp.name, agent_workspace="/repos/my-service")
        fake.search_results = {"agent": {}}
        provider.prefetch("database schema")
        q = fake.of("search")[0]["query"]
        self.assertEqual(q, "my-service: database schema")

    def test_prefetch_filters_noise_episodes(self):
        provider, fake = make_provider(self.tmp.name)
        fake.search_results = {
            "user": {
                "episodes": [
                    {"subject": "Session", "summary": "User activated a series of skills and modes."},
                    {"subject": "DB", "summary": "Use PostgreSQL 16 for primary OLTP."},
                ]
            },
            "agent": {},
        }
        block = provider.prefetch("which database?")
        self.assertIn("DB: Use PostgreSQL 16 for primary OLTP.", block)
        self.assertNotIn("activated a series of skills", block)


class TestSyncTurn(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real_spawn = mod._spawn_daemon
        mod._spawn_daemon = lambda fn: fn()
        self.provider, self.fake = make_provider(self.tmp.name)

    def tearDown(self):
        mod._spawn_daemon = self.real_spawn
        self.tmp.cleanup()

    def test_full_messages_captured(self):
        self.provider.sync_turn(
            "q",
            "a",
            session_id="s2",
            messages=[
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": "a"},
            ],
        )
        adds = self.fake.of("add")
        self.assertEqual(len(adds), 1)
        self.assertEqual(adds[0]["session_id"], "s2")
        self.assertEqual(adds[0]["app_id"], "hermes")
        self.assertEqual(len(adds[0]["messages"]), 2)
        self.assertEqual(self.provider._sid, "s2")  # capture retargets the sid

    def test_pair_fallback_without_messages(self):
        self.provider.sync_turn("q", "a")
        msgs = self.fake.of("add")[0]["messages"]
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant"])

    def test_sync_turn_skips_skill_activation_noise(self):
        self.provider.sync_turn("/i-have-adhd\n/caveman", "Activated modes.")
        self.assertEqual(self.fake.of("add"), [])

    def test_non_primary_context_never_writes(self):
        provider, fake = make_provider(self.tmp.name, agent_context="cron")
        provider.sync_turn("q", "a", session_id="s")
        provider.on_memory_write("add", "user", "fact")
        provider.on_delegation("t", "r")
        self.assertEqual(fake.of("add"), [])

    def test_oversized_turn_chunked(self):
        msgs = [{"role": "user", "content": f"m{i}"} for i in range(501)]
        self.provider.sync_turn("q", "a", session_id="s", messages=msgs)
        adds = self.fake.of("add")
        self.assertEqual([len(a["messages"]) for a in adds], [500, 1])

    def test_media_rejection_retries_text_only(self):
        self.fake.add_errors = [client_mod.EverosError(415, "MULTIMODAL", "no media")]
        self.provider.sync_turn(
            "q",
            "a",
            session_id="s",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "see pic"},
                        {"type": "image_url", "image_url": {"url": "http://x/pic.png"}},
                    ],
                }
            ],
        )
        adds = self.fake.of("add")
        self.assertEqual(len(adds), 2)
        self.assertIsInstance(adds[0]["messages"][0]["content"], list)  # structured try
        self.assertIsInstance(adds[1]["messages"][0]["content"], str)  # flattened retry

    def test_string_image_url_does_not_crash(self):
        # some hosts send image_url as a bare string, not the OpenAI dict
        self.provider.sync_turn(
            "q",
            "a",
            session_id="s",
            messages=[
                {"role": "user", "content": [{"type": "image_url", "image_url": "http://x/p.png"}]}
            ],
        )
        adds = self.fake.of("add")
        self.assertEqual(len(adds), 1)
        self.assertEqual(adds[0]["messages"][0]["content"][0]["uri"], "http://x/p.png")

    def test_seal_waits_for_inflight_capture(self):
        mod._spawn_daemon = self.real_spawn  # real background thread here
        real_add = self.fake.add

        def slow_add(req, timeout_s=None):
            time.sleep(0.15)
            return real_add(req, timeout_s)

        self.fake.add = slow_add
        self.provider.sync_turn("q", "a", session_id="s")
        self.provider.on_session_end([])
        kinds = [k for k, _ in self.fake.calls]
        self.assertIn("add", kinds)
        self.assertLess(kinds.index("add"), kinds.index("flush"))

    def test_transient_error_not_resent(self):
        self.fake.add_errors = [client_mod.EverosError(500, "SYSTEM_ERROR", "boom")]
        self.provider.sync_turn("q", "a", session_id="s")
        self.assertEqual(len(self.fake.of("add")), 1)  # no mutated re-send


class TestSeals(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real_spawn = mod._spawn_daemon
        mod._spawn_daemon = lambda fn: fn()
        self.provider, self.fake = make_provider(self.tmp.name)

    def tearDown(self):
        mod._spawn_daemon = self.real_spawn
        self.tmp.cleanup()

    def test_session_end_flushes_current_sid(self):
        self.provider.on_session_end([])
        self.assertEqual(self.fake.of("flush")[0]["session_id"], "session-1")

    def test_pre_compress_flushes_and_returns_str(self):
        out = self.provider.on_pre_compress([])
        self.assertEqual(out, "")
        self.assertEqual(len(self.fake.of("flush")), 1)

    def test_session_switch_reset_seals_old_then_swaps(self):
        self.provider.on_session_switch("session-2", reset=True)
        flushes = self.fake.of("flush")
        self.assertEqual(flushes[0]["session_id"], "session-1")
        self.assertEqual(self.provider._sid, "session-2")

    def test_session_switch_resume_only_swaps(self):
        self.provider.on_session_switch("session-3", reset=False)
        self.assertEqual(self.fake.of("flush"), [])
        self.assertEqual(self.provider._sid, "session-3")

    def test_flush_fail_open(self):
        def boom(req, timeout_s=None):
            raise client_mod.EverosError(0, "NETWORK_ERROR", "down")

        self.fake.flush = boom
        self.provider.on_session_end([])  # must not raise


class TestMirrors(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real_spawn = mod._spawn_daemon
        mod._spawn_daemon = lambda fn: fn()
        self.provider, self.fake = make_provider(self.tmp.name)

    def tearDown(self):
        mod._spawn_daemon = self.real_spawn
        self.tmp.cleanup()

    def test_memory_write_user_vs_agent_target(self):
        self.provider.on_memory_write("add", "user", "likes tea")
        self.provider.on_memory_write("replace", "memory", "repo uses uv")
        adds = self.fake.of("add")
        self.assertEqual(adds[0]["messages"][0]["role"], "user")
        self.assertEqual(adds[1]["messages"][0]["role"], "assistant")
        self.assertIn("likes tea", adds[0]["messages"][0]["content"])

    def test_memory_remove_skipped(self):
        self.provider.on_memory_write("remove", "user", "stale fact")
        self.assertEqual(self.fake.of("add"), [])

    def test_delegation_feeds_agent_track(self):
        self.provider.on_delegation("research X", "found Y", child_session_id="c1")
        msg = self.fake.of("add")[0]["messages"][0]
        self.assertEqual(msg["role"], "assistant")
        self.assertIn("research X", msg["content"])
        self.assertIn("found Y", msg["content"])


class TestConfigAndSchema(unittest.TestCase):
    def test_tool_schemas_empty(self):
        self.assertEqual(mod.EverosMemoryProvider().get_tool_schemas(), [])

    def test_save_then_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as home:
            p = mod.EverosMemoryProvider()
            p.save_config({"base_url": "localhost:9999", "agent_id": "h2"}, home)
            cfg = mod.load_config(home)
            self.assertEqual(cfg.base_url, "http://localhost:9999")
            self.assertEqual(cfg.agent_id, "h2")
            data = json.loads((Path(home) / "everos.json").read_text())
            self.assertEqual(data["agent_id"], "h2")

    def test_wrong_typed_config_values_do_not_crash(self):
        cfg = mod.Config(
            {"base_url": 123, "user_id": 42, "agent_id": None, "start_cmd": 7,
             "query_max_units": "abc"}
        )
        self.assertEqual(cfg.base_url, mod.DEFAULTS["base_url"])
        self.assertEqual(cfg.agent_id, mod.DEFAULTS["agent_id"])
        self.assertEqual(cfg.query_max_units, 500)
        self.assertIsNone(cfg.start_cmd)

    def test_config_schema_keys(self):
        keys = {f["key"] for f in mod.EverosMemoryProvider().get_config_schema()}
        self.assertEqual(
            keys,
            {
                "base_url",
                "user_id",
                "agent_id",
                "recall_app_id",
                "augment_cwd",
                "enable_tools",
                "probe_health_on_available",
                "query_max_units",
                "everos_dir",
                "start_cmd",
            },
        )


class TestToolsAndAvailability(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real_spawn = mod._spawn_daemon
        self.real_sleep = mod._sleep
        mod._spawn_daemon = lambda fn: fn()
        mod._sleep = lambda _s: None

    def tearDown(self):
        mod._spawn_daemon = self.real_spawn
        mod._sleep = self.real_sleep
        self.tmp.cleanup()

    def test_tools_disabled_by_default_and_enabled_via_config(self):
        p_default, _ = make_provider(self.tmp.name)
        self.assertEqual(p_default.get_tool_schemas(), [])
        self.assertEqual(p_default.system_prompt_block(), "")

        (Path(self.tmp.name) / "everos.json").write_text(
            json.dumps({"enable_tools": True, "recall_app_id": "shared"}), encoding="utf-8"
        )
        p_enabled, _ = make_provider(self.tmp.name)
        names = [t["name"] for t in p_enabled.get_tool_schemas()]
        self.assertEqual(names, ["everos_recall", "everos_retain"])
        self.assertIn("everos_recall", p_enabled.system_prompt_block())
        self.assertIn("shared", p_enabled.system_prompt_block())

    def test_handle_tool_call_recall_and_retain(self):
        (Path(self.tmp.name) / "everos.json").write_text(
            json.dumps({"enable_tools": True, "recall_app_id": "shared"}), encoding="utf-8"
        )
        provider, fake = make_provider(self.tmp.name)
        fake.search_results = {
            "user": {"episodes": [{"subject": "DB", "summary": "Use SQLite WAL mode."}]},
            "agent": {},
        }
        rec_out = json.loads(
            provider.handle_tool_call("everos_recall", {"query": "SQLite mode", "max_tokens": 500})
        )
        self.assertIn("DB: Use SQLite WAL mode.", rec_out["results"])

        ret_out = json.loads(
            provider.handle_tool_call(
                "everos_retain", {"content": "Always pin 40-char SHA", "context": "security"}
            )
        )
        self.assertEqual(ret_out["status"], "extracted")
        adds = fake.of("add")
        flushes = fake.of("flush")
        self.assertEqual(len(adds), 1)
        self.assertEqual(len(flushes), 1)
        self.assertIn("[security] Always pin 40-char SHA", adds[0]["messages"][0]["content"])

    def test_is_available_health_probe_and_restart_blip_resilience(self):
        (Path(self.tmp.name) / "everos.json").write_text(
            json.dumps({"probe_health_on_available": True, "everos_dir": self.tmp.name}),
            encoding="utf-8",
        )
        provider, fake = make_provider(self.tmp.name)
        fake.health_ok = True
        self.assertTrue(provider.is_available())

        # Transient restart blip: health fails across retries, but local everos_dir keeps provider available
        fake.health_ok = False
        self.assertTrue(provider.is_available())
        self.assertIn("retry failed", provider.unavailable_reason())

        # Unconfigured remote server down -> returns False
        (Path(self.tmp.name) / "everos.json").write_text(
            json.dumps(
                {
                    "probe_health_on_available": True,
                    "base_url": "http://remote-everos.example.invalid:8000",
                }
            ),
            encoding="utf-8",
        )
        p_remote, fake_remote = make_provider(self.tmp.name)
        fake_remote.health_ok = False
        real_has_local = mod._has_local_everos_install
        mod._has_local_everos_install = lambda _cfg: False
        try:
            self.assertFalse(p_remote.is_available())
            self.assertIn("probe failed", p_remote.unavailable_reason())
        finally:
            mod._has_local_everos_install = real_has_local


class TestRegister(unittest.TestCase):
    def test_register_wires_provider_and_cli(self):
        calls = {}

        class Ctx:
            def register_memory_provider(self, p):
                calls["provider"] = p

            def register_cli_command(self, name, help, setup_fn, handler_fn=None, description=""):
                calls["cli"] = name
                calls["setup_fn"] = setup_fn

        mod.register(Ctx())
        self.assertEqual(calls["provider"].name, "everos")
        self.assertEqual(calls["cli"], "everos")

    def test_register_tolerates_host_without_cli_api(self):
        class Ctx:
            def register_memory_provider(self, p):
                pass

        mod.register(Ctx())  # must not raise


if __name__ == "__main__":
    unittest.main()
