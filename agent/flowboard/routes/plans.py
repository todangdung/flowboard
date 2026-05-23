"""Plan + PipelineRun routes.

The chat handler creates ``Plan`` rows in ``draft`` status. This module exposes:

- ``GET  /api/plans/{plan_id}`` — read-only fetch.
- ``POST /api/plans/{plan_id}/run`` — materialise the plan onto the canvas
  (auto-laid-out Node + Edge rows) and kick off background execution.
  Accepts ``{from_node_id, force}`` in the body for partial reruns and to
  override the already-executed guard.
- ``POST /api/nodes/{node_id}/rerun-from-here`` — convenience entry point
  for the canvas context menu. Finds the plan that materialised the node,
  then reruns from it. Always forces.
- ``GET  /api/pipeline-runs/{run_id}`` — status row for the frontend poll.

POST is idempotent for in-flight runs: if a run for the plan is already
``pending`` or ``running``, we return the existing row instead of starting
a second.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from flowboard.db import get_session
from flowboard.db.models import Plan, PipelineRun
from flowboard.services.pipeline_executor import (
    collect_downstream_subgraph,
    find_plan_id_for_node,
    materialize_plan,
    reset_nodes_for_rerun,
    run_pipeline,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["plans"])

# Track in-flight executor tasks so we can avoid double-spawning if Python
# garbage-collects the future. asyncio.create_task returns Task objects that
# the event loop keeps alive while running, but holding a strong ref here is
# defence-in-depth and gives tests a hook.
_active_tasks: dict[int, asyncio.Task] = {}


class RunPlanBody(BaseModel):
    # When set, only run this node + its downstream subgraph. Upstream
    # nodes are left untouched so the executor can read their cached
    # ``data.mediaId`` as inputs.
    from_node_id: int | None = None
    # Required to re-execute a plan whose status is already done/failed
    # for whole-flow reruns. Ignored when ``from_node_id`` is set
    # (partial reruns always force; the user is explicit by definition).
    force: bool = False


@router.get("/api/plans/{plan_id}")
def get_plan(plan_id: int):
    with get_session() as s:
        plan = s.get(Plan, plan_id)
        if plan is None:
            raise HTTPException(404, "plan not found")
        return plan


def _spawn_pipeline_task(rid: int, scope_node_ids: set[int] | None) -> None:
    task = asyncio.create_task(
        run_pipeline(rid, scope_node_ids=scope_node_ids),
        name=f"pipeline-run-{rid}",
    )
    _active_tasks[rid] = task

    def _cleanup(t: asyncio.Task) -> None:
        _active_tasks.pop(rid, None)
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            logger.exception("pipeline run %s crashed", rid, exc_info=exc)
            # Stamp the run as failed so the frontend doesn't hang.
            with get_session() as s2:
                row = s2.get(PipelineRun, rid)
                if row is not None and row.status not in ("done", "failed"):
                    row.status = "failed"
                    row.error = f"crash:{exc!r}"[:500]
                    row.finished_at = datetime.now(timezone.utc)
                    s2.add(row)
                    s2.commit()

    task.add_done_callback(_cleanup)


def _start_run(
    plan_id: int,
    *,
    from_node_id: int | None,
    force: bool,
) -> PipelineRun:
    """Shared core for the two POST entry points. Returns the PipelineRun row
    (already committed) and spawns the executor task.

    Raises ``HTTPException`` on:
    - 404 plan / node not found
    - 409 an explicit rerun was requested while a run is still in flight,
      or plan is done/failed and force is required but not given for a
      whole-flow rerun.

    For a plain POST (no body params, no rerun intent) with an in-flight
    run we preserve the original idempotent behaviour: return the existing
    row so a network-retry doesn't double-spawn the executor.
    """
    is_explicit_rerun = force or from_node_id is not None

    with get_session() as s:
        plan = s.get(Plan, plan_id)
        if plan is None:
            raise HTTPException(404, "plan not found")

        from sqlmodel import select

        existing = s.exec(
            select(PipelineRun)
            .where(PipelineRun.plan_id == plan_id)
            .where(PipelineRun.status.in_(("pending", "running")))  # type: ignore[attr-defined]
        ).first()
        if existing is not None:
            if is_explicit_rerun:
                raise HTTPException(409, "plan run already in flight")
            return existing

        # Already-done guard: re-running a completed plan from scratch
        # requires explicit force. Partial reruns (from_node_id set) skip
        # this — the user picked a specific node, intent is clear.
        if (
            from_node_id is None
            and plan.status in ("done", "failed")
            and not force
        ):
            raise HTTPException(
                409,
                "plan already executed; pass force=true to rerun",
            )

        # Materialise on first run; subsequent calls hit the idempotent
        # path inside materialize_plan and return cached node ids.
        try:
            summary = materialize_plan(s, plan_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

        # Compute scope (which nodes to (re)execute).
        if from_node_id is not None:
            try:
                scope_node_ids = collect_downstream_subgraph(
                    s, plan_id, from_node_id
                )
            except ValueError as exc:
                raise HTTPException(404, str(exc)) from exc
        else:
            scope_node_ids = {
                int(n) for n in plan.spec.get("_materialized_node_ids") or []
                if isinstance(n, int)
            }

        # Clear stale ephemeral state on the nodes we're about to re-execute.
        # Upstream nodes outside the scope keep their data.mediaId so the
        # executor uses them as inputs. Media on storage is preserved.
        reset_nodes_for_rerun(s, scope_node_ids)

        # Reset plan.status so the executor's "running" transition is clean.
        plan.status = "approved"
        s.add(plan)

        run = PipelineRun(plan_id=plan_id, status="pending")
        s.add(run)
        s.commit()
        s.refresh(run)
        rid = run.id
        assert rid is not None
        logger.info(
            "plan %s: scheduled pipeline run %s (scope=%d node(s), materialised=%d)",
            plan_id,
            rid,
            len(scope_node_ids),
            len(summary.get("node_ids") or []),
        )
        run_row = run

    _spawn_pipeline_task(rid, scope_node_ids)
    return run_row


@router.post("/api/plans/{plan_id}/run")
async def run_plan(
    plan_id: int,
    body: RunPlanBody | None = Body(default=None),
):
    body = body or RunPlanBody()
    return _start_run(
        plan_id,
        from_node_id=body.from_node_id,
        force=body.force,
    )


@router.post("/api/nodes/{node_id}/rerun-from-here")
async def rerun_from_node(node_id: int):
    """Find the plan that materialised this node and rerun from it.

    The canvas context menu calls this — the frontend doesn't track which
    plan owns which node, so we resolve it server-side. Always forces
    (the user right-clicked a specific node; their intent is explicit).
    """
    with get_session() as s:
        plan_id = find_plan_id_for_node(s, node_id)
    if plan_id is None:
        raise HTTPException(
            404,
            "no plan owns this node — only nodes materialised by a plan can be rerun",
        )
    return _start_run(plan_id, from_node_id=node_id, force=True)


@router.get("/api/pipeline-runs/{run_id}")
def get_pipeline_run(run_id: int):
    with get_session() as s:
        row = s.get(PipelineRun, run_id)
        if row is None:
            raise HTTPException(404, "pipeline run not found")
        return row
