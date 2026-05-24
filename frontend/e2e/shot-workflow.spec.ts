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

    const dialog = page.getByRole("dialog", { name: /Generate image/i });
    await expect(dialog).toBeVisible();
    await expect(page.locator("#gen-prompt")).toHaveValue(/shot 1\/4/);
    await expect(page.locator("#gen-prompt")).toHaveValue(/skincare serum launch/);
    await expect(page.getByText("Source references (2)")).toBeVisible();
    await page.getByRole("button", { name: "Close dialog (Escape)" }).click();
    await expect(dialog).toBeHidden();

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

    await test.info().attach("shot-workflow-scaffold", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    await request.delete(`/api/boards/${board.id}`);
  }
});
