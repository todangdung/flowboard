"""Tests for the pipeline executor + plan-run routes (Phase 5)."""
from __future__ import annotations

import asyncio

import pytest
from sqlmodel import Session, select

from flowboard.db import get_session
from flowboard.db.models import (
    Board, BoardFlowProject, Edge, Node, PipelineRun, Plan, Request,
)
from flowboard.services import pipeline_executor


# ── helpers ───────────────────────────────────────────────────────────────


def _make_board(client, name="P") -> dict:
    return client.post("/api/boards", json={"name": name}).json()


def _make_plan(board_id: int, spec: dict) -> int:
    with get_session() as s:
        plan = Plan(board_id=board_id, spec=spec, status="draft")
        s.add(plan)
        s.commit()
        s.refresh(plan)
        return plan.id  # type: ignore[return-value]


# ── auto_layout ───────────────────────────────────────────────────────────


def test_auto_layout_uses_topo_depth():
    nodes = [
        {"tmp_id": "a", "type": "character"},
        {"tmp_id": "b", "type": "image"},
        {"tmp_id": "c", "type": "video"},
    ]
    edges = [
        {"from": "a", "to": "b"},
        {"from": "b", "to": "c"},
    ]
    layout = pipeline_executor.auto_layout(nodes, edges)
    assert layout["a"][0] < layout["b"][0] < layout["c"][0]
    # Same row when stacked linearly.
    assert layout["a"][1] == layout["b"][1] == layout["c"][1]


def test_auto_layout_stacks_siblings_vertically():
    nodes = [
        {"tmp_id": "root", "type": "prompt"},
        {"tmp_id": "child1", "type": "image"},
        {"tmp_id": "child2", "type": "image"},
    ]
    edges = [
        {"from": "root", "to": "child1"},
        {"from": "root", "to": "child2"},
    ]
    layout = pipeline_executor.auto_layout(nodes, edges)
    assert layout["child1"][0] == layout["child2"][0]  # same column
    assert layout["child1"][1] != layout["child2"][1]  # different rows


# ── materialize_plan ──────────────────────────────────────────────────────


def test_materialize_plan_creates_nodes_and_edges(client):
    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [
                {"tmp_id": "p", "type": "prompt", "params": {"prompt": "hello"}},
                {"tmp_id": "i", "type": "image", "params": {"prompt": "a cat"}},
            ],
            "edges": [{"from": "p", "to": "i"}],
        },
    )
    with get_session() as s:
        summary = pipeline_executor.materialize_plan(s, plan_id)
        s.commit()

    assert len(summary["node_ids"]) == 2
    with get_session() as s:
        nodes = s.exec(select(Node).where(Node.id.in_(summary["node_ids"]))).all()
        edges = s.exec(select(Edge).where(Edge.board_id == b["id"])).all()
    by_type = {n.type for n in nodes}
    assert by_type == {"prompt", "image"}
    assert len(edges) == 1
    # Auto-layout column ordering: prompt left of image
    by_id = {n.id: n for n in nodes}
    src = by_id[edges[0].source_id]
    tgt = by_id[edges[0].target_id]
    assert src.x < tgt.x


def test_materialize_plan_resolves_existing_short_id(client):
    """An edge endpoint that uses #shortId should resolve to the existing node."""
    b = _make_board(client)
    # Pre-create a node we'll reference.
    n = client.post(
        "/api/nodes", json={"board_id": b["id"], "type": "character"}
    ).json()
    short_id = n["short_id"]
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [{"tmp_id": "i", "type": "image", "params": {"prompt": "x"}}],
            "edges": [{"from": f"#{short_id}", "to": "i"}],
        },
    )
    with get_session() as s:
        pipeline_executor.materialize_plan(s, plan_id)
        s.commit()
    with get_session() as s:
        edges = s.exec(select(Edge).where(Edge.board_id == b["id"])).all()
        existing = s.get(Node, n["id"])
        assert len(edges) == 1
        assert edges[0].source_id == existing.id


def test_materialize_plan_skips_unresolvable_endpoint(client):
    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [{"tmp_id": "i", "type": "image"}],
            "edges": [
                {"from": "ghost", "to": "i"},  # unknown
                {"from": "#zzzz", "to": "i"},  # unknown short_id
            ],
        },
    )
    with get_session() as s:
        pipeline_executor.materialize_plan(s, plan_id)
        s.commit()
    with get_session() as s:
        assert len(s.exec(select(Edge).where(Edge.board_id == b["id"])).all()) == 0
        # The image node still got created.
        assert len(s.exec(select(Node).where(Node.board_id == b["id"])).all()) == 1


