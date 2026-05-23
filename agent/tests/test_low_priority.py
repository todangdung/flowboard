"""Free-tier compatibility: `lite_relaxed` quality + `low_priority` toggle.

Flowboard ports flowkit's free-tier approach by:

1. Adding `lite_relaxed` to PAYGATE_TIER_ONE's model map so Pro / free
   users get `veo_3_1_i2v_lite_low_priority` when they pick that quality.
2. Centralising `_effective_paygate_tier()` so video qualities that route
   through Flow's low-priority queue ALWAYS see `userPaygateTier=PAYGATE_TIER_TWO`
   in the request envelope — this is what flowkit does and is the only
   thing Flow actually checks for the low-priority models.
3. Adding a `low_priority` kwarg to gen_image / edit_image / gen_video_omni
   so the same envelope override applies to non-Veo dispatches.

These tests pin the regression-sensitive bits: the override mapping,
the envelope rewrite, and the processor wiring that translates the
frontend toggle into the right SDK args.
"""
from typing import Any

import pytest

from flowboard.services.flow_sdk import (
    FlowSDK,
    _effective_paygate_tier,
    resolve_video_model,
)


class RecordingClient:
    def __init__(self) -> None:
        self.api_calls: list[dict[str, Any]] = []
        self.api_response: dict[str, Any] = {"status": 200, "data": {}}

    async def api_request(self, **kwargs):
        self.api_calls.append(kwargs)
        return self.api_response

    async def trpc_request(self, **kwargs):  # noqa: ARG002
        return {}


def test_effective_paygate_tier_overrides_for_relaxed_qualities():
    """Both `lite_relaxed` and `fast_relaxed` ALWAYS coerce to TIER_TWO
    regardless of the caller's real tier — that's what flowkit does and
    is what Flow's low-priority queue requires in the envelope."""
    assert _effective_paygate_tier("PAYGATE_TIER_ONE", "lite_relaxed") == "PAYGATE_TIER_TWO"
    assert _effective_paygate_tier("PAYGATE_TIER_ONE", "fast_relaxed") == "PAYGATE_TIER_TWO"
    assert _effective_paygate_tier("PAYGATE_TIER_TWO", "lite_relaxed") == "PAYGATE_TIER_TWO"
    # Case-insensitive — defense against a stale frontend stamping mixed case.
    assert _effective_paygate_tier("PAYGATE_TIER_ONE", "Lite_Relaxed") == "PAYGATE_TIER_TWO"


def test_effective_paygate_tier_passthrough_for_paid_qualities():
    """Paid qualities and missing quality MUST pass through unchanged so
    a Pro user picking `fast` doesn't get silently downgraded into the
    Tier 2 envelope (which would be the bug from pre-v1.1.5)."""
    assert _effective_paygate_tier("PAYGATE_TIER_ONE", "fast") == "PAYGATE_TIER_ONE"
    assert _effective_paygate_tier("PAYGATE_TIER_ONE", "lite") == "PAYGATE_TIER_ONE"
    assert _effective_paygate_tier("PAYGATE_TIER_ONE", "quality") == "PAYGATE_TIER_ONE"
    assert _effective_paygate_tier("PAYGATE_TIER_ONE", None) == "PAYGATE_TIER_ONE"
    assert _effective_paygate_tier("PAYGATE_TIER_ONE", "") == "PAYGATE_TIER_ONE"
    assert _effective_paygate_tier("PAYGATE_TIER_TWO", "fast") == "PAYGATE_TIER_TWO"


def test_resolve_video_model_lite_relaxed_available_on_tier_one():
    """Tier 1 (Pro / free) MUST resolve `lite_relaxed` to the
    low-priority model — previously this fell back to fast."""
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite_relaxed"
    ) == "veo_3_1_i2v_lite_low_priority"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_PORTRAIT", "lite_relaxed"
    ) == "veo_3_1_i2v_lite_low_priority"


