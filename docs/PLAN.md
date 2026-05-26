# Flowboard Plan

Personal local use. No team, no cloud, no auth.

Last updated: 2026-05-26

## Concept

Infinite canvas + node-based workflow for AI media. Nodes are typed cards:
`character`, `visual_asset`, `product`, `location`, `brand`, `audio`,
`image`, `Storyboard`, `video`, `prompt`, `note`. Edges express data
dependencies plus optional production roles (`first_frame`, `product_ref`,
`background_ref`, etc.). Generation is brokered through a Chrome MV3 extension
that proxies requests to Google Flow (same pattern as flowkit).

A chat sidebar lets the user describe intent; an LLM (Claude) produces a
pipeline spec (DAG). The executor materializes nodes/edges on the canvas in
realtime over WebSocket as generation completes.

## Architecture

```
[React Canvas] ─HTTP/WS─► [FastAPI Agent + SQLite]
                                ▲
                                │ WebSocket :9223
                                ▼
                      [Chrome MV3 Extension]
                                │
                                ▼
                          labs.google (Flow)
```

## Data model (SQLite via SQLModel)

```
Board(id, name, created_at)
Node(id, board_id, short_id, type, x, y, w, h, data_json, status, created_at)
Edge(id, board_id, source_id, target_id, kind, ref_role, source_variant_idx)
Request(id, node_id, type, params_json, status, result_json, created_at)
Asset(id, node_id, kind, uuid_media_id, local_path, mime)
Reference(id, media_id, kind, label, profile_json, ...)
ChatMessage(id, board_id, role, content, mentions_json, created_at)
Plan(id, board_id, spec_json, status, created_at)
PlanRevision(id, plan_id, rev_no, spec_json, edits_json, created_at)
PipelineRun(id, plan_id, status, started_at, finished_at)
```

## API surface

```
GET    /api/boards
POST   /api/boards
GET    /api/boards/:id
PATCH  /api/boards/:id
POST   /api/nodes
PATCH  /api/nodes/:id
DELETE /api/nodes/:id
POST   /api/edges
DELETE /api/edges/:id
GET    /api/references
POST   /api/references
PATCH  /api/references/:id
POST   /api/requests                     {node_id, type, params}
GET    /api/requests/:id
GET    /api/prompt/video-recipes
GET    /api/prompt/video-recipe-plan
POST   /api/recipes/build-workflow
POST   /api/recipes/build-shot-plan
POST   /api/exports/timelines/:id
POST   /api/chat                         {board_id, message, mentions[]}
POST   /api/plans                        create from chat
POST   /api/plans/:id/run                execute pipeline
GET    /media/:uuid                      serve asset
WS     /ws/extension                     extension bridge
WS     /ws/board/:id                     client live updates
```

## WS events (board channel)

```
plan.started      {plan_id, nodes_count}
node.created      {node_id, type, x, y, params, short_id}
node.updated      {node_id, status, data, thumbnail_url}
edge.created      {edge_id, source, target, kind}
plan.finished     {plan_id, ok, errors[]}
chat.message      {message_id, role, content}
```

## Plan JSON (LLM output)

```json
{
  "plan_id": "pln_01",
  "nodes": [
    {"tmp_id": "a", "type": "character", "params": {"prompt": "..."}},
    {"tmp_id": "b", "type": "image", "params": {"prompt": "...", "refs": ["a"]}},
    {"tmp_id": "c", "type": "video", "params": {"prompt": "...", "refs": ["b"]}}
  ],
  "edges": [
    {"from": "a", "to": "b", "kind": "ref"},
    {"from": "b", "to": "c", "kind": "ref"}
  ],
  "layout_hint": "left_to_right"
}
```

## Node mention

Every node has a `short_id` (base36, 4 chars, unique per board) shown on the
card. Chat input autocompletes `#` → node list. On submit, mentions are
resolved to node data and included in the LLM context.

## Phases

Completed:

- **Phase 0-7** Skeleton, canvas, extension bridge, manual generation,
  planner/executor, short IDs, UX basics.
- **Storyboard image node**: composite contact-sheet generation remains
  available.
- **Video production gap closure**: reference roles, recipe contracts,
  video source modes, product/location/brand/audio profiles, duration model,
  review/refine loop, timeline export/history, and storyboard sequence
  workflow are implemented.
- **Recipe library**: product demo, lifestyle ad, UGC testimonial, cinematic
  reveal, before/after, location establishing, brand bumper, audio-led,
  transition shot, and packshot loop have structured UI/preflight/scaffolds.
- **Project node library**: extra domain/recipe nodes live inside Projects
  sidebar folder groups; top add-node palette stays compact.

## Post-MVP

Current open work:

- **Real Flow QA completion**: free account currently blocked by quota /
  reCAPTCHA / V2V gate. T2V, first+last, and product-demo first-frame i2v
  have real pass evidence; edit-video needs paid/V2V-enabled account.
- **Native video extend**: follow-up/refine clone workflow exists, but native
  Flow extend endpoint is not validated as a first-class path.
- **Deeper production UI**: per-shot reorder/trim/transition/caption/audio mix,
  structured campaign brief, stronger character/brand profiles, script and
  voiceover asset pipeline.
- **Auto-review**: scoring/QA suggestions and circuit breaker remain future
  work.
- **Provider abstraction**: multi-LLM prompt providers exist; broader media
  provider registry remains future work.

## Explicitly out of scope

- Realtime collab, presence, avatars
- Auth, multi-tenant, share links
- Cloud DB, object storage
- YouTube auto-upload (manual export only)
- Comments on nodes