def test_materialize_plan_idempotent(client):
    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {"nodes": [{"tmp_id": "i", "type": "image"}], "edges": []},
    )
    with get_session() as s:
        first = pipeline_executor.materialize_plan(s, plan_id)
        s.commit()
    with get_session() as s:
        second = pipeline_executor.materialize_plan(s, plan_id)
        s.commit()
    assert first["created"] is True
    assert second["created"] is False
    assert first["node_ids"] == second["node_ids"]


# ── routes ────────────────────────────────────────────────────────────────


def test_post_plan_run_returns_pipeline_run(client, monkeypatch):
    # Stub run_pipeline so we don't actually execute anything.
    async def noop(rid, **kwargs):
        return None

    monkeypatch.setattr(
        "flowboard.routes.plans.run_pipeline", noop
    )

    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {"nodes": [{"tmp_id": "i", "type": "image"}], "edges": []},
    )
    r = client.post(f"/api/plans/{plan_id}/run")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["plan_id"] == plan_id
    assert body["status"] == "pending"
    # And we materialised the plan.
    with get_session() as s:
        nodes = s.exec(select(Node).where(Node.board_id == b["id"])).all()
        assert len(nodes) == 1


def test_post_plan_run_idempotent(client, monkeypatch):
    async def slow(rid, **kwargs):
        # Hold the run in-flight for long enough that two posts overlap.
        await asyncio.sleep(0.5)

    monkeypatch.setattr("flowboard.routes.plans.run_pipeline", slow)

    b = _make_board(client)
    plan_id = _make_plan(
        b["id"], {"nodes": [{"tmp_id": "i", "type": "image"}], "edges": []}
    )
    r1 = client.post(f"/api/plans/{plan_id}/run").json()
    r2 = client.post(f"/api/plans/{plan_id}/run").json()
    assert r1["id"] == r2["id"]


def test_get_plan_returns_404_when_missing(client):
    assert client.get("/api/plans/9999").status_code == 404


def test_get_pipeline_run_returns_404_when_missing(client):
    assert client.get("/api/pipeline-runs/9999").status_code == 404


# ── run_pipeline ─────────────────────────────────────────────────────────


def _make_board_with_project(client, project_id="abcd1234"):
    b = _make_board(client)
    with get_session() as s:
        s.add(BoardFlowProject(board_id=b["id"], flow_project_id=project_id))
        s.commit()
    return b


@pytest.mark.asyncio
async def test_run_pipeline_dispatches_image_in_topo_order(client, monkeypatch):
    """Image node with a prompt should hit gen_image; non-gen nodes are skipped."""
    from flowboard.services import flow_sdk

    dispatch_log: list[dict] = []

    class _Stub:
        async def gen_image(self, **kwargs):
            dispatch_log.append(kwargs)
            return {"raw": {}, "media_ids": ["m-1"], "media_entries": []}

    monkeypatch.setattr(flow_sdk, "_sdk", _Stub())

    b = _make_board_with_project(client)
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [
                {"tmp_id": "p", "type": "prompt", "params": {"prompt": "hi"}},
                {"tmp_id": "i", "type": "image", "params": {"prompt": "a cat"}},
            ],
            "edges": [{"from": "p", "to": "i"}],
        },
    )
    # Materialise + create run row directly.
    with get_session() as s:
        pipeline_executor.materialize_plan(s, plan_id)
        run = PipelineRun(plan_id=plan_id, status="pending")
        s.add(run)
        s.commit()
        s.refresh(run)
        rid = run.id

    # Need the worker running for Request rows to settle.
    from flowboard.worker.processor import WorkerController, _DEFAULT_HANDLERS
    w = WorkerController(handlers=_DEFAULT_HANDLERS)
    # Inject this controller as the global so pipeline_executor's
    # `get_worker().enqueue` picks it up.
    from flowboard.worker import processor as proc
    monkeypatch.setattr(proc, "_worker", w)

    worker_task = asyncio.create_task(w.start())
    try:
        await pipeline_executor.run_pipeline(rid, request_timeout_s=5.0, poll_interval_s=0.05)
    finally:
        w.request_shutdown()
        await asyncio.wait_for(worker_task, timeout=2.0)

    assert len(dispatch_log) == 1
    assert dispatch_log[0]["prompt"] == "a cat"
    assert dispatch_log[0]["project_id"] == "abcd1234"

    # Verify pipeline + plan + image node finished cleanly.
    with get_session() as s:
        run = s.get(PipelineRun, rid)
        plan = s.get(Plan, plan_id)
        assert run is not None and run.status == "done"
        assert plan is not None and plan.status == "done"
        nodes = s.exec(select(Node).where(Node.board_id == b["id"])).all()
        by_type = {n.type: n for n in nodes}
        assert by_type["image"].status == "done"
        assert by_type["image"].data.get("mediaId") == "m-1"
        # Prompt node is left idle (no gen step).
        assert by_type["prompt"].status == "idle"


