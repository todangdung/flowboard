from flowboard.db import get_session
from flowboard.db.models import Board, Edge, Node
from sqlmodel import select


def _make_board() -> int:
    with get_session() as s:
        b = Board(name="recipes")
        s.add(b)
        s.commit()
        s.refresh(b)
        return b.id


def test_build_fashion_fit_check_workflow(client):
    board_id = _make_board()

    r = client.post(
        "/api/recipes/build-workflow",
        json={
            "board_id": board_id,
            "recipe_id": "fashion_fit_check",
            "x": 100,
            "y": 200,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["recipe_id"] == "fashion_fit_check"
    assert body["video_node_id"]
    assert body["frame_node_id"]
    assert len(body["nodes"]) == 5
    assert len(body["edges"]) == 7

    by_title = {n["data"]["title"]: n for n in body["nodes"]}
    assert by_title["Fit check character"]["type"] == "character"
    assert by_title["Outfit / garment ref"]["type"] == "visual_asset"
    assert by_title["Fit check first frame"]["type"] == "image"
    assert by_title["Fashion fit check video"]["type"] == "video"
    assert by_title["Fashion fit check video"]["data"]["videoRecipeId"] == "fashion_fit_check"
    assert "full-body try-on" in by_title["Fit check first frame"]["data"]["prompt"]

    roles = [e["ref_role"] for e in body["edges"]]
    assert roles.count("character_ref") == 2
    assert roles.count("product_ref") == 2
    assert roles.count("style_ref") == 2
    assert roles.count("first_frame") == 1


def test_build_workflow_can_bind_existing_sources(client):
    board_id = _make_board()
    with get_session() as s:
        ch = Node(
            board_id=board_id,
            short_id="char",
            type="character",
            x=0,
            y=0,
            data={"title": "Existing character", "mediaId": "m1"},
            status="done",
        )
        product = Node(
            board_id=board_id,
            short_id="prod",
            type="visual_asset",
            x=0,
            y=120,
            data={"title": "Existing product", "mediaId": "m2"},
            status="done",
        )
        s.add_all([ch, product])
        s.commit()
        s.refresh(ch)
        s.refresh(product)
        ch_id, product_id = ch.id, product.id

    r = client.post(
        "/api/recipes/build-workflow",
        json={
            "board_id": board_id,
            "recipe_id": "fashion_fit_check",
            "sources": [
                {"node_id": ch_id, "role": "character_ref"},
                {"node_id": product_id, "role": "product_ref"},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["nodes"]) == 3
    created_ids = {n["id"] for n in body["nodes"]}
    assert ch_id not in created_ids
    assert product_id not in created_ids

    with get_session() as s:
        edges = s.exec(select(Edge).where(Edge.board_id == board_id)).all()
    assert any(e.source_id == ch_id and e.ref_role == "character_ref" for e in edges)
    assert any(e.source_id == product_id and e.ref_role == "product_ref" for e in edges)


def test_build_storyboard_sequence_shot_workflow(client):
    board_id = _make_board()

    r = client.post(
        "/api/recipes/build-workflow",
        json={
            "board_id": board_id,
            "recipe_id": "storyboard_sequence",
            "x": 50,
            "y": 60,
            "shot_count": 3,
            "shot_duration_sec": 5,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["recipe_id"] == "storyboard_sequence"
    assert body["shot_count"] == 3
    assert body["frame_node_id"] == body["open_node_id"]
    assert body["video_node_id"]
    assert body["timeline_node_id"]
    assert len(body["shot_node_ids"]) == 6
    assert len(body["nodes"]) == 11
    assert len(body["edges"]) == 27

    nodes = body["nodes"]
    plan = next(n for n in nodes if n["data"].get("workflowKind") == "storyboard_plan")
    timeline = next(n for n in nodes if n["data"].get("workflowKind") == "timeline")
    frames = [n for n in nodes if n["data"].get("workflowKind") == "shot_frame"]
    clips = [n for n in nodes if n["data"].get("workflowKind") == "shot_clip"]

    assert plan["type"] == "prompt"
    assert timeline["type"] == "note"
    assert timeline["data"]["timelineShotIds"] == ["shot_01", "shot_02", "shot_03"]
    assert [n["data"]["shotIndex"] for n in frames] == [1, 2, 3]
    assert [n["data"]["shotIndex"] for n in clips] == [1, 2, 3]
    assert all(n["data"]["shotDurationSec"] == 5 for n in frames + clips)
    assert all("Generate a 5s shot" in n["data"]["prompt"] for n in clips)
    assert all(n["data"]["videoRecipeId"] == "storyboard_sequence" for n in frames + clips)

    edges = body["edges"]
    assert sum(1 for e in edges if e["ref_role"] == "first_frame") == 3
    assert sum(1 for e in edges if e["target_id"] == timeline["id"] and e["ref_role"] == "storyboard_panel") == 3
    assert sum(1 for e in edges if e["source_id"] == plan["id"] and e["ref_role"] == "storyboard_ref") == 3


def test_storyboard_sequence_can_bind_existing_character(client):
    board_id = _make_board()
    with get_session() as s:
        ch = Node(
            board_id=board_id,
            short_id="char",
            type="character",
            x=0,
            y=0,
            data={"title": "Existing character", "mediaId": "m1"},
            status="done",
        )
        s.add(ch)
        s.commit()
        s.refresh(ch)
        ch_id = ch.id

    r = client.post(
        "/api/recipes/build-workflow",
        json={
            "board_id": board_id,
            "recipe_id": "storyboard_sequence",
            "shot_count": 2,
            "sources": [{"node_id": ch_id, "role": "character_ref"}],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    created_ids = {n["id"] for n in body["nodes"]}
    assert ch_id not in created_ids
    assert len([n for n in body["nodes"] if n["data"].get("workflowKind") == "shot_frame"]) == 2

    with get_session() as s:
        edges = s.exec(select(Edge).where(Edge.board_id == board_id)).all()
    assert sum(1 for e in edges if e.source_id == ch_id and e.ref_role == "character_ref") == 4


def test_build_workflow_rejects_cross_board_source(client):
    board_a = _make_board()
    board_b = _make_board()
    with get_session() as s:
        ch = Node(
            board_id=board_b,
            short_id="char",
            type="character",
            data={"title": "Wrong board"},
        )
        s.add(ch)
        s.commit()
        s.refresh(ch)
        ch_id = ch.id

    r = client.post(
        "/api/recipes/build-workflow",
        json={
            "board_id": board_a,
            "recipe_id": "fashion_fit_check",
            "sources": [{"node_id": ch_id, "role": "character_ref"}],
        },
    )
    assert r.status_code == 400
    assert "another board" in r.json()["detail"]


def test_classify_roles_heuristic(client):
    board_id = _make_board()
    with get_session() as s:
        ch = Node(
            board_id=board_id,
            short_id="char",
            type="character",
            data={"title": "Model"},
        )
        outfit = Node(
            board_id=board_id,
            short_id="outf",
            type="visual_asset",
            data={"title": "Denim jacket outfit"},
        )
        frame = Node(
            board_id=board_id,
            short_id="fram",
            type="image",
            data={"title": "First frame"},
        )
        video = Node(
            board_id=board_id,
            short_id="vidx",
            type="video",
            data={"title": "Fashion fit check"},
        )
        s.add_all([ch, outfit, frame, video])
        s.commit()
        for n in (ch, outfit, frame, video):
            s.refresh(n)
        s.add(Edge(board_id=board_id, source_id=ch.id, target_id=video.id))
        s.add(Edge(board_id=board_id, source_id=outfit.id, target_id=video.id))
        s.add(Edge(board_id=board_id, source_id=frame.id, target_id=video.id))
        s.commit()
        video_id = video.id

    r = client.post(
        "/api/recipes/classify-roles",
        json={
            "node_id": video_id,
            "recipe_id": "fashion_fit_check",
            "use_llm": False,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    roles = {item["source_short_id"]: item["suggested_role"] for item in body["suggestions"]}
    assert roles == {
        "char": "character_ref",
        "outf": "product_ref",
        "fram": "first_frame",
    }
    assert all(item["needs_change"] for item in body["suggestions"])


def test_classify_roles_llm_overrides_heuristic(client, monkeypatch):
    from flowboard.routes import recipes

    board_id = _make_board()
    with get_session() as s:
        img = Node(
            board_id=board_id,
            short_id="loca",
            type="image",
            data={"title": "Cafe interior with warm window light"},
        )
        target = Node(
            board_id=board_id,
            short_id="targ",
            type="image",
            data={"title": "Composed shot"},
        )
        s.add_all([img, target])
        s.commit()
        s.refresh(img)
        s.refresh(target)
        edge = Edge(board_id=board_id, source_id=img.id, target_id=target.id)
        s.add(edge)
        s.commit()
        s.refresh(edge)
        edge_id, target_id = edge.id, target.id

    async def fake_run_llm(*args, **kwargs):
        return f'[{{"edge_id": {edge_id}, "role": "background_ref", "confidence": 0.91, "reason": "cafe location"}}]'

    monkeypatch.setattr(recipes, "run_llm", fake_run_llm)
    r = client.post(
        "/api/recipes/classify-roles",
        json={"node_id": target_id, "use_llm": True},
    )
    assert r.status_code == 200, r.text
    item = r.json()["suggestions"][0]
    assert item["suggested_role"] == "background_ref"
    assert item["confidence"] == 0.91
    assert item["source"] == "llm"
