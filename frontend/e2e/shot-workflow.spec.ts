import { expect, test } from "@playwright/test";

test("builds storyboard sequence shot workflow from palette", async ({
  page,
  request,
}) => {
  const boardName = `Phase5 e2e ${Date.now()}`;
  const boardRes = await request.post("/api/boards", {
    data: { name: boardName },
  });
  expect(boardRes.ok()).toBeTruthy();
  const board = (await boardRes.json()) as { id: number; name: string };
  const requestRows = new Map<
    number,
    {
      id: number;
      node_id: number | null;
      type: string;
      params: Record<string, unknown>;
    }
  >();
  let nextRequestId = 5000;
  let exportCount = 0;

  try {
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          email: "phase5@example.test",
          name: "Phase5",
          picture: null,
          verified_email: true,
          paygate_tier: "PAYGATE_TIER_ONE",
          sku: "WS_PRO",
          credits: 100,
        }),
      });
    });
    await page.route("**/api/boards/*/project", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flow_project_id: "flow_e2e_project", created: false }),
      });
    });
    await page.route("**/api/requests", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const payload = JSON.parse(route.request().postData() ?? "{}") as {
        node_id?: number;
        type: string;
        params: Record<string, unknown>;
      };
      const id = nextRequestId++;
      const row = {
        id,
        node_id: payload.node_id ?? null,
        type: payload.type,
        params: payload.params,
      };
      requestRows.set(id, row);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...row,
          status: "queued",
          result: {},
          error: null,
          created_at: new Date().toISOString(),
          finished_at: null,
        }),
      });
    });
    await page.route(/\/api\/requests\/\d+$/, async (route) => {
      const id = Number(route.request().url().split("/").pop());
      const row = requestRows.get(id);
      if (!row) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...row,
          status: "done",
          result: {
            media_ids: [`media-${row.node_id ?? id}`],
            slot_errors: [null],
          },
          error: null,
          created_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        }),
      });
    });
    await page.route("**/api/exports/timelines/*", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      exportCount += 1;
      const timelineId = Number(route.request().url().split("/").pop());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          timeline_node_id: timelineId,
          media_id: "eeeeeeee-0000-4000-8000-000000000001",
          url: "/media/eeeeeeee-0000-4000-8000-000000000001",
          clip_count: 4,
          source_media_ids: ["a", "b", "c", "d"],
          width: 1080,
          height: 1920,
          exported_at: "2026-05-25T00:10:00.000Z",
          export_status: "fresh",
          export_version: 1,
        }),
      });
    });

    await page.addInitScript((boardId) => {
      localStorage.setItem("flowboard.activeBoardId", String(boardId));
    }, board.id);
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Rename board" })).toContainText(boardName);
    await page
      .getByLabel("Sequence brief / Ý tưởng chuỗi cảnh")
      .fill("skincare serum launch");
    await page.getByRole("button", { name: "Increase shot count" }).click();
    await page.getByRole("button", { name: "Increase shot duration" }).click();
    await page
      .getByRole("button", { name: "Plan storyboard sequence / Lập cảnh chuỗi" })
      .click();

    const planDialog = page.getByRole("dialog", { name: "Shot plan / Kế hoạch cảnh" });
    await expect(planDialog).toBeVisible();
    await expect(planDialog.getByText("4 shots / 4 cảnh")).toBeVisible();
    await planDialog
      .getByLabel("Shot 2 video prompt / Prompt video cảnh 2")
      .fill("Custom edited video prompt for serum texture");
    await planDialog
      .getByLabel("Shot 2 duration / Thời lượng cảnh 2")
      .fill("6");
    await test.info().attach("shot-plan-preview", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page
      .getByRole("button", { name: "Create workflow / Tạo flow" })
      .click();

    await expect(planDialog).toBeHidden();
    await expect(page.locator(".node-card")).toHaveCount(13);
    await expect(page.getByText("Timeline / Dòng dựng").first()).toBeVisible();
    await expect(page.locator(".timeline-shot-row")).toHaveCount(4);
    await expect(
      page.locator(".shot-badge").filter({ hasText: "First frame / Khung đầu" }),
    ).toHaveCount(4);
    await expect(
      page.locator(".shot-badge").filter({ hasText: "Clip / Video" }),
    ).toHaveCount(4);

    await expect(page.getByRole("dialog", { name: /Generate image/i })).toHaveCount(0);

    const detailRes = await request.get(`/api/boards/${board.id}`);
    expect(detailRes.ok()).toBeTruthy();
    const detail = (await detailRes.json()) as {
      nodes: Array<{ data: Record<string, unknown>; type: string }>;
      edges: Array<{ ref_role: string | null }>;
    };
    const frames = detail.nodes
      .filter((node) => node.data.workflowKind === "shot_frame")
      .sort((a, b) => Number(a.data.shotIndex) - Number(b.data.shotIndex));
    const clips = detail.nodes
      .filter((node) => node.data.workflowKind === "shot_clip")
      .sort((a, b) => Number(a.data.shotIndex) - Number(b.data.shotIndex));
    expect(frames).toHaveLength(4);
    expect(clips).toHaveLength(4);
    expect(
      detail.nodes.filter((node) => node.data.workflowKind === "timeline"),
    ).toHaveLength(1);
    expect(clips.map((node) => node.data.shotDurationSec)).toEqual([5, 6, 5, 5]);
    expect(frames.every((node) => String(node.data.prompt).includes("skincare serum launch"))).toBeTruthy();
    expect(clips[1].data.prompt).toBe("Custom edited video prompt for serum texture");
    expect(frames.every((node) => node.data.shotPlanSource === "custom")).toBeTruthy();
    expect(clips.every((node) => node.data.shotPlanSource === "custom")).toBeTruthy();
    expect(detail.edges.filter((edge) => edge.ref_role === "first_frame")).toHaveLength(4);
    expect(detail.edges.filter((edge) => edge.ref_role === "storyboard_panel")).toHaveLength(4);

    const frameRunner = page.getByRole("button", { name: "Generate frames / Tạo ảnh cảnh" });
    await expect(frameRunner).toBeEnabled();
    await frameRunner.click();
    await expect
      .poll(() => Array.from(requestRows.values()).filter((row) => row.type === "gen_image").length)
      .toBe(4);
    const imageRequests = Array.from(requestRows.values()).filter(
      (row) => row.type === "gen_image",
    );
    expect(imageRequests.every((row) => row.params.project_id === "flow_e2e_project")).toBeTruthy();
    expect(imageRequests.every((row) => row.params.aspect_ratio === "IMAGE_ASPECT_RATIO_PORTRAIT")).toBeTruthy();
    expect(imageRequests.every((row) => row.params.variant_count === 1)).toBeTruthy();
    expect(imageRequests.every((row) => String(row.params.prompt).includes("skincare serum launch"))).toBeTruthy();

    const clipRunner = page.getByRole("button", { name: "Generate clips / Tạo video" });
    await expect(clipRunner).toBeEnabled({ timeout: 7000 });
    await clipRunner.click();
    await expect
      .poll(() => Array.from(requestRows.values()).filter((row) => row.type === "gen_video").length)
      .toBe(4);
    const videoRequests = Array.from(requestRows.values()).filter(
      (row) => row.type === "gen_video",
    );
    expect(videoRequests.every((row) => row.params.project_id === "flow_e2e_project")).toBeTruthy();
    expect(videoRequests.every((row) => row.params.aspect_ratio === "VIDEO_ASPECT_RATIO_PORTRAIT")).toBeTruthy();
    expect(videoRequests.every((row) => String(row.params.start_media_id).startsWith("media-"))).toBeTruthy();
    await expect(
      page.getByText("4/4 frames / ảnh · 4/4 clips / video"),
    ).toBeVisible({ timeout: 7000 });

    const exportRunner = page.getByRole("button", { name: "Export short / Xuất video" });
    await expect(exportRunner).toBeEnabled();
    await exportRunner.click();
    await expect.poll(() => exportCount).toBe(1);
    await expect(page.getByRole("link", { name: "Open export / Mở file" })).toBeVisible();
    await expect(page.getByText("Export fresh v1 / mới")).toBeVisible();

    await test.info().attach("shot-workflow-scaffold", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    await request.delete(`/api/boards/${board.id}`);
  }
});