# ── rerun helpers ─────────────────────────────────────────────────────────


def _materialise(plan_id: int) -> list[int]:
    with get_session() as s:
        summary = pipeline_executor.materialize_plan(s, plan_id)
        s.commit()
        return list(summary["node_ids"])


def test_collect_downstream_subgraph_includes_start_and_downstream(client):
    """Linear A→B→C: starting at B should return {B, C} but not A."""
    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [
                {"tmp_id": "a", "type": "character"},
                {"tmp_id": "b", "type": "image", "params": {"prompt": "x"}},
                {"tmp_id": "c", "type": "image", "params": {"prompt": "y"}},
            ],
            "edges": [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"},
            ],
        },
    )
    node_ids = _materialise(plan_id)
    # node_ids ordering matches spec insertion: a, b, c
    a_id, b_id, c_id = node_ids
    with get_session() as s:
        subgraph = pipeline_executor.collect_downstream_subgraph(s, plan_id, b_id)
    assert subgraph == {b_id, c_id}


def test_collect_downstream_subgraph_starts_at_source(client):
    """From the root node we get the whole DAG back."""
    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [
                {"tmp_id": "a", "type": "character"},
                {"tmp_id": "b", "type": "image", "params": {"prompt": "x"}},
            ],
            "edges": [{"from": "a", "to": "b"}],
        },
    )
    a_id, b_id = _materialise(plan_id)
    with get_session() as s:
        subgraph = pipeline_executor.collect_downstream_subgraph(s, plan_id, a_id)
    assert subgraph == {a_id, b_id}


def test_collect_downstream_subgraph_rejects_foreign_node(client):
    """A node id that doesn't belong to the plan should raise ValueError."""
    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {"nodes": [{"tmp_id": "i", "type": "image"}], "edges": []},
    )
    _materialise(plan_id)
    # Create a second, unrelated node on the same board.
    other = client.post(
        "/api/nodes", json={"board_id": b["id"], "type": "character"}
    ).json()
    with get_session() as s, pytest.raises(ValueError):
        pipeline_executor.collect_downstream_subgraph(s, plan_id, other["id"])


def test_reset_nodes_for_rerun_clears_status_and_media_fields(client):
    """Reset should flip status to idle and drop mediaId/mediaIds/error
    while leaving non-execution fields like title and prompt intact."""
    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [
                {"tmp_id": "i", "type": "image", "params": {"prompt": "cat"}},
            ],
            "edges": [],
        },
    )
    (node_id,) = _materialise(plan_id)
    # Simulate a successful past run by stamping output state on the node.
    with get_session() as s:
        n = s.get(Node, node_id)
        n.status = "done"
        n.data = {
            **n.data,
            "mediaId": "m-old",
            "mediaIds": ["m-old"],
            "error": None,
        }
        s.add(n)
        s.commit()

    with get_session() as s:
        pipeline_executor.reset_nodes_for_rerun(s, {node_id})
        s.commit()

    with get_session() as s:
        n = s.get(Node, node_id)
        assert n.status == "idle"
        assert "mediaId" not in n.data
        assert "mediaIds" not in n.data
        assert "error" not in n.data
        # Non-execution fields preserved.
        assert n.data.get("title") == "Image"
        assert n.data.get("prompt") == "cat"


def test_find_plan_id_for_node_returns_plan(client):
    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {"nodes": [{"tmp_id": "i", "type": "image"}], "edges": []},
    )
    (node_id,) = _materialise(plan_id)
    with get_session() as s:
        assert pipeline_executor.find_plan_id_for_node(s, node_id) == plan_id


def test_find_plan_id_for_node_returns_none_for_loose_node(client):
    b = _make_board(client)
    n = client.post(
        "/api/nodes", json={"board_id": b["id"], "type": "character"}
    ).json()
    with get_session() as s:
        assert pipeline_executor.find_plan_id_for_node(s, n["id"]) is None


