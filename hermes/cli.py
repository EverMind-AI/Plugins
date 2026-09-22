"""Optional CLI: ``hermes everos [status]`` — is the provider configured and
is EverOS reachable? Read-only; safe to run any time.

Wired from ``register(ctx)`` via ``ctx.register_cli_command`` (the
PluginContext API); ``setup_cli`` receives our subparser, ``run_status`` is
the default handler.

NOTE: the host imports this file as ``_hermes_user_memory.<name>.cli`` under a
*synthetic* package whose ``__init__.py`` is NOT executed (see
``hermes/plugins/memory/__init__.py::discover_plugin_cli_commands``), so any
``from . import X`` here fails with ImportError. Keep this module
self-contained: stdlib only, no package-relative imports.
"""
from __future__ import annotations

import json
import os
import urllib.request
from typing import Any

DEFAULT_BASE_URL = "http://127.0.0.1:8000"


def _load_config(hermes_home: str) -> dict[str, Any]:
    """Read ``$HERMES_HOME/everos.json``; missing/corrupt -> {} (fail-open)."""
    try:
        from pathlib import Path

        raw = (Path(hermes_home) / "everos.json").read_text(encoding="utf-8")
        values = json.loads(raw)
        return values if isinstance(values, dict) else {}
    except Exception:
        return {}


def run_status(args: Any = None) -> None:
    hermes_home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    values = _load_config(hermes_home)
    base_url = str(values.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    print(f"config:    {hermes_home}/everos.json")
    print(f"base_url:  {base_url}")
    print(f"user_id:   {values.get('user_id') or '(unset)'}")
    print(f"agent_id:  {values.get('agent_id') or 'hermes'}")
    try:
        with urllib.request.urlopen(base_url + "/health", timeout=3.0) as res:
            payload = json.loads(res.read().decode("utf-8", errors="replace"))
        status = payload.get("status") if isinstance(payload, dict) else None
        print(f"everos:    {'healthy' if status == 'ok' else f'unexpected response ({status!r})'}")
    except Exception as err:
        print(f"everos:    unreachable ({err})")


def setup_cli(parser: Any) -> None:
    """Add arguments/sub-subcommands to the ``hermes everos`` subparser."""
    sub = parser.add_subparsers(dest="everos_cmd")
    status = sub.add_parser("status", help="show config and EverOS health")
    status.set_defaults(func=run_status)
