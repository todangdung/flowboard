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