# ── rerun routes ──────────────────────────────────────────────────────────


def test_post_plan_run_rejects_done_plan_without_force(client, monkeypatch):
    """A plan that already ran can't be re-triggered without explicit force."""
    async def noop(rid, **kwargs):
        return None

    monkeypatch.setattr("flowboard.routes.plans.run_pipeline", noop)

    b = _make_board(client)
    plan_id = _make_plan(
        b["id"], {"nodes": [{"tmp_id": "i", "type": "image"}], "edges": []}
    )
    # Manually mark plan.status as done — mimics a previous successful run.
    with get_session() as s:
        plan = s.get(Plan, plan_id)
        plan.status = "done"
        s.add(plan)
        s.commit()

    r = client.post(f"/api/plans/{plan_id}/run")
    assert r.status_code == 409, r.text
    assert "force" in r.json()["detail"].lower()


def test_post_plan_run_force_starts_new_run(client, monkeypatch):
    captured: dict = {}

    async def capture(rid, *, scope_node_ids=None, **kwargs):
        captured["rid"] = rid
        captured["scope"] = scope_node_ids
        return None

    monkeypatch.setattr("flowboard.routes.plans.run_pipeline", capture)

    b = _make_board(client)
    plan_id = _make_plan(
        b["id"], {"nodes": [{"tmp_id": "i", "type": "image"}], "edges": []}
    )
    # Run once to materialise.
    r1 = client.post(f"/api/plans/{plan_id}/run")
    assert r1.status_code == 200

    # Settle the first run row and mark the plan as done.
    with get_session() as s:
        run = s.exec(
            select(PipelineRun).where(PipelineRun.plan_id == plan_id)
        ).first()
        run.status = "done"
        plan = s.get(Plan, plan_id)
        plan.status = "done"
        s.add(run)
        s.add(plan)
        s.commit()

    r2 = client.post(f"/api/plans/{plan_id}/run", json={"force": True})
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["plan_id"] == plan_id
    assert body["id"] != r1.json()["id"]
    # And the whole plan went into the executor's scope.
    assert captured["scope"] is not None
    assert len(captured["scope"]) == 1


def test_post_plan_run_from_node_passes_subgraph_scope(client, monkeypatch):
    captured: dict = {}

    async def capture(rid, *, scope_node_ids=None, **kwargs):
        captured["scope"] = scope_node_ids
        return None

    monkeypatch.setattr("flowboard.routes.plans.run_pipeline", capture)

    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [
                {"tmp_id": "a", "type": "character"},
                {"tmp_id": "b", "type": "image", "params": {"prompt": "x"}},
                {"tmp_id": "c", "type": "image", "params": {"prompt": "y"}},
            ],
            "edges": [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"},
            ],
        },
    )
    # First run materialises and stamps initial state.
    client.post(f"/api/plans/{plan_id}/run")
    with get_session() as s:
        nodes = s.exec(select(Node).where(Node.board_id == b["id"])).all()
        by_short = {n.short_id: n for n in nodes}
        plan = s.get(Plan, plan_id)
        materialised = plan.spec["_materialized_node_ids"]
    # Tag each node by the order it appears in materialised so we can pick "b".
    a_id, b_id, c_id = materialised

    # Mark previous run terminal so the new run isn't blocked.
    with get_session() as s:
        run = s.exec(
            select(PipelineRun).where(PipelineRun.plan_id == plan_id)
        ).first()
        run.status = "done"
        s.add(run)
        s.commit()

    r = client.post(
        f"/api/plans/{plan_id}/run", json={"from_node_id": b_id}
    )
    assert r.status_code == 200, r.text
    # Scope is {b, c} — c is downstream of b.
    assert captured["scope"] == {b_id, c_id}


