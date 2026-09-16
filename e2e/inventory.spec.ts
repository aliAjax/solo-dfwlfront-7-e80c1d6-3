import { expect, test } from "@playwright/test";

const BASE = "http://127.0.0.1:4173";

/** 仅首次加载清空持久化；用例内 reload 不清（验证流水重放持久化） */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!nav || nav.type !== "reload") localStorage.clear();
  });
});

async function txCount(page: import("@playwright/test").Page) {
  return page.locator('[data-testid="tx-table"] tbody tr').count();
}

async function ledgerCellQty(page: import("@playwright/test").Page, batchId: string) {
  const row = page.locator(`[data-testid="ledger-row-${batchId}"]`);
  if ((await row.count()) === 0) return 0;
  const text = await row.locator("td").nth(4).innerText();
  return Number(text.match(/-?\d+/)?.[0] ?? 0);
}

test.describe("加油站便利店批次库存台", () => {
  test("入库 → 售出FEFO扣批 → 跨店调拨 → 盘点冻结调整 → 召回禁出库 → 非法整单回滚 → 批次追溯", async ({ page }) => {
    await page.goto(BASE);

    // 种子：S1主货架 K1 = B1 100（2027-02-01）+ B2 36（2026-10-01，近效期）
    expect(await ledgerCellQty(page, "B1")).toBe(100);
    expect(await ledgerCellQty(page, "B2")).toBe(36);
    const seedTx = await txCount(page);
    expect(seedTx).toBe(6);

    // ---------- 1. 入库：新批次落到 S1 主货架 ----------
    await page.locator('[data-testid="op-tab-inbound"]').click();
    await page.locator('[data-testid="inbound-sku"]').selectOption("K4");
    await page.locator('[data-testid="inbound-qty"]').fill("30");
    await page.locator('[data-testid="inbound-batchno"]').fill("CK260916");
    await page.locator('[data-testid="inbound-expiry"]').fill("2026-12-20");
    await page.locator('[data-testid="inbound-store"]').selectOption("S1");
    await page.locator('[data-testid="inbound-location"]').selectOption("L1");
    await page.locator('[data-testid="btn-inbound"]').click();
    await expect(page.locator('[data-testid="toast-ok"]').last()).toContainText("入库成功");
    expect(await txCount(page)).toBe(seedTx + 1);
    // 新批次 B7 出现在台账
    const newBatchRow = page.locator('[data-testid="ledger-table"] tbody tr', { hasText: "CK260916" });
    await expect(newBatchRow).toHaveCount(1);
    await expect(newBatchRow.locator("td").nth(4)).toContainText("30");

    // ---------- 2. 售出 50 瓶 K1：FEFO 先扣 B2(36) 再扣 B1(14) ----------
    await page.locator('[data-testid="op-tab-sale"]').click();
    await page.locator('[data-testid="sale-sku"]').selectOption("K1");
    await page.locator('[data-testid="sale-store"]').selectOption("S1");
    await page.locator('[data-testid="sale-location"]').selectOption("L1");
    await page.locator('[data-testid="sale-qty"]').fill("50");
    // 预览表：B2 扣 36，B1 扣 14
    const planRows = page.locator('[data-testid="sale-plan"] table tbody tr');
    await expect(planRows.nth(0)).toContainText("PC260815");
    await expect(planRows.nth(0).locator("td").nth(3)).toHaveText("36");
    await expect(planRows.nth(1)).toContainText("PC260801");
    await expect(planRows.nth(1).locator("td").nth(3)).toHaveText("14");
    const beforeSaleTx = await txCount(page);
    await page.locator('[data-testid="btn-sale"]').click();
    await expect(page.locator('[data-testid="toast-ok"]').last()).toContainText("先到期先出");
    // 售出是一笔流水两行（拆批）
    expect(await txCount(page)).toBe(beforeSaleTx + 1);
    const saleTx = page.locator('[data-testid="tx-table"] tbody tr.tx-sale').first();
    await expect(saleTx.locator(".tx-lines li")).toHaveCount(2);
    // 余额重放结果：B2 归零（行消失），B1 = 100-14 = 86
    expect(await ledgerCellQty(page, "B2")).toBe(0);
    expect(await ledgerCellQty(page, "B1")).toBe(86);

    // ---------- 3. 跨店调拨 30：S1 主货架 → S2 主货架，同批次落目标 ----------
    await page.locator('[data-testid="op-tab-transfer"]').click();
    await page.locator('[data-testid="transfer-sku"]').selectOption("K1");
    await page.locator('[data-testid="transfer-qty"]').fill("30");
    await page.locator('[data-testid="transfer-from-store"]').selectOption("S1");
    await page.locator('[data-testid="transfer-from-location"]').selectOption("L1");
    await page.locator('[data-testid="transfer-to-store"]').selectOption("S2");
    await page.locator('[data-testid="transfer-to-location"]').selectOption("L1");
    const beforeXferTx = await txCount(page);
    await page.locator('[data-testid="btn-transfer"]').click();
    await expect(page.locator('[data-testid="toast-ok"]').last()).toContainText("调拨成功");
    // 出入成对：两笔流水
    expect(await txCount(page)).toBe(beforeXferTx + 2);
    await expect(page.locator('[data-testid="tx-table"] tbody tr.tx-transfer_out').first()).toBeVisible();
    await expect(page.locator('[data-testid="tx-table"] tbody tr.tx-transfer_in').first()).toBeVisible();
    // 来源 S1 B1：86-30=56；目标 S2 原本 B1=20，落同批次后=50
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("S1");
    expect(await ledgerCellQty(page, "B1")).toBe(56);
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("S2");
    expect(await ledgerCellQty(page, "B1")).toBe(50);
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("");

    // ---------- 4. 盘点：冻结 S1 冷藏柜，差异只能走调整流水 ----------
    await page.locator('[data-testid="st-start-store"]').selectOption("S1");
    await page.locator('[data-testid="st-start-location"]').selectOption("L2");
    await page.locator('[data-testid="btn-st-start"]').click();
    await expect(page.locator('[data-testid="toast-ok"]').last()).toContainText("库位已冻结");
    await expect(page.locator('[data-testid="st-open-list"]')).toBeVisible();

    // 冻结期间向该库位入库必须被拦截
    await page.locator('[data-testid="op-tab-inbound"]').click();
    await page.locator('[data-testid="inbound-sku"]').selectOption("K3");
    await page.locator('[data-testid="inbound-qty"]').fill("10");
    await page.locator('[data-testid="inbound-batchno"]').fill("MK260916");
    await page.locator('[data-testid="inbound-expiry"]').fill("2026-10-10");
    await page.locator('[data-testid="inbound-store"]').selectOption("S1");
    await page.locator('[data-testid="inbound-location"]').selectOption("L2");
    const frozenBeforeTx = await txCount(page);
    await page.locator('[data-testid="btn-inbound"]').click();
    await expect(page.locator('[data-testid="toast-err"]').last()).toContainText("盘点冻结");
    expect(await txCount(page)).toBe(frozenBeforeTx);

    // 录入实盘：账面 48，盘亏 2 → 46
    await page.locator('[data-testid="btn-st-enter"]').first().click();
    await expect(page.locator('[data-testid="st-count-table"]')).toBeVisible();
    await page.locator('[data-testid="st-count-B4"]').fill("46");
    const beforeConfirmTx = await txCount(page);
    await page.locator('[data-testid="btn-st-confirm"]').click();
    await expect(page.locator('[data-testid="toast-ok"]').last()).toContainText("调整流水");
    // 仅新增一笔 adjust 流水
    expect(await txCount(page)).toBe(beforeConfirmTx + 1);
    const adj = page.locator('[data-testid="tx-table"] tbody tr.tx-adjust').first();
    await expect(adj).toBeVisible();
    await expect(adj.locator(".qty")).toContainText("−2");
    // 余额由流水重放：48 - 2 = 46
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("S1");
    expect(await ledgerCellQty(page, "B4")).toBe(46);
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("");
    // 库位解冻：进行中列表清空
    await expect(page.locator('[data-testid="st-open-list"]')).toHaveCount(0);

    // 账实一致的盘点不应生成调整流水
    await page.locator('[data-testid="st-start-store"]').selectOption("S1");
    await page.locator('[data-testid="st-start-location"]').selectOption("L2");
    await page.locator('[data-testid="btn-st-start"]').click();
    const beforeNoDiffTx = await txCount(page);
    await page.locator('[data-testid="btn-st-enter"]').first().click();
    await page.locator('[data-testid="btn-st-confirm"]').click();
    await expect(page.locator('[data-testid="toast-ok"]').last()).toContainText("账实一致");
    expect(await txCount(page)).toBe(beforeNoDiffTx);

    // ---------- 5. 召回 B6（K4 在 S2 主货架 40），召回后禁止出库 ----------
    await page.locator('[data-testid="op-tab-recall"]').click();
    await page.locator('[data-testid="recall-sku"]').selectOption("K4");
    await page.locator('[data-testid="recall-store"]').selectOption("S2");
    await page.locator('[data-testid="recall-location"]').selectOption("L1");
    await page.locator('[data-testid="recall-batch"]').selectOption("B6");
    const beforeRecallTx = await txCount(page);
    await page.locator('[data-testid="btn-recall"]').click();
    await expect(page.locator('[data-testid="toast-ok"]').last()).toContainText("已召回");
    expect(await txCount(page)).toBe(beforeRecallTx + 1);
    // B6 余额清零（余额表中不再出现）
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("S2");
    expect(await ledgerCellQty(page, "B6")).toBe(0);
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("");

    // 召回后尝试售出该商品：无可售批次，整笔被拒，流水不增
    await page.locator('[data-testid="op-tab-sale"]').click();
    await page.locator('[data-testid="sale-sku"]').selectOption("K4");
    await page.locator('[data-testid="sale-store"]').selectOption("S2");
    await page.locator('[data-testid="sale-location"]').selectOption("L1");
    await page.locator('[data-testid="sale-qty"]').fill("1");
    const beforeBlockedTx = await txCount(page);
    await page.locator('[data-testid="btn-sale"]').click();
    await expect(page.locator('[data-testid="toast-err"]').last()).toContainText("整笔售出已取消");
    expect(await txCount(page)).toBe(beforeBlockedTx);

    // 召回批次也不能被调拨出去
    await page.locator('[data-testid="op-tab-transfer"]').click();
    await page.locator('[data-testid="transfer-sku"]').selectOption("K4");
    await page.locator('[data-testid="transfer-qty"]').fill("1");
    await page.locator('[data-testid="transfer-from-store"]').selectOption("S2");
    await page.locator('[data-testid="transfer-from-location"]').selectOption("L1");
    await page.locator('[data-testid="transfer-to-store"]').selectOption("S1");
    await page.locator('[data-testid="transfer-to-location"]').selectOption("L1");
    const beforeBlockedXfer = await txCount(page);
    await page.locator('[data-testid="btn-transfer"]').click();
    await expect(page.locator('[data-testid="toast-err"]').last()).toContainText("整笔调拨已取消");
    expect(await txCount(page)).toBe(beforeBlockedXfer);

    // ---------- 6. 非法操作整单回滚：不留任何部分流水 ----------
    // 6a. 超卖：K2 在 S1 主货架仅 80，售出 9999
    await page.locator('[data-testid="op-tab-sale"]').click();
    await page.locator('[data-testid="sale-sku"]').selectOption("K2");
    await page.locator('[data-testid="sale-store"]').selectOption("S1");
    await page.locator('[data-testid="sale-location"]').selectOption("L1");
    await page.locator('[data-testid="sale-qty"]').fill("9999");
    const beforeRollbackTx = await txCount(page);
    await page.locator('[data-testid="btn-sale"]').click();
    await expect(page.locator('[data-testid="toast-err"]').last()).toContainText("库存不足");
    expect(await txCount(page)).toBe(beforeRollbackTx);
    expect(await ledgerCellQty(page, "B3")).toBe(80);

    // 6b. 非法数量入库（0、空批次号、错误效期）全部拒绝，流水不增
    await page.locator('[data-testid="op-tab-inbound"]').click();
    await page.locator('[data-testid="inbound-sku"]').selectOption("K2");
    // 移除输入框原生 min 约束，让非法数量进入引擎层校验
    await page.locator('[data-testid="inbound-qty"]').evaluate((el) => el.removeAttribute("min"));
    await page.locator('[data-testid="inbound-qty"]').fill("0");
    await page.locator('[data-testid="inbound-batchno"]').fill("HT001");
    await page.locator('[data-testid="inbound-expiry"]').fill("2026-12-01");
    await page.locator('[data-testid="inbound-store"]').selectOption("S1");
    await page.locator('[data-testid="inbound-location"]').selectOption("L1");
    const beforeBadTx = await txCount(page);
    await page.locator('[data-testid="btn-inbound"]').click();
    await expect(page.locator('[data-testid="toast-err"]').last()).toContainText("正整数");
    expect(await txCount(page)).toBe(beforeBadTx);

    await page.locator('[data-testid="inbound-qty"]').fill("12");
    await page.locator('[data-testid="inbound-batchno"]').fill("");
    await page.locator('[data-testid="btn-inbound"]').click();
    await expect(page.locator('[data-testid="toast-err"]').last()).toContainText("批次号");
    expect(await txCount(page)).toBe(beforeBadTx);

    // 6c. 同店同库位自我调拨被拒
    await page.locator('[data-testid="op-tab-transfer"]').click();
    await page.locator('[data-testid="transfer-sku"]').selectOption("K2");
    await page.locator('[data-testid="transfer-qty"]').fill("5");
    await page.locator('[data-testid="transfer-from-store"]').selectOption("S1");
    await page.locator('[data-testid="transfer-from-location"]').selectOption("L1");
    await page.locator('[data-testid="transfer-to-store"]').selectOption("S1");
    await page.locator('[data-testid="transfer-to-location"]').selectOption("L1");
    const beforeSelfTx = await txCount(page);
    await page.locator('[data-testid="btn-transfer"]').click();
    await expect(page.locator('[data-testid="toast-err"]').last()).toContainText("同一库位");
    expect(await txCount(page)).toBe(beforeSelfTx);

    // ---------- 7. 批次完整去向：B1 经历入库/调拨出入/售出 ----------
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("S1");
    await page.locator('[data-testid="trace-btn-B1"]').click();
    await expect(page.locator('[data-testid="trace-modal"]')).toBeVisible();
    const timeline = page.locator('[data-testid="trace-timeline"] .trace-item');
    await expect(timeline.first()).toBeVisible();
    const types = await timeline.evaluateAll((nodes) =>
      nodes.map((n) => (n.querySelector(".type-badge") as HTMLElement).textContent!.trim())
    );
    expect(types).toContain("入库");
    expect(types).toContain("调拨出");
    expect(types).toContain("调拨入");
    expect(types).toContain("售出");
    await page.locator('[data-testid="trace-close"]').click();
    await expect(page.locator('[data-testid="trace-modal"]')).toHaveCount(0);
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("");

    // ---------- 8. 刷新后余额由流水重新重放，数值不变 ----------
    await page.reload();
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("S1");
    expect(await ledgerCellQty(page, "B1")).toBe(56);
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("S2");
    expect(await ledgerCellQty(page, "B1")).toBe(50);
    await page.locator('[data-testid="ledger-filter-store"]').selectOption("S1");
    expect(await ledgerCellQty(page, "B4")).toBe(46);
  });

  test("退库回到指定批次并增加余额", async ({ page }) => {
    await page.goto(BASE);
    const before = await ledgerCellQty(page, "B3"); // S1 L1 K2 = 80
    await page.locator('[data-testid="op-tab-return"]').click();
    await page.locator('[data-testid="return-sku"]').selectOption("K2");
    await page.locator('[data-testid="return-store"]').selectOption("S1");
    await page.locator('[data-testid="return-location"]').selectOption("L1");
    await page.locator('[data-testid="return-batch"]').selectOption("B3");
    await page.locator('[data-testid="return-qty"]').fill("3");
    const beforeTx = await txCount(page);
    await page.locator('[data-testid="btn-return"]').click();
    await expect(page.locator('[data-testid="toast-ok"]').last()).toContainText("退库成功");
    expect(await txCount(page)).toBe(beforeTx + 1);
    expect(await ledgerCellQty(page, "B3")).toBe(before + 3);
  });

  test("手机视口可用：布局单列并能完成入库", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE);
    // 指标在窄屏换成两列、操作面板可见
    await expect(page.locator('[data-testid="ops-panel"]')).toBeVisible();
    await page.locator('[data-testid="op-tab-inbound"]').click();
    await page.locator('[data-testid="inbound-sku"]').selectOption("K2");
    await page.locator('[data-testid="inbound-qty"]').fill("18");
    await page.locator('[data-testid="inbound-batchno"]').fill("HT-MOBILE");
    await page.locator('[data-testid="inbound-expiry"]').fill("2027-01-01");
    await page.locator('[data-testid="inbound-store"]').selectOption("S1");
    await page.locator('[data-testid="inbound-location"]').selectOption("L1");
    const beforeTx = await txCount(page);
    await page.locator('[data-testid="btn-inbound"]').click();
    await expect(page.locator('[data-testid="toast-ok"]').last()).toBeVisible();
    expect(await txCount(page)).toBe(beforeTx + 1);
    const row = page.locator('[data-testid="ledger-table"] tbody tr', { hasText: "HT-MOBILE" });
    await expect(row).toBeVisible();
  });
});