@pytest.mark.asyncio
async def test_gen_video_envelope_uses_tier_two_for_lite_relaxed_on_tier_one():
    """End-to-end: a TIER_ONE user picking `lite_relaxed` must dispatch
    with `clientContext.userPaygateTier == "PAYGATE_TIER_TWO"` AND
    `videoModelKey == "veo_3_1_i2v_lite_low_priority"`. This is the
    exact combination flowkit ships to make free accounts work."""
    client = RecordingClient()
    client.api_response = {
        "status": 200,
        "data": {"operations": [{"operation": {"name": "ops/abc"}}]},
    }
    sdk = FlowSDK(client)  # type: ignore[arg-type]
    await sdk.gen_video(
        prompt="test prompt",
        project_id="proj-123",
        start_media_id="media-A",
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier="PAYGATE_TIER_ONE",
        video_quality="lite_relaxed",
    )
    assert len(client.api_calls) == 1
    body = client.api_calls[0]["body"]
    assert body["clientContext"]["userPaygateTier"] == "PAYGATE_TIER_TWO"
    assert body["requests"][0]["videoModelKey"] == "veo_3_1_i2v_lite_low_priority"


@pytest.mark.asyncio
async def test_gen_video_envelope_preserves_tier_one_for_paid_quality():
    """Regression guard for paid users: TIER_ONE + `fast` MUST still
    dispatch with TIER_ONE envelope, NOT TIER_TWO. The override is
    quality-driven, not blanket."""
    client = RecordingClient()
    client.api_response = {
        "status": 200,
        "data": {"operations": [{"operation": {"name": "ops/abc"}}]},
    }
    sdk = FlowSDK(client)  # type: ignore[arg-type]
    await sdk.gen_video(
        prompt="test prompt",
        project_id="proj-123",
        start_media_id="media-A",
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier="PAYGATE_TIER_ONE",
        video_quality="fast",
    )
    body = client.api_calls[0]["body"]
    assert body["clientContext"]["userPaygateTier"] == "PAYGATE_TIER_ONE"
    assert body["requests"][0]["videoModelKey"] == "veo_3_1_i2v_s_fast"


@pytest.mark.asyncio
async def test_gen_image_low_priority_overrides_envelope():
    """gen_image with `low_priority=True` MUST stamp TIER_TWO in the
    envelope even though the caller passed TIER_ONE. Image gen body
    is tier-agnostic, so this is the only thing that changes."""
    client = RecordingClient()
    client.api_response = {"status": 200, "data": {"media": [{"name": "img-A"}]}}
    sdk = FlowSDK(client)  # type: ignore[arg-type]
    await sdk.gen_image(
        prompt="a tee",
        project_id="proj-123",
        paygate_tier="PAYGATE_TIER_ONE",
        low_priority=True,
    )
    body = client.api_calls[0]["body"]
    assert body["clientContext"]["userPaygateTier"] == "PAYGATE_TIER_TWO"


@pytest.mark.asyncio
async def test_gen_image_low_priority_default_preserves_real_tier():
    """gen_image with `low_priority` default (False) MUST keep the real
    tier in the envelope. Regression guard for paid users."""
    client = RecordingClient()
    client.api_response = {"status": 200, "data": {"media": [{"name": "img-A"}]}}
    sdk = FlowSDK(client)  # type: ignore[arg-type]
    await sdk.gen_image(
        prompt="a tee",
        project_id="proj-123",
        paygate_tier="PAYGATE_TIER_ONE",
    )
    body = client.api_calls[0]["body"]
    assert body["clientContext"]["userPaygateTier"] == "PAYGATE_TIER_ONE"


@pytest.mark.asyncio
async def test_edit_image_low_priority_overrides_envelope():
    """edit_image symmetric with gen_image — `low_priority=True` rewrites
    the envelope to TIER_TWO."""
    client = RecordingClient()
    client.api_response = {"status": 200, "data": {"media": [{"name": "img-B"}]}}
    sdk = FlowSDK(client)  # type: ignore[arg-type]
    await sdk.edit_image(
        prompt="refine",
        project_id="proj-123",
        source_media_id="img-A",
        paygate_tier="PAYGATE_TIER_ONE",
        low_priority=True,
    )
    body = client.api_calls[0]["body"]
    assert body["clientContext"]["userPaygateTier"] == "PAYGATE_TIER_TWO"


