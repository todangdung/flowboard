"""Recipe workflow builder endpoints.

Turns a selected video recipe into a runnable graph scaffold. This is the
deterministic bridge between recipe readiness and actual production flow:
refs -> first-frame image -> video node.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Board, Edge, Node
from flowboard.routes.edges import RefRole
from flowboard.routes.nodes import NodeType
from flowboard.services.llm import run_llm
from flowboard.services.llm.base import LLMError
from flowboard.services.video_recipes import normalize_video_recipe_id
from flowboard.short_id import generate_unique_short_id

router = APIRouter(prefix="/api/recipes", tags=["recipes"])

_COORD_MIN = -1_000_000.0
_COORD_MAX = 1_000_000.0


@dataclass(frozen=True)
class WorkflowNodeSpec:
    key: str
    type: str
    title: str
    dx: int
    dy: int
    data: dict = field(default_factory=dict)
    role: Optional[str] = None


@dataclass(frozen=True)
class WorkflowEdgeSpec:
    source: str
    target: str
    role: str


@dataclass(frozen=True)
class RecipeWorkflowSpec:
    nodes: tuple[WorkflowNodeSpec, ...]
    edges: tuple[WorkflowEdgeSpec, ...]
    video_key: str
    frame_key: Optional[str] = None


_WORKFLOWS: dict[str, RecipeWorkflowSpec] = {
    "fashion_fit_check": RecipeWorkflowSpec(
        frame_key="frame",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "character",
                "character",
                "Fit check character",
                0,
                0,
                role="character_ref",
            ),
            WorkflowNodeSpec(
                "outfit",
                "visual_asset",
                "Outfit / garment ref",
                0,
                220,
                role="product_ref",
            ),
            WorkflowNodeSpec(
                "style",
                "prompt",
                "Fit check direction",
                0,
                440,
                data={
                    "prompt": (
                        "full outfit visible, mirror or try-on framing, natural "
                        "small movement, fabric and fit remain readable"
                    ),
                    "status": "done",
                },
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "frame",
                "image",
                "Fit check first frame",
                360,
                110,
                data={
                    "prompt": (
                        "Photoreal editorial fashion photo, full-body try-on "
                        "framing, direct eye contact, closed-mouth neutral "
                        "expression, complete outfit and fabric detail clearly "
                        "readable, soft even key light, clean indoor background."
                    )
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Fashion fit check video",
                720,
                110,
                data={"videoRecipeId": "fashion_fit_check"},
            ),
        ),
        edges=(
            WorkflowEdgeSpec("character", "frame", "character_ref"),
            WorkflowEdgeSpec("outfit", "frame", "product_ref"),
            WorkflowEdgeSpec("style", "frame", "style_ref"),
            WorkflowEdgeSpec("frame", "video", "first_frame"),
            WorkflowEdgeSpec("character", "video", "character_ref"),
            WorkflowEdgeSpec("outfit", "video", "product_ref"),
            WorkflowEdgeSpec("style", "video", "style_ref"),
        ),
    ),
    "mirror_selfie": RecipeWorkflowSpec(
        frame_key="frame",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "character",
                "character",
                "Selfie character",
                0,
                0,
                role="character_ref",
            ),
            WorkflowNodeSpec(
                "style",
                "prompt",
                "Mirror selfie direction",
                0,
                220,
                data={
                    "prompt": (
                        "mirror selfie, phone visible but stable, casual handheld "
                        "feel, reflection geometry remains natural"
                    ),
                    "status": "done",
                },
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "frame",
                "image",
                "Mirror selfie first frame",
                360,
                80,
                data={
                    "prompt": (
                        "Photoreal mirror selfie first frame, phone held naturally, "
                        "outfit visible, reflection geometry stable, direct composed "
                        "gaze, closed-mouth neutral expression, clean room light."
                    )
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Mirror selfie video",
                720,
                80,
                data={"videoRecipeId": "mirror_selfie"},
            ),
        ),
        edges=(
            WorkflowEdgeSpec("character", "frame", "character_ref"),
            WorkflowEdgeSpec("style", "frame", "style_ref"),
            WorkflowEdgeSpec("frame", "video", "first_frame"),
            WorkflowEdgeSpec("character", "video", "character_ref"),
            WorkflowEdgeSpec("style", "video", "style_ref"),
        ),
    ),
    "product_demo": RecipeWorkflowSpec(
        frame_key="frame",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "product",
                "visual_asset",
                "Product ref",
                0,
                0,
                role="product_ref",
            ),
            WorkflowNodeSpec(
                "frame",
                "image",
                "Product demo first frame",
                360,
                0,
                data={
                    "prompt": (
                        "Photoreal product demo first frame, product centered and "
                        "fully readable, clean tabletop or hand-held setup, exact "
                        "shape and label area preserved, soft commercial lighting."
                    )
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Product demo video",
                720,
                0,
                data={"videoRecipeId": "product_demo"},
            ),
        ),
        edges=(
            WorkflowEdgeSpec("product", "frame", "product_ref"),
            WorkflowEdgeSpec("frame", "video", "first_frame"),
            WorkflowEdgeSpec("product", "video", "product_ref"),
        ),
    ),
}

_ROLE_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("first_frame", ("first frame", "source frame", "opening frame", "start frame", "still")),
    ("last_frame", ("last frame", "final frame", "end frame")),
    ("package_ref", ("package", "packaging", "box", "carton", "unbox")),
    ("product_ref", ("product", "garment", "outfit", "shirt", "dress", "bottle", "serum", "cream", "shoe")),
    ("background_ref", ("background", "location", "room", "cafe", "street", "park", "interior", "exterior", "scene")),
    ("style_ref", ("style", "mood", "tone", "palette", "lighting", "aesthetic", "direction")),
    ("storyboard_ref", ("storyboard", "panel", "shot list")),
    ("character_ref", ("character", "person", "woman", "man", "model", "face", "portrait")),
)


class RoleClassifyRequest(BaseModel):
    node_id: int
    recipe_id: Optional[str] = None
    use_llm: bool = False


def _edge_context_row(edge: Edge, node: Node) -> dict:
    data = node.data or {}
    text_parts = [
        data.get("title"),
        data.get("aiBrief"),
        data.get("prompt"),
        node.type,
    ]
    text = " ".join(p for p in text_parts if isinstance(p, str)).lower()
    return {
        "edge_id": edge.id,
        "source_node_id": node.id,
        "source_short_id": node.short_id,
        "source_type": node.type,
        "title": data.get("title") if isinstance(data.get("title"), str) else None,
        "brief": data.get("aiBrief") if isinstance(data.get("aiBrief"), str) else None,
        "prompt": data.get("prompt") if isinstance(data.get("prompt"), str) else None,
        "current_role": edge.ref_role,
        "_text": text,
    }


def _heuristic_role(row: dict, target: Node, recipe_id: Optional[str]) -> tuple[str, float, str]:
    source_type = row["source_type"]
    text = row["_text"]

    if source_type == "character":
        return "character_ref", 0.95, "character node"
    if source_type == "visual_asset":
        if any(word in text for word in ("package", "packaging", "box", "unbox")):
            return "package_ref", 0.85, "visual asset looks like packaging"
        return "product_ref", 0.9, "visual asset node"
    if source_type == "prompt":
        if "storyboard" in text:
            return "storyboard_ref", 0.8, "prompt mentions storyboard"
        return "style_ref", 0.75, "prompt node is text direction"
    if source_type == "Storyboard":
        return "storyboard_ref", 0.95, "Storyboard node"

    if target.type == "video" and source_type == "image":
        current = row.get("current_role")
        if current == "first_frame":
            return "first_frame", 0.99, "already labelled first frame"
        if recipe_id in {"fashion_fit_check", "mirror_selfie", "product_demo"}:
            return "first_frame", 0.82, "image feeding single-shot video recipe"

    for role, keywords in _ROLE_KEYWORDS:
        for keyword in keywords:
            if keyword in text:
                return role, 0.7, f"matched keyword {keyword!r}"

    return "ingredient", 0.45, "fallback generic ingredient"


def _suggest_roles_heuristic(rows: list[dict], target: Node, recipe_id: Optional[str]) -> list[dict]:
    suggestions = []
    for row in rows:
        role, confidence, reason = _heuristic_role(row, target, recipe_id)
        suggestions.append(
            {
                "edge_id": row["edge_id"],
                "source_node_id": row["source_node_id"],
                "source_short_id": row["source_short_id"],
                "source_type": row["source_type"],
                "title": row["title"],
                "current_role": row["current_role"],
                "suggested_role": role,
                "confidence": confidence,
                "reason": reason,
            }
        )
    return suggestions


def _strip_json_fence(text: str) -> str:
    out = (text or "").strip()
    if out.startswith("```"):
        out = out.lstrip("`")
        if out.lower().startswith("json"):
            out = out[4:]
        out = out.rsplit("```", 1)[0]
    return out.strip()


async def _suggest_roles_llm(rows: list[dict], target: Node, recipe_id: Optional[str]) -> list[dict]:
    role_values = list(RefRole.__args__)  # type: ignore[attr-defined]
    payload = [
        {
            k: row[k]
            for k in (
                "edge_id",
                "source_node_id",
                "source_short_id",
                "source_type",
                "title",
                "brief",
                "prompt",
                "current_role",
            )
        }
        for row in rows
    ]
    system_prompt = (
        "You classify Flowboard upstream assets into production reference roles. "
        "Return ONLY a JSON array. Each item: edge_id, role, confidence 0-1, reason. "
        f"Allowed roles: {', '.join(role_values)}. Use visible/brief facts; do not invent."
    )
    user_prompt = (
        f"Target node: type={target.type}, title={(target.data or {}).get('title')!r}\n"
        f"Recipe: {recipe_id or 'auto'}\n"
        f"Assets:\n{json.dumps(payload, ensure_ascii=False)}"
    )
    text = await run_llm(
        "auto_prompt",
        user_prompt,
        system_prompt=system_prompt,
        timeout=45.0,
    )
    arr = json.loads(_strip_json_fence(text))
    if not isinstance(arr, list):
        return []
    valid_edge_ids = {row["edge_id"] for row in rows}
    valid_roles = set(role_values)
    out: list[dict] = []
    for item in arr:
        if not isinstance(item, dict):
            continue
        edge_id = item.get("edge_id")
        role = item.get("role") or item.get("suggested_role")
        if edge_id not in valid_edge_ids or role not in valid_roles:
            continue
        conf = item.get("confidence", 0.65)
        try:
            confidence = max(0.0, min(float(conf), 1.0))
        except (TypeError, ValueError):
            confidence = 0.65
        reason = item.get("reason")
        out.append(
            {
                "edge_id": edge_id,
                "suggested_role": role,
                "confidence": confidence,
                "reason": reason if isinstance(reason, str) else "LLM role classifier",
            }
        )
    return out


class SourceBinding(BaseModel):
    node_id: int
    role: RefRole


class WorkflowBuildRequest(BaseModel):
    board_id: int
    recipe_id: str
    x: float = Field(default=0.0, ge=_COORD_MIN, le=_COORD_MAX)
    y: float = Field(default=0.0, ge=_COORD_MIN, le=_COORD_MAX)
    sources: list[SourceBinding] = Field(default_factory=list)
    open_generation: bool = True


def _node_dict(node: Node) -> dict:
    return {
        "id": node.id,
        "board_id": node.board_id,
        "short_id": node.short_id,
        "type": node.type,
        "x": node.x,
        "y": node.y,
        "w": node.w,
        "h": node.h,
        "data": node.data or {},
        "status": node.status,
        "created_at": node.created_at.isoformat() if node.created_at else None,
    }


def _edge_dict(edge: Edge) -> dict:
    return {
        "id": edge.id,
        "board_id": edge.board_id,
        "source_id": edge.source_id,
        "target_id": edge.target_id,
        "kind": edge.kind,
        "source_variant_idx": edge.source_variant_idx,
        "ref_role": edge.ref_role,
    }


@router.post("/build-workflow")
def build_recipe_workflow(body: WorkflowBuildRequest) -> dict:
    recipe_id = normalize_video_recipe_id(body.recipe_id)
    if recipe_id is None or recipe_id not in _WORKFLOWS:
        raise HTTPException(400, f"unsupported recipe_id {body.recipe_id!r}")
    spec = _WORKFLOWS[recipe_id]

    with get_session() as s:
        board = s.get(Board, body.board_id)
        if board is None:
            raise HTTPException(404, "board not found")

        bound_by_role: dict[str, Node] = {}
        for binding in body.sources:
            node = s.get(Node, binding.node_id)
            if node is None:
                raise HTTPException(404, f"source node {binding.node_id} not found")
            if node.board_id != body.board_id:
                raise HTTPException(400, "source node belongs to another board")
            bound_by_role[binding.role] = node

        node_by_key: dict[str, Node] = {}
        created_nodes: list[Node] = []
        created_edges: list[Edge] = []

        for node_spec in spec.nodes:
            bound = bound_by_role.get(node_spec.role or "")
            if bound is not None:
                node_by_key[node_spec.key] = bound
                continue

            data = {"title": node_spec.title, **dict(node_spec.data)}
            status = "done" if data.get("status") == "done" else "idle"
            node = Node(
                board_id=body.board_id,
                short_id=generate_unique_short_id(s, body.board_id),
                type=node_spec.type,
                x=round(body.x + node_spec.dx),
                y=round(body.y + node_spec.dy),
                w=240,
                h=180 if node_spec.type != "prompt" else 120,
                data=data,
                status=status,
            )
            s.add(node)
            s.flush()
            node_by_key[node_spec.key] = node
            created_nodes.append(node)

        for edge_spec in spec.edges:
            source = node_by_key.get(edge_spec.source)
            target = node_by_key.get(edge_spec.target)
            if source is None or target is None or source.id == target.id:
                continue
            edge = Edge(
                board_id=body.board_id,
                source_id=source.id,
                target_id=target.id,
                kind="ref",
                ref_role=edge_spec.role,
            )
            s.add(edge)
            s.flush()
            created_edges.append(edge)

        s.commit()
        for node in created_nodes:
            s.refresh(node)
        for edge in created_edges:
            s.refresh(edge)

        video_node = node_by_key.get(spec.video_key)
        frame_node = node_by_key.get(spec.frame_key) if spec.frame_key else None
        return {
            "recipe_id": recipe_id,
            "nodes": [_node_dict(n) for n in created_nodes],
            "edges": [_edge_dict(e) for e in created_edges],
            "video_node_id": video_node.id if video_node else None,
            "frame_node_id": frame_node.id if frame_node else None,
            "open_generation": body.open_generation,
        }


@router.post("/classify-roles")
async def classify_reference_roles(body: RoleClassifyRequest) -> dict:
    recipe_id = normalize_video_recipe_id(body.recipe_id)
    with get_session() as s:
        target = s.get(Node, body.node_id)
        if target is None:
            raise HTTPException(404, "node not found")
        edges = s.exec(
            select(Edge).where(Edge.target_id == body.node_id).order_by(Edge.id)
        ).all()
        rows: list[dict] = []
        for edge in edges:
            source = s.get(Node, edge.source_id)
            if source is None:
                continue
            rows.append(_edge_context_row(edge, source))

    suggestions = _suggest_roles_heuristic(rows, target, recipe_id)
    source = "heuristic"

    if body.use_llm and rows:
        try:
            llm_items = await _suggest_roles_llm(rows, target, recipe_id)
        except (LLMError, json.JSONDecodeError, ValueError, TypeError):
            llm_items = []
        if llm_items:
            by_edge = {item["edge_id"]: item for item in suggestions}
            for item in llm_items:
                base = by_edge.get(item["edge_id"])
                if base is None:
                    continue
                base["suggested_role"] = item["suggested_role"]
                base["confidence"] = item["confidence"]
                base["reason"] = item["reason"]
                base["source"] = "llm"
            source = "llm"

    for item in suggestions:
        item.setdefault("source", source if source == "heuristic" else "heuristic")
        item["needs_change"] = item["current_role"] != item["suggested_role"]

    return {
        "node_id": body.node_id,
        "recipe_id": recipe_id,
        "source": source,
        "suggestions": suggestions,
    }