def test_post_plan_run_from_node_preserves_upstream_media(client, monkeypatch):
    """When rerunning from a middle node, the upstream node's mediaId must
    survive — the executor reads it as input."""
    async def noop(rid, **kwargs):
        return None

    monkeypatch.setattr("flowboard.routes.plans.run_pipeline", noop)

    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [
                {"tmp_id": "a", "type": "character"},
                {"tmp_id": "b", "type": "image", "params": {"prompt": "x"}},
            ],
            "edges": [{"from": "a", "to": "b"}],
        },
    )
    client.post(f"/api/plans/{plan_id}/run")
    a_id, b_id = _materialise(plan_id)  # idempotent — returns same ids

    # Simulate a completed first run: both nodes have mediaId, plan is done.
    with get_session() as s:
        for nid, mid in ((a_id, "m-upstream"), (b_id, "m-downstream")):
            n = s.get(Node, nid)
            n.status = "done"
            n.data = {**n.data, "mediaId": mid, "mediaIds": [mid]}
            s.add(n)
        run = s.exec(
            select(PipelineRun).where(PipelineRun.plan_id == plan_id)
        ).first()
        run.status = "done"
        s.add(run)
        s.commit()

    # Rerun from b — a's mediaId must persist.
    r = client.post(f"/api/plans/{plan_id}/run", json={"from_node_id": b_id})
    assert r.status_code == 200

    with get_session() as s:
        a = s.get(Node, a_id)
        b_node = s.get(Node, b_id)
        assert a.data.get("mediaId") == "m-upstream"
        assert a.status == "done"
        # b is reset.
        assert "mediaId" not in b_node.data
        assert b_node.status == "idle"


def test_post_node_rerun_from_here_finds_plan_and_dispatches(client, monkeypatch):
    captured: dict = {}

    async def capture(rid, *, scope_node_ids=None, **kwargs):
        captured["scope"] = scope_node_ids
        return None

    monkeypatch.setattr("flowboard.routes.plans.run_pipeline", capture)

    b = _make_board(client)
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [
                {"tmp_id": "a", "type": "character"},
                {"tmp_id": "b", "type": "image", "params": {"prompt": "x"}},
            ],
            "edges": [{"from": "a", "to": "b"}],
        },
    )
    client.post(f"/api/plans/{plan_id}/run")
    a_id, b_id = _materialise(plan_id)

    # Mark first run terminal.
    with get_session() as s:
        run = s.exec(
            select(PipelineRun).where(PipelineRun.plan_id == plan_id)
        ).first()
        run.status = "done"
        s.add(run)
        s.commit()

    r = client.post(f"/api/nodes/{b_id}/rerun-from-here")
    assert r.status_code == 200, r.text
    assert r.json()["plan_id"] == plan_id
    # Only b is in scope (no downstream beyond it).
    assert captured["scope"] == {b_id}


def test_post_node_rerun_from_here_404_for_loose_node(client):
    b = _make_board(client)
    # Create a node that no plan ever materialised.
    n = client.post(
        "/api/nodes", json={"board_id": b["id"], "type": "character"}
    ).json()
    r = client.post(f"/api/nodes/{n['id']}/rerun-from-here")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_run_pipeline_marks_downstream_failed_on_upstream_error(client, monkeypatch):
    from flowboard.services import flow_sdk

    class _Stub:
        async def gen_image(self, **kwargs):
            return {"raw": {}, "error": "captcha_failed"}

    monkeypatch.setattr(flow_sdk, "_sdk", _Stub())

    b = _make_board_with_project(client)
    plan_id = _make_plan(
        b["id"],
        {
            "nodes": [
                {"tmp_id": "i1", "type": "image", "params": {"prompt": "first"}},
                {"tmp_id": "v", "type": "video", "params": {"prompt": "next"}},
            ],
            "edges": [{"from": "i1", "to": "v"}],
        },
    )
    with get_session() as s:
        pipeline_executor.materialize_plan(s, plan_id)
        run = PipelineRun(plan_id=plan_id, status="pending")
        s.add(run)
        s.commit()
        s.refresh(run)
        rid = run.id

    from flowboard.worker.processor import WorkerController, _DEFAULT_HANDLERS
    from flowboard.worker import processor as proc
    w = WorkerController(handlers=_DEFAULT_HANDLERS)
    monkeypatch.setattr(proc, "_worker", w)

    worker_task = asyncio.create_task(w.start())
    try:
        await pipeline_executor.run_pipeline(rid, request_timeout_s=5.0, poll_interval_s=0.05)
    finally:
        w.request_shutdown()
        await asyncio.wait_for(worker_task, timeout=2.0)

    with get_session() as s:
        run = s.get(PipelineRun, rid)
        assert run is not None and run.status == "failed"
        nodes = s.exec(select(Node).where(Node.board_id == b["id"])).all()
        by_type = {n.type: n for n in nodes}
        assert by_type["image"].status == "error"
        assert by_type["video"].status == "error"
        assert by_type["video"].data.get("error") == "upstream_failed"
