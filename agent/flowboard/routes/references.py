"""CRUD endpoints for the user-curated cross-board reference library.

A Reference is a snapshot of (media_id, label, kind, ai_brief,
aspect_ratio, tags, provenance) that the user explicitly saved from
a generated variant or an uploaded node. Distinct from Asset (the
auto-managed media cache index): references have user-curated
lifetime and metadata; cache files in storage/media/{id}.{ext} are
owned by Asset and never touched on reference DELETE.
"""
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field
from sqlmodel import select, or_

from flowboard.db import get_session
from flowboard.db.models import Node, Reference

router = APIRouter(prefix="/api/references", tags=["references"])


# Valid library profile kinds. Keep legacy source-node kinds for existing
# rows, add production-facing kinds for reusable consistency assets.
_ALLOWED_KINDS = {
    "image",
    "video",
    "character",
    "visual_asset",
    "storyboard_shot",
    "product",
    "package",
    "location",
    "style",
    "brand",
    "first_frame",
}


class ReferenceCreate(BaseModel):
    media_id: str = Field(min_length=1)
    kind: str
    label: Optional[str] = None
    ai_brief: Optional[str] = None
    aspect_ratio: Optional[str] = None
    url: Optional[str] = None
    source_board_id: Optional[int] = None
    source_node_short_id: Optional[str] = None
    tags: Optional[list[str]] = None


class ReferencePatch(BaseModel):
    label: Optional[str] = None
    pinned: Optional[bool] = None
    position: Optional[int] = None
    tags: Optional[list[str]] = None


class ReferenceFromNodeCreate(BaseModel):
    node_id: int
    media_id: Optional[str] = None
    kind: Optional[str] = None
    label: Optional[str] = None
    tags: Optional[list[str]] = None


def _default_label(body: ReferenceCreate) -> str:
    """Compute the fallback label when the user didn't supply one.

    Preference order:
      1. ai_brief truncated to 80 chars,
      2. "#" + source_node_short_id (provenance handle),
      3. "Untitled".
    """
    if body.ai_brief:
        return body.ai_brief[:80]
    if body.source_node_short_id:
        return f"#{body.source_node_short_id}"
    return "Untitled"


def _infer_kind_from_node(node: Node) -> str:
    data = node.data or {}
    text = " ".join(
        p
        for p in (
            data.get("title"),
            data.get("aiBrief"),
            data.get("prompt"),
            node.type,
        )
        if isinstance(p, str)
    ).lower()
    if node.type == "character":
        return "character"
    if node.type == "video":
        return "video"
    if node.type == "Storyboard":
        return "storyboard_shot"
    if node.type == "prompt":
        return "style"
    if any(word in text for word in ("package", "packaging", "box", "unbox")):
        return "package"
    if any(word in text for word in ("background", "location", "room", "cafe", "street", "park", "interior", "exterior")):
        return "location"
    if any(word in text for word in ("style", "mood", "palette", "lighting", "aesthetic")):
        return "style"
    if node.type == "visual_asset":
        return "product"
    return "image"