test("marks a rendered variant as best from result viewer", async ({
  page,
  request,
}) => {
  const boardName = `Best variant e2e ${Date.now()}`;
  const boardRes = await request.post("/api/boards", {
    data: { name: boardName },
  });
  expect(boardRes.ok()).toBeTruthy();
  const board = (await boardRes.json()) as { id: number; name: string };
  const nodeRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "video",
      x: 80,
      y: 80,
      status: "done",
      data: {
        title: "Review Clip",
        prompt: "two rendered variants",
        mediaId: "best-a",
        mediaIds: ["best-a", "best-b"],
        variantCount: 2,
        workflowKind: "shot_clip",
        shotIndex: 1,
      },
    },
  });
  expect(nodeRes.ok()).toBeTruthy();
  const node = (await nodeRes.json()) as { id: number };

  try {
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          email: "best@example.test",
          name: "Best",
          picture: null,
          verified_email: true,
          paygate_tier: "PAYGATE_TIER_ONE",
          sku: "WS_PRO",
          credits: 100,
        }),
      });
    });
    await page.route(/\/api\/media\/best-[ab]\/status$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ available: false, has_url: false }),
      });
    });
    await page.route(/\/media\/best-[ab](\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: "",
      });
    });

    await page.addInitScript((boardId) => {
      localStorage.setItem("flowboard.activeBoardId", String(boardId));
    }, board.id);
    await page.goto("/");

    await expect(page.getByText("Review Clip").first()).toBeVisible();
    await expect(page.locator(".video-tile")).toHaveCount(2);
    await page.locator(".video-tile").nth(1).click();

    const viewer = page.getByRole("dialog", { name: "Review Clip" });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Variant 2" })).toHaveAttribute("aria-pressed", "true");
    await viewer.getByRole("button", { name: "Mark best" }).click();

    await expect(viewer.getByRole("button", { name: /Best variant/ })).toBeVisible();
    await expect(viewer.locator(".variant-switcher__chip--best")).toHaveText("✓");

    await expect.poll(async () => {
      const detailRes = await request.get(`/api/boards/${board.id}`);
      expect(detailRes.ok()).toBeTruthy();
      const detail = (await detailRes.json()) as {
        nodes: Array<{ id: number; data: Record<string, unknown> }>;
      };
      return detail.nodes.find((entry) => entry.id === node.id)?.data;
    }).toMatchObject({
      mediaId: "best-b",
      bestMediaId: "best-b",
      bestVariantIdx: 1,
      reviewVerdict: "good",
    });
  } finally {
    await request.delete(`/api/boards/${board.id}`);
  }
});

