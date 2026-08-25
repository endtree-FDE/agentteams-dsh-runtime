from __future__ import annotations

import asyncio
import argparse
import importlib.metadata
import json
import os
import subprocess

from acp import run_agent
from deepagents import create_deep_agent
from deepagents_acp.server import AgentServerACP, AgentSessionContext
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph


SYSTEM_PROMPT = """你是据场的复杂证据核验 Agent。
只根据任务提供的证据作答，未知保持未知。只输出一个 JSON 对象。
对象包含 status、facts、conflicts、unknownFields、nextAction；facts/conflicts 的 evidenceRefs 只能引用输入中的 ref。
status 只能是 completed 或 blocked。不能批准、发布、退款、外发或写入生产数据，最终决定必须交给具名人工。
"""


class DshChatModel(BaseChatModel):
    cwd: str

    @property
    def _llm_type(self) -> str:
        return "agentteams-dsh-driver"

    def bind_tools(self, _tools, **_kwargs):
        return self

    @staticmethod
    def _text(content: object) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(item.get("text", "") for item in content if isinstance(item, dict))
        return ""

    def _generate(self, messages: list[BaseMessage], stop=None, run_manager=None, **_kwargs) -> ChatResult:
        del stop, run_manager
        evidence = next((self._text(message.content) for message in reversed(messages) if self._text(message.content)), "")
        if not evidence:
            raise RuntimeError("deepagents_missing_evidence")
        child_env = os.environ.copy()
        child_env["DSH_HOME"] = os.environ["JUCHANG_DSH_INNER_HOME"]
        prompt = "\n".join([
            "Return one compact JSON object only with status, facts, conflicts, unknownFields, nextAction.",
            "Every fact or conflict needs non-empty evidenceRefs copied from INPUT refs.",
            "status is completed or blocked. Never approve or perform an external write.",
            "INPUT:",
            evidence,
        ])
        result = subprocess.run(
            [os.environ["JUCHANG_DSH_NODE"], os.environ["JUCHANG_DSH_BIN"], "--profile", "headless", "--patch", os.environ["JUCHANG_DSH_MODEL_PATCH"], prompt],
            cwd=self.cwd,
            env=child_env,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=180,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError("deepagents_dsh_driver_failed")
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=result.stdout.strip()))])


def build_agent(context: AgentSessionContext):
    return create_deep_agent(
        model=DshChatModel(cwd=context.cwd),
        system_prompt=SYSTEM_PROMPT,
        checkpointer=MemorySaver(),
    )


def build_smoke_agent():
    def respond(_state: MessagesState):
        return {"messages": [AIMessage(content=json.dumps({
            "status": "completed",
            "facts": [],
            "conflicts": [],
            "unknownFields": ["model_not_invoked_in_transport_smoke"],
            "nextAction": "人工复核。",
        }, ensure_ascii=False))]}

    graph = StateGraph(MessagesState)
    graph.add_node("receipt", respond)
    graph.add_edge(START, "receipt")
    graph.add_edge("receipt", END)
    return graph.compile(checkpointer=MemorySaver())


def self_check() -> None:
    context = AgentSessionContext(cwd=os.getcwd(), mode="default")
    agent = build_agent(context)
    assert callable(agent.invoke)
    print(json.dumps({
        "ok": True,
        "deepagents": importlib.metadata.version("deepagents"),
        "deepagents-acp": importlib.metadata.version("deepagents-acp"),
        "driver": "dsh",
    }))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    await run_agent(AgentServerACP(agent=build_smoke_agent() if args.smoke else build_agent))


if __name__ == "__main__":
    asyncio.run(main())
