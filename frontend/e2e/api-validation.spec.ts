import { expect, test, type Page } from "@playwright/test";

async function stubAccount(page: Page) {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        email: "api-validation@example.test",
        name: "API Validation",
        picture: null,
        verified_email: true,
        paygate_tier: "PAYGATE_TIER_ONE",
        sku: "WS_PRO",
        credits: 100,
      }),
    });
  });
}

test("surfaces malformed timeline API responses", async ({ page, request }) => {
  const boardName = `API validation e2e ${Date.now()}`;
  const boardRes = await request.post("/api/boards", {
    data: { name: boardName },
  });
  expect(boardRes.ok()).toBeTruthy();
  const board = await boardRes.json() as { id: number; name: string };

  const clipRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "video",
      x: 80,
      y: 80,
      status: "done",
      data: {
        title: "Validated Clip",
        mediaId: "api-validation-clip",
        mediaIds: ["api-validation-clip"],
        workflowKind: "shot_clip",
        shotId: "shot_01",
        shotIndex: 1,
        shotDurationSec: 5,
      },
    },
  });
  expect(clipRes.ok()).toBeTruthy();
  const clip = await clipRes.json() as { id: number };

  const timelineRes = await request.post("/api/nodes", {
    data: {
      board_id: board.id,
      type: "note",
      x: 520,
      y: 80,
      status: "done",
      data: {
        title: "Timeline",
        workflowKind: "timeline",
        timelineShotIds: ["shot_01"],
        timelineDurationsSec: [5],
      },
    },
  });
  expect(timelineRes.ok()).toBeTruthy();
  const timeline = await timelineRes.json() as { id: number };

  const edgeRes = await request.post("/api/edges", {
    data: {
      board_id: board.id,
      source_id: clip.id,
      target_id: timeline.id,
      kind: "ref",
      ref_role: "storyboard_panel",
    },
  });
  expect(edgeRes.ok()).toBeTruthy();

  try {
    await stubAccount(page);
    await page.route(/\/media\/api-validation-clip(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: "",
      });
    });
    await page.route(/\/api\/exports\/timelines\/\d+\/qa$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{",
      });
    });
    await page.route(/\/api\/exports\/timelines\/\d+$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          timeline_node_id: timeline.id,
          url: "/media/missing-media-id",
          clip_count: 1,
          source_media_ids: ["api-validation-clip"],
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
    await expect(page.getByText("Timeline / Dòng dựng").first()).toBeVisible();

    await page.getByRole("button", { name: "Run QA / Kiểm QA" }).click();
    await expect(
      page.getByText("analyzeTimelineQa: invalid JSON response"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Export short / Xuất video" }).click();
    const preflight = page.getByRole("dialog", { name: "Export preflight" });
    await expect(preflight).toBeVisible();
    await preflight.getByRole("button", { name: "Confirm export / Xuất" }).dispatchEvent("click");
    await expect(
      page.getByText(/exportTimeline: invalid response \(media_id:/),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/boards/${board.id}`);
  }
});