test("marks redo with note and opens redo clip clone", async ({
  page,
  request,
}) => {
  const boardName = `Redo review e2e ${Date.now()}`;
  const boardRes = await request.post("/api/boards", {
    data: { name: boardName },
  });
  expect(boardRes.ok()).toBeTruthy();
  const board = (await boardRes.json()) as { id: number; name: string };
  const nodeRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "video",
      x: 80,
      y: 80,
      status: "done",
      data: {
        title: "Review Clip",
        prompt: "show the product logo clearly",
        mediaId: "redo-a",
        mediaIds: ["redo-a"],
        variantCount: 1,
        workflowKind: "shot_clip",
        shotId: "shot-1",
        shotIndex: 1,
        shotDurationSec: 6,
      },
    },
  });
  expect(nodeRes.ok()).toBeTruthy();
  const node = (await nodeRes.json()) as { id: number };
  const frameRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "image",
      x: 80,
      y: 300,
      status: "done",
      data: {
        title: "Shot 1 frame",
        mediaId: "redo-frame",
        mediaIds: ["redo-frame"],
        workflowKind: "shot_frame",
        shotId: "shot-1",
        shotIndex: 1,
        shotDurationSec: 6,
      },
    },
  });
  const timelineRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "note",
      x: 640,
      y: 80,
      status: "done",
      data: {
        title: "Timeline",
        workflowKind: "timeline",
        timelineShotIds: ["shot-1"],
        exportMediaId: "old-redo-export",
        exportedAt: "2026-05-25T00:00:00.000Z",
        exportClipCount: 1,
        exportSize: "1080x1920",
        exportStatus: "fresh",
        exportVersion: 1,
        exportSourceMediaIds: ["redo-a"],
      },
    },
  });
  expect(frameRes.ok()).toBeTruthy();
  expect(timelineRes.ok()).toBeTruthy();
  const frame = (await frameRes.json()) as { id: number };
  const timeline = (await timelineRes.json()) as { id: number };
  for (const edge of [
    { source_id: frame.id, target_id: node.id, ref_role: "first_frame" },
    { source_id: node.id, target_id: timeline.id, ref_role: "storyboard_panel" },
  ]) {
    const edgeRes = await request.post("/api/edges", {
      data: { board_id: board.id, kind: "ref", ...edge },
    });
    expect(edgeRes.ok()).toBeTruthy();
  }

  try {
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          email: "redo@example.test",
          name: "Redo",
          picture: null,
          verified_email: true,
          paygate_tier: "PAYGATE_TIER_ONE",
          sku: "WS_PRO",
          credits: 100,
        }),
      });
    });
    await page.route(/\/api\/media\/redo-a\/status$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ available: false, has_url: false }),
      });
    });
    await page.route(/\/media\/redo-a(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: "",
      });
    });

    await page.addInitScript((boardId) => {
      localStorage.setItem("flowboard.activeBoardId", String(boardId));
    }, board.id);
    await page.goto("/");

    await page.locator(".video-tile").first().click();
    const viewer = page.getByRole("dialog", { name: "Review Clip" });
    await expect(viewer).toBeVisible();
    await viewer.getByLabel("Review note").fill("logo drifts off label");
    await viewer.getByRole("button", { name: "Redo from note" }).click();

    await expect(page.getByRole("dialog", { name: /Generate video/i })).toBeVisible();
    await expect.poll(async () => {
      const detailRes = await request.get(`/api/boards/${board.id}`);
      expect(detailRes.ok()).toBeTruthy();
      const detail = (await detailRes.json()) as {
        nodes: Array<{ id: number; data: Record<string, unknown>; type: string }>;
        edges: Array<{
          source_id: number;
          target_id: number;
          ref_role: string | null;
        }>;
      };
      const redo = detail.nodes.find((entry) =>
        entry.id !== node.id
        && entry.type === "video"
        && String(entry.data.title).includes("(redo)")
      );
      const timelineNode = detail.nodes.find((entry) => entry.id === timeline.id);
      return {
        original: detail.nodes.find((entry) => entry.id === node.id)?.data,
        redo: redo?.data,
        timelineExportMediaId: timelineNode?.data.exportMediaId,
        timelineExportStatus: timelineNode?.data.exportStatus,
        timelineExportVersion: timelineNode?.data.exportVersion,
        storyboardPointsToRedo: Boolean(
          redo
          && detail.edges.some((edge) =>
            edge.ref_role === "storyboard_panel"
            && edge.source_id === redo.id
            && edge.target_id === timeline.id,
          ),
        ),
        storyboardPointsToOriginal: detail.edges.some((edge) =>
          edge.ref_role === "storyboard_panel"
          && edge.source_id === node.id
          && edge.target_id === timeline.id,
        ),
        firstFramePointsToRedo: Boolean(
          redo
          && detail.edges.some((edge) =>
            edge.ref_role === "first_frame"
            && edge.source_id === frame.id
            && edge.target_id === redo.id,
          ),
        ),
      };
    }).toMatchObject({
      original: {
        reviewVerdict: "redo",
        reviewNote: "logo drifts off label",
      },
      redo: {
        title: "Review Clip (redo)",
        prompt: expect.stringContaining("logo drifts off label"),
        workflowKind: "shot_clip",
        shotId: "shot-1",
        shotIndex: 1,
        shotDurationSec: 6,
      },
      timelineExportMediaId: "old-redo-export",
      timelineExportStatus: "stale",
      timelineExportVersion: 1,
      storyboardPointsToRedo: true,
      storyboardPointsToOriginal: false,
      firstFramePointsToRedo: true,
    });
  } finally {
    await request.delete(`/api/boards/${board.id}`);
  }
});

