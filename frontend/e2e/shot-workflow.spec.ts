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
