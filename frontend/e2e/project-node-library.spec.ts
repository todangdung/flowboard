import { expect, test, type Page } from "@playwright/test";

async function stubAccount(page: Page) {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        email: "ui-guardrail@example.test",
        name: "UI Guardrail",
        picture: null,
        verified_email: true,
        paygate_tier: "PAYGATE_TIER_ONE",
        sku: "WS_PRO",
        credits: 100,
      }),
    });
  });
}

test("keeps extra node recipes inside collapsible project sidebar folders", async ({
  page,
  request,
}) => {
  const boardName = `Project node library e2e ${Date.now()}`;
  const boardRes = await request.post("/api/boards", {
    data: { name: boardName },
  });
  expect(boardRes.ok()).toBeTruthy();
  const board = (await boardRes.json()) as { id: number; name: string };

  try {
    await stubAccount(page);
    await page.addInitScript((boardId) => {
      localStorage.setItem("flowboard.activeBoardId", String(boardId));
    }, board.id);
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Rename board" })).toContainText(boardName);

    const topPalette = page.locator(".add-node-palette");
    await expect(topPalette.locator(".add-node-chip")).toHaveCount(7);
    for (const label of [
      "Character",
      "Image",
      "Storyboard",
      "Video",
      "Visual asset",
      "Prompt",
      "Note",
    ]) {
      await expect(
        topPalette.getByRole("button", { name: `Add ${label} node` }),
      ).toBeVisible();
    }
    await expect(topPalette).not.toContainText("Product");
    await expect(topPalette).not.toContainText("Location");
    await expect(topPalette).not.toContainText("Brand");
    await expect(topPalette).not.toContainText("Campaign");
    await expect(topPalette).not.toContainText("Audio");

    const projectSidebar = page.locator(".project-sidebar");
    const nodeLibrary = projectSidebar.locator('[aria-label="Node library"]');
    await expect(nodeLibrary).toBeVisible();
    await expect(page.locator(".node-library-sidebar")).toHaveCount(0);
    await expect(page.getByText(/Show more|Show less/)).toHaveCount(0);

    const domainFolder = nodeLibrary.getByRole("button", { name: "Domain nodes" });
    await expect(domainFolder).toHaveAttribute("aria-expanded", "true");
    for (const label of ["Product", "Location", "Brand", "Campaign", "Audio"]) {
      await expect(
        nodeLibrary.getByRole("button", { name: `Add ${label} node` }),
      ).toBeVisible();
    }
    await domainFolder.click();
    await expect(domainFolder).toHaveAttribute("aria-expanded", "false");
    await expect(
      nodeLibrary.getByRole("button", { name: "Add Product node" }),
    ).toHaveCount(0);
    await expect(
      nodeLibrary.getByRole("button", { name: "Add Campaign node" }),
    ).toHaveCount(0);

    const workflowsFolder = nodeLibrary.getByRole("button", { name: "Video workflows" });
    await expect(workflowsFolder).toHaveAttribute("aria-expanded", "false");
    await workflowsFolder.click();
    await expect(workflowsFolder).toHaveAttribute("aria-expanded", "true");
    await expect(
      nodeLibrary.getByRole("button", { name: /Create .* flow/ }).first(),
    ).toBeVisible();
    for (const label of [
      "Storyboard sequence",
      "Product demo",
      "Lifestyle ad",
      "UGC testimonial",
      "Cinematic reveal",
      "Before / after",
      "Location establishing",
      "Brand bumper",
      "Voiceover / audio-led",
      "Transition shot",
      "Packshot / hero loop",
      "Fashion fit check",
      "Mirror selfie",
    ]) {
      await expect(
        nodeLibrary.getByRole("button", { name: `Create ${label} flow` }),
      ).toBeVisible();
    }
    for (const label of ["Unbox", "UGC review", "Skincare TVC", "Dance"]) {
      await expect(
        nodeLibrary.getByRole("button", { name: `Create ${label} flow` }),
      ).toHaveCount(0);
    }

    const sequenceFolder = nodeLibrary.getByRole("button", {
      name: "Storyboard sequence",
      exact: true,
    });
    await expect(sequenceFolder).toHaveAttribute("aria-expanded", "true");
    await expect(
      nodeLibrary.getByLabel("Sequence brief / Ý tưởng chuỗi cảnh"),
    ).toBeVisible();
    await sequenceFolder.click();
    await expect(sequenceFolder).toHaveAttribute("aria-expanded", "false");
    await expect(
      nodeLibrary.getByLabel("Sequence brief / Ý tưởng chuỗi cảnh"),
    ).toHaveCount(0);
  } finally {
    await request.delete(`/api/boards/${board.id}`);
  }
});