test("refines video from note and supersedes timeline clip", async ({
  page,
  request,
}) => {
  const boardName = `Refine video e2e ${Date.now()}`;
  const boardRes = await request.post("/api/boards", {
    data: { name: boardName },
  });
  expect(boardRes.ok()).toBeTruthy();
  const board = (await boardRes.json()) as { id: number; name: string };
  const frameRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "image",
      x: 80,
      y: 300,
      status: "done",
      data: {
        title: "Shot 1 frame",
        mediaId: "refine-frame",
        mediaIds: ["refine-frame"],
        workflowKind: "shot_frame",
        shotId: "shot-1",
        shotIndex: 1,
        shotDurationSec: 6,
        aspectRatio: "IMAGE_ASPECT_RATIO_PORTRAIT",
      },
    },
  });
  const clipRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "video",
      x: 80,
      y: 80,
      status: "done",
      data: {
        title: "Clip A",
        prompt: "hold the subject in frame",
        mediaId: "refine-a",
        mediaIds: ["refine-a"],
        variantCount: 1,
        workflowKind: "shot_clip",
        shotId: "shot-1",
        shotIndex: 1,
        shotDurationSec: 6,
        aspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
        videoRecipeId: "auto",
        videoAudioMode: "ambient",
      },
    },
  });
  const timelineRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "note",
      x: 640,
      y: 80,
      status: "done",
      data: {
        title: "Timeline",
        workflowKind: "timeline",
        timelineShotIds: ["shot-1"],
        exportMediaId: "old-refine-export",
        exportedAt: "2026-05-25T00:00:00.000Z",
        exportClipCount: 1,
        exportSize: "1080x1920",
        exportStatus: "fresh",
        exportVersion: 1,
        exportSourceMediaIds: ["refine-a"],
      },
    },
  });
  expect(frameRes.ok()).toBeTruthy();
  expect(clipRes.ok()).toBeTruthy();
  expect(timelineRes.ok()).toBeTruthy();
  const frame = (await frameRes.json()) as { id: number };
  const clip = (await clipRes.json()) as { id: number };
  const timeline = (await timelineRes.json()) as { id: number };
  for (const edge of [
    { source_id: frame.id, target_id: clip.id, ref_role: "first_frame" },
    { source_id: clip.id, target_id: timeline.id, ref_role: "storyboard_panel" },
  ]) {
    const edgeRes = await request.post("/api/edges", {
      data: { board_id: board.id, kind: "ref", ...edge },
    });
    expect(edgeRes.ok()).toBeTruthy();
  }
  const requestRows = new Map<
    number,
    {
      id: number;
      node_id: number | null;
      type: string;
      params: Record<string, unknown>;
    }
  >();
  let nextRequestId = 8000;

  try {
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          email: "refine@example.test",
          name: "Refine",
          picture: null,
          verified_email: true,
          paygate_tier: "PAYGATE_TIER_ONE",
          sku: "WS_PRO",
          credits: 100,
        }),
      });
    });
    await page.route("**/api/boards/*/project", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flow_project_id: "flow_refine_project", created: false }),
      });
    });
    await page.route("**/api/requests", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const payload = JSON.parse(route.request().postData() ?? "{}") as {
        node_id?: number;
        type: string;
        params: Record<string, unknown>;
      };
      const id = nextRequestId++;
      const row = {
        id,
        node_id: payload.node_id ?? null,
        type: payload.type,
        params: payload.params,
      };
      requestRows.set(id, row);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...row,
          status: "queued",
          result: {},
          error: null,
          created_at: new Date().toISOString(),
          finished_at: null,
        }),
      });
    });
    await page.route(/\/api\/requests\/\d+$/, async (route) => {
      const id = Number(route.request().url().split("/").pop());
      const row = requestRows.get(id);
      if (!row) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...row,
          status: "done",
          result: {
            media_ids: [`refined-${row.node_id ?? id}`],
            slot_errors: [null],
          },
          error: null,
          created_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        }),
      });
    });
    await page.route(/\/api\/media\/refine-a\/status$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ available: false, has_url: false }),
      });
    });
    await page.route(/\/media\/refine-a(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: "",
      });
    });

    await page.addInitScript((boardId) => {
      localStorage.setItem("flowboard.activeBoardId", String(boardId));
    }, board.id);
    await page.goto("/");

    await page.locator(".video-tile").first().click();
    const viewer = page.getByRole("dialog", { name: "Clip A" });
    await expect(viewer).toBeVisible();
    await viewer.getByLabel("Review note").fill("tighten framing");
    await viewer.getByRole("button", { name: "Refine video from note" }).click();

    const genDialog = page.getByRole("dialog", { name: /Generate video/i });
    await expect(genDialog).toBeVisible();
    await expect(genDialog.getByLabel("Motion prompt")).toHaveValue(/tighten framing/);

    let refinedId: number | null = null;
    await expect.poll(async () => {
      const detailRes = await request.get(`/api/boards/${board.id}`);
      expect(detailRes.ok()).toBeTruthy();
      const detail = (await detailRes.json()) as {
        nodes: Array<{ id: number; data: Record<string, unknown>; type: string }>;
        edges: Array<{
          source_id: number;
          target_id: number;
          ref_role: string | null;
        }>;
      };
      const refined = detail.nodes.find((entry) =>
        entry.id !== clip.id
        && entry.type === "video"
        && String(entry.data.title).includes("(refine)")
      );
      refinedId = refined?.id ?? null;
      const timelineNode = detail.nodes.find((entry) => entry.id === timeline.id);
      return {
        refinedId: refined?.id ?? null,
        originalNote: detail.nodes.find((entry) => entry.id === clip.id)?.data.reviewNote,
        refined: refined?.data,
        timelineExportMediaId: timelineNode?.data.exportMediaId,
        timelineExportStatus: timelineNode?.data.exportStatus,
        timelineExportVersion: timelineNode?.data.exportVersion,
        storyboardPointsToRefine: Boolean(
          refined
          && detail.edges.some((edge) =>
            edge.ref_role === "storyboard_panel"
            && edge.source_id === refined.id
            && edge.target_id === timeline.id,
          ),
        ),
        storyboardPointsToOriginal: detail.edges.some((edge) =>
          edge.ref_role === "storyboard_panel"
          && edge.source_id === clip.id
          && edge.target_id === timeline.id,
        ),
        firstFramePointsToRefine: Boolean(
          refined
          && detail.edges.some((edge) =>
            edge.ref_role === "first_frame"
            && edge.source_id === frame.id
            && edge.target_id === refined.id,
          ),
        ),
      };
    }).toMatchObject({
      refinedId: expect.any(Number),
      originalNote: "tighten framing",
      refined: {
        title: "Clip A (refine)",
        prompt: expect.stringContaining("tighten framing"),
        workflowKind: "shot_clip",
        shotId: "shot-1",
        shotIndex: 1,
        shotDurationSec: 6,
        videoRecipeId: "auto",
        videoAudioMode: "ambient",
      },
      timelineExportMediaId: "old-refine-export",
      timelineExportStatus: "stale",
      timelineExportVersion: 1,
      storyboardPointsToRefine: true,
      storyboardPointsToOriginal: false,
      firstFramePointsToRefine: true,
    });

    const generateButton = genDialog.getByRole("button", { name: "Generate ⌘↵" });
    await expect(generateButton).toBeEnabled();
    await generateButton.click();
    await expect
      .poll(() => Array.from(requestRows.values()).filter((row) => row.type === "gen_video").length)
      .toBe(1);
    const [videoRequest] = Array.from(requestRows.values()).filter(
      (row) => row.type === "gen_video",
    );
    expect(refinedId).not.toBeNull();
    const refinedNodeId = refinedId as number;
    expect(videoRequest.node_id).toBe(refinedNodeId);
    expect(videoRequest.params.project_id).toBe("flow_refine_project");
    expect(videoRequest.params.start_media_id).toBe("refine-frame");
    expect(videoRequest.params.start_media_ids).toBeUndefined();
    expect(videoRequest.params.aspect_ratio).toBe("VIDEO_ASPECT_RATIO_PORTRAIT");
    expect(String(videoRequest.params.prompt)).toContain("tighten framing");

    await expect.poll(async () => {
      const detailRes = await request.get(`/api/boards/${board.id}`);
      expect(detailRes.ok()).toBeTruthy();
      const detail = (await detailRes.json()) as {
        nodes: Array<{ id: number; data: Record<string, unknown> }>;
      };
      return detail.nodes.find((entry) => entry.id === refinedNodeId)?.data.mediaId;
    }).toBe(`refined-${refinedNodeId}`);
  } finally {
    await request.delete(`/api/boards/${board.id}`);
  }
});