@pytest.mark.asyncio
async def test_gen_video_omni_low_priority_overrides_envelope():
    """Omni Flash has no quality axis — the only path is the explicit
    `low_priority` kwarg. ON → envelope TIER_TWO, OFF → real tier."""
    client = RecordingClient()
    client.api_response = {
        "status": 200,
        "data": {"operations": [{"operation": {"name": "ops/omni"}}]},
    }
    sdk = FlowSDK(client)  # type: ignore[arg-type]
    await sdk.gen_video_omni(
        prompt="motion",
        project_id="proj-123",
        ref_media_ids=["ref-A"],
        duration_s=4,
        paygate_tier="PAYGATE_TIER_ONE",
        low_priority=True,
    )
    body = client.api_calls[0]["body"]
    assert body["clientContext"]["userPaygateTier"] == "PAYGATE_TIER_TWO"


@pytest.mark.asyncio
async def test_processor_handle_gen_video_auto_switches_quality_when_low_priority():
    """Processor wiring: when the worker receives `low_priority=True`
    and no explicit `video_quality`, it MUST forward `lite_relaxed` to
    the SDK. A caller-stamped explicit quality wins so power users keep
    control (covered by the next test)."""
    from flowboard.worker import processor

    captured: dict[str, Any] = {}

    class FakeSDK:
        async def gen_video(self, **kwargs):
            captured.update(kwargs)
            return {
                "operation_names": ["ops/abc"],
                "raw": {"data": {"operations": [{"operation": {"name": "ops/abc"}}]}},
            }

    original_sdk = processor.get_flow_sdk
    original_poll_max = processor.VIDEO_POLL_MAX_CYCLES
    processor.get_flow_sdk = lambda: FakeSDK()  # type: ignore[assignment]
    processor.VIDEO_POLL_MAX_CYCLES = 0  # bail polling immediately

    try:
        await processor._handle_gen_video(
            {
                "prompt": "motion",
                "project_id": "01234567-89ab-cdef-0123-456789abcdef",
                "start_media_id": "media-A",
                "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                "paygate_tier": "PAYGATE_TIER_ONE",
                "low_priority": True,
            }
        )
    finally:
        processor.get_flow_sdk = original_sdk  # type: ignore[assignment]
        processor.VIDEO_POLL_MAX_CYCLES = original_poll_max

    assert captured.get("video_quality") == "lite_relaxed"


@pytest.mark.asyncio
async def test_processor_handle_gen_video_caller_quality_wins_over_low_priority():
    """If the caller pinned `video_quality` explicitly, the low-priority
    toggle MUST NOT clobber it — explicit beats implicit."""
    from flowboard.worker import processor

    captured: dict[str, Any] = {}

    class FakeSDK:
        async def gen_video(self, **kwargs):
            captured.update(kwargs)
            return {
                "operation_names": ["ops/abc"],
                "raw": {"data": {"operations": [{"operation": {"name": "ops/abc"}}]}},
            }

    original_sdk = processor.get_flow_sdk
    original_poll_max = processor.VIDEO_POLL_MAX_CYCLES
    processor.get_flow_sdk = lambda: FakeSDK()  # type: ignore[assignment]
    processor.VIDEO_POLL_MAX_CYCLES = 0

    try:
        await processor._handle_gen_video(
            {
                "prompt": "motion",
                "project_id": "01234567-89ab-cdef-0123-456789abcdef",
                "start_media_id": "media-A",
                "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                "paygate_tier": "PAYGATE_TIER_ONE",
                "video_quality": "fast",
                "low_priority": True,
            }
        )
    finally:
        processor.get_flow_sdk = original_sdk  # type: ignore[assignment]
        processor.VIDEO_POLL_MAX_CYCLES = original_poll_max

    assert captured.get("video_quality") == "fast"
