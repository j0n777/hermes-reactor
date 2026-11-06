"""Reactor for Hermes: a voice command center for your coding agents (Python side).

The Desktop side (reactor, agents panel, approval cards) lives in desktop/plugin.js and is loaded by Hermes Desktop.
"""

from pathlib import Path

from .reactor_hermes import assistant, kanban_hooks, schemas, tools
from .reactor_hermes.setup_cmd import handle as _handle_cli
from .reactor_hermes.setup_cmd import setup_argparse as _setup_cli

_HANDLERS = {
    "reactor_list_sessions": tools.reactor_list_sessions,
    "reactor_session_brief": tools.reactor_session_brief,
    "reactor_continue_session": tools.reactor_continue_session,
    "reactor_explain_risk": tools.reactor_explain_risk,
    "reactor_show": tools.reactor_show,
    "reactor_ask_profile": tools.reactor_ask_profile,
}


def register(ctx):
    for schema in schemas.ALL:
        ctx.register_tool(
            name=schema["name"],
            toolset="reactor",
            schema=schema,
            handler=_HANDLERS[schema["name"]],
        )
    # The persona line (the assistant's name and the reply language) rides on the documented pre_llm_call context.
    ctx.register_hook("pre_llm_call", assistant.pre_llm_call)
    kanban_hooks.register(ctx)  # read-only observers
    ctx.register_cli_command(
        name="reactor",
        help="Reactor voice command center: setup",
        setup_fn=_setup_cli,
        handler_fn=_handle_cli,
    )
    skills_dir = Path(__file__).parent / "skills"
    if skills_dir.is_dir():
        for child in sorted(skills_dir.iterdir()):
            skill_md = child / "SKILL.md"
            if child.is_dir() and skill_md.exists():
                ctx.register_skill(child.name, skill_md)