test("skips blocked no-media clip and exports remaining timeline", async ({
  page,
  request,
}) => {
  const boardName = `Skip no-media e2e ${Date.now()}`;
  const boardRes = await request.post("/api/boards", {
    data: { name: boardName },
  });
  expect(boardRes.ok()).toBeTruthy();
  const board = (await boardRes.json()) as { id: number; name: string };
  const blockedRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "video",
      x: 80,
      y: 80,
      status: "error",
      data: {
        title: "Blocked Clip",
        prompt: "blocked variant",
        mediaIds: [null],
        slotErrors: ["PUBLIC_ERROR_UNSAFE_GENERATION"],
        variantCount: 1,
        workflowKind: "shot_clip",
        shotId: "shot-1",
        shotIndex: 1,
        error: "PUBLIC_ERROR_UNSAFE_GENERATION",
      },
    },
  });
  const keptRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "video",
      x: 360,
      y: 80,
      status: "done",
      data: {
        title: "Kept Clip",
        prompt: "usable variant",
        mediaId: "skip-keep",
        mediaIds: ["skip-keep"],
        variantCount: 1,
        workflowKind: "shot_clip",
        shotId: "shot-2",
        shotIndex: 2,
      },
    },
  });
  const timelineRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "note",
      x: 640,
      y: 80,
      status: "done",
      data: {
        title: "Timeline",
        workflowKind: "timeline",
        timelineShotIds: ["shot-1", "shot-2"],
        exportMediaId: "old-skip-export",
        exportedAt: "2026-05-25T00:00:00.000Z",
        exportClipCount: 2,
        exportSize: "1080x1920",
        exportStatus: "fresh",
        exportVersion: 1,
        exportSourceMediaIds: ["skip-blocked", "skip-keep"],
      },
    },
  });
  expect(blockedRes.ok()).toBeTruthy();
  expect(keptRes.ok()).toBeTruthy();
  expect(timelineRes.ok()).toBeTruthy();
  const blocked = (await blockedRes.json()) as { id: number };
  const kept = (await keptRes.json()) as { id: number };
  const timeline = (await timelineRes.json()) as { id: number };
  for (const source of [blocked.id, kept.id]) {
    const edgeRes = await request.post("/api/edges", {
      data: {
        board_id: board.id,
        kind: "ref",
        source_id: source,
        target_id: timeline.id,
        ref_role: "storyboard_panel",
      },
    });
    expect(edgeRes.ok()).toBeTruthy();
  }
  let exportCount = 0;

  try {
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          email: "skip@example.test",
          name: "Skip",
          picture: null,
          verified_email: true,
          paygate_tier: "PAYGATE_TIER_ONE",
          sku: "WS_PRO",
          credits: 100,
        }),
      });
    });
    await page.route(/\/media\/skip-keep(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: "",
      });
    });
    await page.route("**/api/exports/timelines/*", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      exportCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          timeline_node_id: timeline.id,
          media_id: "new-skip-export",
          url: "/media/new-skip-export",
          clip_count: 1,
          source_media_ids: ["skip-keep"],
          width: 1080,
          height: 1920,
          exported_at: "2026-05-25T00:20:00.000Z",
          export_status: "fresh",
          export_version: 2,
          export_history: [
            {
              mediaId: "old-skip-export",
              status: "stale",
              version: 1,
              exportedAt: "2026-05-25T00:00:00.000Z",
              clipCount: 2,
              size: "1080x1920",
              sourceMediaIds: ["skip-blocked", "skip-keep"],
              staleAt: "2026-05-25T00:10:00.000Z",
              staleReason: "review_changed",
            },
          ],
        }),
      });
    });

    await page.addInitScript((boardId) => {
      localStorage.setItem("flowboard.activeBoardId", String(boardId));
    }, board.id);
    await page.goto("/");

    await page.locator(".video-tile--blocked").click();
    const viewer = page.getByRole("dialog", { name: "Blocked Clip" });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Skip" })).toBeEnabled();
    await viewer.getByRole("button", { name: "Skip" }).click();

    await expect.poll(async () => {
      const detailRes = await request.get(`/api/boards/${board.id}`);
      expect(detailRes.ok()).toBeTruthy();
      const detail = (await detailRes.json()) as {
        nodes: Array<{ id: number; data: Record<string, unknown> }>;
      };
      return {
        blockedVerdict: detail.nodes.find((entry) => entry.id === blocked.id)?.data.reviewVerdict,
        timelineExportMediaId:
          detail.nodes.find((entry) => entry.id === timeline.id)?.data.exportMediaId,
        timelineExportStatus:
          detail.nodes.find((entry) => entry.id === timeline.id)?.data.exportStatus,
        timelineExportVersion:
          detail.nodes.find((entry) => entry.id === timeline.id)?.data.exportVersion,
      };
    }).toEqual({
      blockedVerdict: "skip",
      timelineExportMediaId: "old-skip-export",
      timelineExportStatus: "stale",
      timelineExportVersion: 1,
    });

    await page.keyboard.press("Escape");
    await expect(page.getByText("Export stale v1 / bản cũ")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open stale export / Mở bản cũ" })).toBeVisible();
    const exportRunner = page.getByRole("button", { name: "Re-export fresh / Xuất lại" });
    await expect(exportRunner).toBeEnabled();
    await exportRunner.click();
    await expect.poll(() => exportCount).toBe(1);
    await expect(page.getByText("Export fresh v2 / mới")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open export / Mở file" })).toHaveAttribute(
      "href",
      "/media/new-skip-export",
    );
    await page.getByText("History / Lịch sử (1)").click();
    await expect(page.getByText("v1 · stale · 2 clips")).toBeVisible();
    await expect(page.getByText("review_changed")).toBeVisible();
    await expect(page.getByRole("link", { name: /Open history export v1/ })).toHaveAttribute(
      "href",
      "/media/old-skip-export",
    );
  } finally {
    await request.delete(`/api/boards/${board.id}`);
  }
});

