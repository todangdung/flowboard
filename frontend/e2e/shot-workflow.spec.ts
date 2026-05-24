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

  try {
    await page.addInitScript((boardId) => {
      localStorage.setItem("flowboard.activeBoardId", String(boardId));
    }, board.id);
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Rename board" })).toContainText(boardName);
    await page.getByRole("button", { name: "Increase shot count" }).click();
    await page.getByRole("button", { name: "Increase shot duration" }).click();
    await page
      .getByRole("button", { name: /Create Seq \/ Chuỗi cảnh flow/i })
      .click();

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
    await expect(page.getByText("Source references (2)")).toBeVisible();

    const detailRes = await request.get(`/api/boards/${board.id}`);
    expect(detailRes.ok()).toBeTruthy();
    const detail = (await detailRes.json()) as {
      nodes: Array<{ data: Record<string, unknown>; type: string }>;
      edges: Array<{ ref_role: string | null }>;
    };
    expect(
      detail.nodes.filter((node) => node.data.workflowKind === "shot_frame"),
    ).toHaveLength(4);
    expect(
      detail.nodes.filter((node) => node.data.workflowKind === "shot_clip"),
    ).toHaveLength(4);
    expect(
      detail.nodes.filter((node) => node.data.workflowKind === "timeline"),
    ).toHaveLength(1);
    expect(
      detail.nodes
        .filter((node) => node.data.workflowKind === "shot_clip")
        .every((node) => node.data.shotDurationSec === 5),
    ).toBeTruthy();
    expect(detail.edges.filter((edge) => edge.ref_role === "first_frame")).toHaveLength(4);
    expect(detail.edges.filter((edge) => edge.ref_role === "storyboard_panel")).toHaveLength(4);

    await test.info().attach("shot-workflow-scaffold", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    await request.delete(`/api/boards/${board.id}`);
  }
});