def _create_reference_row(body: ReferenceCreate):
    if body.kind not in _ALLOWED_KINDS:
        raise HTTPException(
            400,
            f"invalid kind {body.kind!r}; must be one of {sorted(_ALLOWED_KINDS)}",
        )

    with get_session() as s:
        existing = s.exec(
            select(Reference).where(Reference.media_id == body.media_id)
        ).first()
        if existing is not None:
            return _row_dict(existing)

        label = body.label if body.label else _default_label(body)
        row = Reference(
            media_id=body.media_id,
            kind=body.kind,
            label=label,
            ai_brief=body.ai_brief,
            aspect_ratio=body.aspect_ratio,
            url=body.url,
            source_board_id=body.source_board_id,
            source_node_short_id=body.source_node_short_id,
            tags=list(body.tags or []),
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return _row_dict(row)


def _row_dict(row: Reference) -> dict[str, Any]:
    return {
        "id": row.id,
        "media_id": row.media_id,
        "url": row.url,
        "label": row.label,
        "kind": row.kind,
        "ai_brief": row.ai_brief,
        "aspect_ratio": row.aspect_ratio,
        "tags": list(row.tags or []),
        "pinned": row.pinned,
        "position": row.position,
        "source_board_id": row.source_board_id,
        "source_node_short_id": row.source_node_short_id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.post("")
def create_reference(body: ReferenceCreate):
    """Save a media_id to the library.

    Idempotent on media_id: if a row with the same media_id already
    exists, return that row unchanged (200, not 409). Lets the
    frontend treat ★ Save as a "set membership" toggle without
    needing to pre-check.
    """
    return _create_reference_row(body)


@router.post("/from-node")
def create_reference_from_node(body: ReferenceFromNodeCreate):
    """Save a generated/uploaded node output as a reusable asset profile."""
    with get_session() as s:
        node = s.get(Node, body.node_id)
        if node is None:
            raise HTTPException(404, "node not found")
        data = node.data or {}
        primary_media_id = data.get("mediaId")
        media_id = body.media_id or primary_media_id
        if not isinstance(media_id, str) or not media_id:
            raise HTTPException(400, "node has no media_id to save")
        media_ids = data.get("mediaIds")
        if body.media_id:
            allowed_media_ids = set()
            if isinstance(primary_media_id, str):
                allowed_media_ids.add(primary_media_id)
            if isinstance(media_ids, list):
                allowed_media_ids.update(m for m in media_ids if isinstance(m, str))
        if body.media_id and body.media_id not in allowed_media_ids:
            raise HTTPException(400, "media_id is not one of node.mediaIds")

        kind = body.kind or _infer_kind_from_node(node)
        create = ReferenceCreate(
            media_id=media_id,
            kind=kind,
            label=body.label,
            ai_brief=data.get("aiBrief") if isinstance(data.get("aiBrief"), str) else None,
            aspect_ratio=data.get("aspectRatio") if isinstance(data.get("aspectRatio"), str) else None,
            source_board_id=node.board_id,
            source_node_short_id=node.short_id,
            tags=body.tags,
        )
    return _create_reference_row(create)


@router.get("")
def list_references(
    q: Optional[str] = None,
    pinned_first: bool = True,
    limit: int = 200,
):
    """List references, sorted (pinned DESC, position ASC, created_at DESC).

    ``q``: case-insensitive substring match against label OR ai_brief.
    ``pinned_first``: when False, drop pinned from the ORDER BY so
    raw insertion order surfaces (debug / testing convenience).
    """
    with get_session() as s:
        stmt = select(Reference)
        if q:
            needle = f"%{q.lower()}%"
            # SQLite's LIKE is case-insensitive for ASCII by default but
            # we lower() both sides for explicitness and unicode safety.
            from sqlalchemy import func
            stmt = stmt.where(
                or_(
                    func.lower(Reference.label).like(needle),
                    func.lower(Reference.ai_brief).like(needle),
                )
            )
        if pinned_first:
            stmt = stmt.order_by(
                Reference.pinned.desc(),
                Reference.position.asc(),
                Reference.created_at.desc(),
            )
        else:
            stmt = stmt.order_by(
                Reference.position.asc(),
                Reference.created_at.desc(),
            )
        stmt = stmt.limit(limit)
        rows = s.exec(stmt).all()
        return [_row_dict(r) for r in rows]


@router.patch("/{ref_id}")
def patch_reference(ref_id: int, body: ReferencePatch):
    """Partial update — only fields present in the request body are touched."""
    with get_session() as s:
        row = s.get(Reference, ref_id)
        if row is None:
            raise HTTPException(404, "reference not found")
        fields = body.model_fields_set
        if "label" in fields and body.label is not None:
            row.label = body.label
        if "pinned" in fields and body.pinned is not None:
            row.pinned = body.pinned
        if "position" in fields and body.position is not None:
            row.position = body.position
        if "tags" in fields and body.tags is not None:
            row.tags = list(body.tags)
        s.add(row)
        s.commit()
        s.refresh(row)
        return _row_dict(row)


@router.delete("/{ref_id}", status_code=204)
def delete_reference(ref_id: int):
    """Hard delete the reference row.

    The underlying ``storage/media/{media_id}.{ext}`` file is NOT
    touched — the Asset table owns cache lifetime.
    """
    with get_session() as s:
        row = s.get(Reference, ref_id)
        if row is None:
            raise HTTPException(404, "reference not found")
        s.delete(row)
        s.commit()
    return Response(status_code=204)