test("timeline clip runner uses best-selected frame variant", async ({
  page,
  request,
}) => {
  const boardName = `Best frame runner e2e ${Date.now()}`;
  const boardRes = await request.post("/api/boards", {
    data: { name: boardName },
  });
  expect(boardRes.ok()).toBeTruthy();
  const board = (await boardRes.json()) as { id: number; name: string };
  const frameRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "image",
      x: 80,
      y: 80,
      status: "done",
      data: {
        title: "Shot 1 frame",
        prompt: "first frame",
        mediaId: "frame-b",
        mediaIds: ["frame-a", "frame-b"],
        bestMediaId: "frame-b",
        bestVariantIdx: 1,
        variantCount: 2,
        workflowKind: "shot_frame",
        shotIndex: 1,
      },
    },
  });
  const clipRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "video",
      x: 360,
      y: 80,
      status: "idle",
      data: {
        title: "Shot 1 clip",
        prompt: "make clip",
        workflowKind: "shot_clip",
        shotIndex: 1,
      },
    },
  });
  const timelineRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "note",
      x: 640,
      y: 80,
      status: "idle",
      data: {
        title: "Timeline",
        workflowKind: "timeline",
        timelineShotIds: ["shot-1"],
      },
    },
  });
  expect(frameRes.ok()).toBeTruthy();
  expect(clipRes.ok()).toBeTruthy();
  expect(timelineRes.ok()).toBeTruthy();
  const frame = (await frameRes.json()) as { id: number };
  const clip = (await clipRes.json()) as { id: number };
  const timeline = (await timelineRes.json()) as { id: number };
  const requestRows = new Map<
    number,
    {
      id: number;
      node_id: number | null;
      type: string;
      params: Record<string, unknown>;
    }
  >();
  let nextRequestId = 7000;

  try {
    for (const edge of [
      { source_id: frame.id, target_id: clip.id, ref_role: "first_frame" },
      { source_id: clip.id, target_id: timeline.id, ref_role: "storyboard_panel" },
    ]) {
      const edgeRes = await request.post("/api/edges", {
        data: { board_id: board.id, kind: "ref", ...edge },
      });
      expect(edgeRes.ok()).toBeTruthy();
    }

    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          email: "runner@example.test",
          name: "Runner",
          picture: null,
          verified_email: true,
          paygate_tier: "PAYGATE_TIER_ONE",
          sku: "WS_PRO",
          credits: 100,
        }),
      });
    });
    await page.route("**/api/boards/*/project", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flow_project_id: "flow_best_project", created: false }),
      });
    });
    await page.route("**/api/requests", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const payload = JSON.parse(route.request().postData() ?? "{}") as {
        node_id?: number;
        type: string;
        params: Record<string, unknown>;
      };
      const id = nextRequestId++;
      const row = {
        id,
        node_id: payload.node_id ?? null,
        type: payload.type,
        params: payload.params,
      };
      requestRows.set(id, row);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...row,
          status: "queued",
          result: {},
          error: null,
          created_at: new Date().toISOString(),
          finished_at: null,
        }),
      });
    });
    await page.route(/\/api\/requests\/\d+$/, async (route) => {
      const id = Number(route.request().url().split("/").pop());
      const row = requestRows.get(id);
      if (!row) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...row,
          status: "done",
          result: {
            media_ids: [`clip-${row.node_id ?? id}`],
            slot_errors: [null],
          },
          error: null,
          created_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        }),
      });
    });

    await page.addInitScript((boardId) => {
      localStorage.setItem("flowboard.activeBoardId", String(boardId));
    }, board.id);
    await page.goto("/");

    const clipRunner = page.getByRole("button", { name: "Generate clips / Tạo video" });
    await expect(clipRunner).toBeEnabled();
    await clipRunner.click();

    await expect
      .poll(() => Array.from(requestRows.values()).filter((row) => row.type === "gen_video").length)
      .toBe(1);
    const [videoRequest] = Array.from(requestRows.values()).filter(
      (row) => row.type === "gen_video",
    );
    expect(videoRequest.params.start_media_id).toBe("frame-b");
    expect(videoRequest.params.start_media_ids).toBeUndefined();
  } finally {
    await request.delete(`/api/boards/${board.id}`);
  }
});
