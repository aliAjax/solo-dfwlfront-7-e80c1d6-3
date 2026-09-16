// 种子主数据与期初流水：两店两库位、多商品多批次，覆盖跨店同批、近效期等场景。
import type { Sku, Stocktake, Store, Transaction } from "./types";

export const STORES: Store[] = [
  {
    id: "S1",
    name: "城东加油站便利店",
    locations: [
      { id: "L1", name: "主货架" },
      { id: "L2", name: "冷藏柜" }
    ]
  },
  {
    id: "S2",
    name: "城西加油站便利店",
    locations: [
      { id: "L1", name: "主货架" },
      { id: "L2", name: "冷藏柜" }
    ]
  }
];

export const SKUS: Sku[] = [
  { id: "K1", name: "矿泉水 550ml", unit: "瓶" },
  { id: "K2", name: "火腿肠", unit: "根" },
  { id: "K3", name: "盒装牛奶 250ml", unit: "盒" },
  { id: "K4", name: "苏打饼干", unit: "包" }
];

function iso(d: string, h: string) {
  return `${d}T${h}:00+08:00`;
}

// 期初流水均为合法历史（入库非负、扣减不超卖）。B1..B6 为固定批次身份。
export function seedTransactions(): Transaction[] {
  const mk = (
    id: string,
    type: Transaction["type"],
    at: string,
    memo: string,
    lines: Transaction["lines"],
    extra: Partial<Transaction> = {}
  ): Transaction => ({ id, type, at, memo, lines, ...extra });

  const line = (
    skuId: string,
    batchId: string,
    batchNo: string,
    expiry: string,
    storeId: string,
    locationId: string,
    qty: number
  ) => ({ skuId, batchId, batchNo, expiry, storeId, locationId, qty });

  return [
    mk("T01", "inbound", iso("2026-08-20", "09:12"), "月初配送入库", [
      line("K1", "B1", "PC260801", "2027-02-01", "S1", "L1", 120),
      line("K1", "B2", "PC260815", "2026-10-01", "S1", "L1", 60)
    ]),
    mk("T02", "inbound", iso("2026-08-22", "10:05"), "月初配送入库", [
      line("K2", "B3", "HT260820", "2026-12-15", "S1", "L1", 80),
      line("K3", "B4", "MK260818", "2026-09-25", "S1", "L2", 48)
    ]),
    mk("T03", "inbound", iso("2026-08-25", "14:40"), "城西店入库", [
      line("K1", "B5", "PC260820", "2027-01-15", "S2", "L1", 96),
      line("K4", "B6", "CK260810", "2026-11-30", "S2", "L1", 40)
    ]),
    // 跨店同批：B1 也调拨到城西
    mk("T04", "transfer_out", iso("2026-09-01", "11:20"), "城际调货支援城西", [
      line("K1", "B1", "PC260801", "2027-02-01", "S1", "L1", 20)
    ], { refTxId: "T05" }),
    mk("T05", "transfer_in", iso("2026-09-01", "11:20"), "城际调货支援城西", [
      line("K1", "B1", "PC260801", "2027-02-01", "S2", "L1", 20)
    ], { refTxId: "T04" }),
    // 已有售出：S1 主货架 K1 先扣近效期 B2（2026-10-01 早于 B1 的 2027-02-01）
    mk("T06", "sale", iso("2026-09-10", "18:02"), "门店零售", [
      line("K1", "B2", "PC260815", "2026-10-01", "S1", "L1", 24)
    ])
  ];
}

export function seedStocktakes(): Stocktake[] {
  return [];
}
