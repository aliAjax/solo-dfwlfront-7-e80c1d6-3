// 不可变流水引擎：
// - 余额 = 按序重放全部流水得到的投影，任何地方都不直接改余额；
// - 每笔业务先在「暂存投影」上完整校验、试算，全部成功才落库生成流水，
//   任一行数量/批次/库位不合法则抛错，整笔不留任何流水；
// - 售出按先到期先出（FEFO）自动拆批扣减；
// - 跨店调拨成对生成 transfer_out / transfer_in，同批批次号、效期落到目标店；
// - 召回后的批次（recalled 集合）禁止一切出库；
// - 盘点差异只能生成 adjust 流水。

import type {
  BatchMeta,
  Stocktake,
  Store,
  Transaction,
  TxLine,
  TxType
} from "./types";

export class InventoryError extends Error {}

type Pos = { storeId: string; locationId: string };

const posKey = (p: Pos) => `${p.storeId}|${p.locationId}`;
const balKey = (b: { skuId: string; batchId: string; storeId: string; locationId: string }) =>
  `${b.skuId}|${b.batchId}|${b.storeId}|${b.locationId}`;

export interface SkuMeta {
  id: string;
  name: string;
  unit: string;
}

export interface ReplayState {
  /** skuId|batchId|storeId|locationId -> 余额 */
  balances: Map<string, number>;
  batches: Map<string, BatchMeta>;
  /** 被召回的批次 id 集合（召回后该批次在全店禁出库） */
  recalled: Set<string>;
}

export function replay(txs: Transaction[]): ReplayState {
  const balances = new Map<string, number>();
  const batches = new Map<string, BatchMeta>();
  const recalled = new Set<string>();

  txs.forEach((tx, seq) => {
    for (const line of tx.lines) {
      const key = balKey(line);
      const prev = balances.get(key) ?? 0;
      const sign = signOf(tx.type);
      balances.set(key, prev + sign * line.qty);

      if (tx.type === "recall") recalled.add(line.batchId);

      if (!batches.has(line.batchId)) {
        batches.set(line.batchId, {
          id: line.batchId,
          skuId: line.skuId,
          batchNo: line.batchNo,
          expiry: line.expiry,
          firstSeq: seq
        });
      }
    }
  });

  return { balances, batches, recalled };
}

/** 各流水类型对余额的方向 */
function signOf(type: TxType): 1 | -1 {
  switch (type) {
    case "inbound":
    case "return":
    case "transfer_in":
      return 1;
    case "sale":
    case "transfer_out":
    case "recall":
      return -1;
    case "adjust":
      return 1; // adjust 的 qty 本身带符号
  }
}

// ---------------------------------------------------------------------------
// 可变暂存投影：业务事务在它上面试算，commit 时才产出不可变 Transaction
// ---------------------------------------------------------------------------

export class Ledger {
  private balances = new Map<string, number>();
  private batches = new Map<string, BatchMeta>();
  private recalled = new Set<string>();
  private seq = 0;

  /** 当前冻结库位集合（进行中的盘点）；盘点冻结期间库位禁止任何库存移动 */
  constructor(
    private stores: Store[],
    private skus: SkuMeta[],
    private frozen: Set<string> = new Set()
  ) {}

  load(txs: Transaction[]) {
    const state = replay(txs);
    this.balances = state.balances;
    this.batches = state.batches;
    this.recalled = state.recalled;
    this.seq = txs.length;
  }

  private assertStore(p: Pos) {
    const store = this.stores.find((s) => s.id === p.storeId);
    if (!store) throw new InventoryError(`门店不存在：${p.storeId}`);
    if (!store.locations.some((l) => l.id === p.locationId)) {
      throw new InventoryError(`库位不属于门店「${store.name}」：${p.locationId}`);
    }
  }

  private assertSku(skuId: string) {
    if (!this.skus.some((s) => s.id === skuId)) {
      throw new InventoryError(`商品不存在：${skuId}`);
    }
  }

  private assertQty(qty: number) {
    if (!Number.isFinite(qty) || qty <= 0 || Math.floor(qty) !== qty) {
      throw new InventoryError(`数量必须是正整数，收到：${qty}`);
    }
  }

  private assertUnfrozen(p: Pos) {
    if (this.frozen.has(posKey(p))) {
      throw new InventoryError(`库位正在盘点冻结中，禁止移动库存：${p.locationId}`);
    }
  }

  private balanceOf(skuId: string, batchId: string, p: Pos): number {
    return this.balances.get(balKey({ skuId, batchId, ...p })) ?? 0;
  }

  private apply(line: TxLine, type: TxType) {
    const key = balKey(line);
    const next = (this.balances.get(key) ?? 0) + signOf(type) * line.qty;
    if (next < 0) {
      throw new InventoryError(
        `批次 ${line.batchNo} 在库位 ${line.locationId} 可用库存不足（需要 ${line.qty}，结余 ${this.balances.get(key) ?? 0}）`
      );
    }
    this.balances.set(key, next);
    if (type === "recall") this.recalled.add(line.batchId);
    if (!this.batches.has(line.batchId)) {
      this.batches.set(line.batchId, {
        id: line.batchId,
        skuId: line.skuId,
        batchNo: line.batchNo,
        expiry: line.expiry,
        firstSeq: this.seq
      });
    }
  }

  private assertNotRecalled(batchId: string) {
    if (this.recalled.has(batchId)) {
      throw new InventoryError(`批次已被召回，禁止继续出库：${this.batches.get(batchId)?.batchNo ?? batchId}`);
    }
  }

  /** 入库：同一商品可以新建批次（批次号 + 效期）。 */
  inbound(
    args: {
      skuId: string;
      batchNo: string;
      expiry: string;
      qty: number;
      memo?: string;
    } & Pos
  ): { type: TxType; lines: TxLine[] } {
    this.assertSku(args.skuId);
    this.assertStore(args);
    this.assertUnfrozen(args);
    this.assertQty(args.qty);
    if (!args.batchNo?.trim()) throw new InventoryError("批次号不能为空");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.expiry)) {
      throw new InventoryError("效期格式应为 YYYY-MM-DD");
    }
    const batchId = this.ensureBatchId(args.skuId, args.batchNo, args.expiry);
    const line: TxLine = {
      skuId: args.skuId,
      batchId,
      batchNo: args.batchNo.trim(),
      expiry: args.expiry,
      storeId: args.storeId,
      locationId: args.locationId,
      qty: args.qty
    };
    this.apply(line, "inbound");
    return { type: "inbound", lines: [line] };
  }

  /**
   * 售出：FEFO 自动扣批。
   * 传入要扣的批次候选（默认该店该商品全部在库批次），按效期升序、
   * 同效期按先入库顺序，逐批扣到满足总量；库存不够或候选含召回批次则整笔失败。
   */
  sale(
    args: { skuId: string; qty: number; batchIds?: string[]; memo?: string } & Pos
  ): { type: TxType; lines: TxLine[] } {
    this.assertSku(args.skuId);
    this.assertStore(args);
    this.assertUnfrozen(args);
    this.assertQty(args.qty);

    const explicit = Array.isArray(args.batchIds);
    const candidates = [...this.batches.values()]
      .filter((b) => b.skuId === args.skuId)
      .filter((b) => (explicit ? args.batchIds!.includes(b.id) : true))
      .map((b) => ({
        b,
        qty: this.balanceOf(args.skuId, b.id, { storeId: args.storeId, locationId: args.locationId })
      }))
      .filter((x) => x.qty > 0)
      .sort((x, y) =>
        x.b.expiry < y.b.expiry ? -1 : x.b.expiry > y.b.expiry ? 1 : x.b.firstSeq - y.b.firstSeq
      );

    // 已召回批次不是可售库存：显式指定它出库必须拒绝，自动 FEFO 时直接剔除
    for (const c of candidates) {
      if (this.recalled.has(c.b.id)) {
        if (explicit) this.assertNotRecalled(c.b.id);
      }
    }
    const sellable = candidates.filter((c) => !this.recalled.has(c.b.id));

    const available = sellable.reduce((acc, c) => acc + c.qty, 0);
    if (available < args.qty) {
      throw new InventoryError(
        `商品在该库位可售库存不足（需要 ${args.qty}，可用 ${available}），整笔售出已取消`
      );
    }

    let remaining = args.qty;
    const lines: TxLine[] = [];
    for (const c of sellable) {
      if (remaining <= 0) break;
      const take = Math.min(c.qty, remaining);
      const line: TxLine = {
        skuId: args.skuId,
        batchId: c.b.id,
        batchNo: c.b.batchNo,
        expiry: c.b.expiry,
        storeId: args.storeId,
        locationId: args.locationId,
        qty: take
      };
      this.apply(line, "sale");
      lines.push(line);
      remaining -= take;
    }
    return { type: "sale", lines };
  }

  /** 退库：顾客退回的商品按指定批次回货架（召回批次不可退入销售货架）。 */
  return(
    args: { skuId: string; batchId: string; qty: number; memo?: string } & Pos
  ): { type: TxType; lines: TxLine[] } {
    this.assertSku(args.skuId);
    this.assertStore(args);
    this.assertUnfrozen(args);
    this.assertQty(args.qty);
    const meta = this.batches.get(args.batchId);
    if (!meta || meta.skuId !== args.skuId) throw new InventoryError("退库批次不存在或与商品不符");
    if (this.recalled.has(args.batchId)) {
      // 召回批次的退回应走召回/报损流程，不能重新进入可售库存
      throw new InventoryError(`召回批次不可退库回货架：${meta.batchNo}`);
    }
    const line: TxLine = {
      skuId: args.skuId,
      batchId: meta.id,
      batchNo: meta.batchNo,
      expiry: meta.expiry,
      storeId: args.storeId,
      locationId: args.locationId,
      qty: args.qty
    };
    this.apply(line, "return");
    return { type: "return", lines: [line] };
  }

  /**
   * 跨店调拨：从来源库位按 FEFO 扣批，同时在目标库位按相同批次号/效期落账。
   * 返回成对的两组行；任一端校验失败整笔取消。
   */
  transfer(
    args: {
      skuId: string;
      qty: number;
      from: Pos;
      to: Pos;
      memo?: string;
    }
  ): { out: { type: TxType; lines: TxLine[] }; in: { type: TxType; lines: TxLine[] } } {
    this.assertSku(args.skuId);
    this.assertStore(args.from);
    this.assertStore(args.to);
    this.assertUnfrozen(args.from);
    this.assertUnfrozen(args.to);
    if (args.from.storeId === args.to.storeId && args.from.locationId === args.to.locationId) {
      throw new InventoryError("调拨来源与目标不能是同一库位");
    }
    this.assertQty(args.qty);

    const candidates = [...this.batches.values()]
      .filter((b) => b.skuId === args.skuId)
      .map((b) => ({ b, qty: this.balanceOf(args.skuId, b.id, args.from) }))
      .filter((x) => x.qty > 0 && !this.recalled.has(x.b.id))
      .sort((x, y) =>
        x.b.expiry < y.b.expiry ? -1 : x.b.expiry > y.b.expiry ? 1 : x.b.firstSeq - y.b.firstSeq
      );

    const available = candidates.reduce((acc, c) => acc + c.qty, 0);
    if (available < args.qty) {
      throw new InventoryError(
        `来源库位可调拨库存不足（需要 ${args.qty}，可用 ${available}），整笔调拨已取消`
      );
    }

    let remaining = args.qty;
    const outLines: TxLine[] = [];
    const inLines: TxLine[] = [];
    for (const c of candidates) {
      if (remaining <= 0) break;
      const take = Math.min(c.qty, remaining);
      outLines.push({
        skuId: args.skuId,
        batchId: c.b.id,
        batchNo: c.b.batchNo,
        expiry: c.b.expiry,
        storeId: args.from.storeId,
        locationId: args.from.locationId,
        qty: take
      });
      inLines.push({
        skuId: args.skuId,
        batchId: c.b.id, // 同一批次跨店流转，批次身份不变
        batchNo: c.b.batchNo,
        expiry: c.b.expiry,
        storeId: args.to.storeId,
        locationId: args.to.locationId,
        qty: take
      });
      remaining -= take;
    }
    // 先试扣来源，再试落目标，任何一行失败都会抛错，调用方整笔丢弃
    for (const l of outLines) this.apply(l, "transfer_out");
    for (const l of inLines) this.apply(l, "transfer_in");
    return {
      out: { type: "transfer_out", lines: outLines },
      in: { type: "transfer_in", lines: inLines }
    };
  }

  /** 召回：整批次在指定库位的全部余额扣减；召回后全店禁出库。召回在盘点冻结期间仍允许执行。 */
  recall(
    args: { skuId: string; batchId: string; memo?: string } & Pos
  ): { type: TxType; lines: TxLine[] } {
    this.assertSku(args.skuId);
    this.assertStore(args);
    const meta = this.batches.get(args.batchId);
    if (!meta || meta.skuId !== args.skuId) throw new InventoryError("召回批次不存在");
    this.assertNotRecalled(meta.id);
    const qty = this.balanceOf(args.skuId, meta.id, args);
    if (qty <= 0) throw new InventoryError(`批次 ${meta.batchNo} 在该库位无库存，无需召回`);
    const line: TxLine = {
      skuId: args.skuId,
      batchId: meta.id,
      batchNo: meta.batchNo,
      expiry: meta.expiry,
      storeId: args.storeId,
      locationId: args.locationId,
      qty
    };
    this.apply(line, "recall");
    return { type: "recall", lines: [line] };
  }

  /**
   * 盘点确认：把实盘数与重放余额逐一比对，差异生成带符号 adjust 流水。
   * 不允许直接改余额；盘盈为正、盘亏为负。
   * 试算阶段若出现负库存差额以外的非法情况（如未知批次）同样整笔失败。
   */
  stocktakeAdjust(
    args: {
      storeId: string;
      locationId: string;
      counted: { skuId: string; batchId: string; qty: number }[];
    }
  ): { type: TxType; lines: TxLine[] } {
    this.assertStore({ storeId: args.storeId, locationId: args.locationId });
    const lines: TxLine[] = [];
    const seen = new Set<string>();

    // 实盘条目：与系统余额比对
    for (const c of args.counted) {
      this.assertSku(c.skuId);
      if (!Number.isFinite(c.qty) || c.qty < 0 || Math.floor(c.qty) !== c.qty) {
        throw new InventoryError(`实盘数量必须是非负整数，收到：${c.qty}`);
      }
      const meta = this.batches.get(c.batchId);
      if (!meta || meta.skuId !== c.skuId) throw new InventoryError("盘点批次不存在或与商品不符");
      const k = `${c.skuId}|${c.batchId}`;
      if (seen.has(k)) throw new InventoryError(`同一批次重复盘点：${meta.batchNo}`);
      seen.add(k);
      const onHand = this.balanceOf(c.skuId, c.batchId, {
        storeId: args.storeId,
        locationId: args.locationId
      });
      const delta = c.qty - onHand;
      if (delta === 0) continue;
      // 召回批次也不允许通过盘点把库存盘回来
      if (delta > 0 && this.recalled.has(c.batchId)) {
        throw new InventoryError(`召回批次不可盘盈回库：${meta.batchNo}`);
      }
      lines.push({
        skuId: c.skuId,
        batchId: c.batchId,
        batchNo: meta.batchNo,
        expiry: meta.expiry,
        storeId: args.storeId,
        locationId: args.locationId,
        qty: delta
      });
    }

    // 系统有余额但未盘点到的批次，视为盘亏 0？——为避免漏盘被静默清零，
    // 要求冻结库位内全部在库批次都必须出现在盘点表里。
    for (const [key, qty] of this.balances) {
      const [skuId, batchId, storeId, locationId] = key.split("|");
      if (storeId !== args.storeId || locationId !== args.locationId || qty <= 0) continue;
      if (!seen.has(`${skuId}|${batchId}`)) {
        const meta = this.batches.get(batchId)!;
        throw new InventoryError(`批次 ${meta.batchNo} 未列入盘点，库位内所有批次必须全盘后才能确认`);
      }
    }

    for (const l of lines) this.apply(l, "adjust");
    return { type: "adjust", lines };
  }

  /** 找或建批次身份：同商品下「批次号 + 效期」视为同一批次。 */
  private ensureBatchId(skuId: string, batchNo: string, expiry: string): string {
    const existing = [...this.batches.values()].find(
      (b) => b.skuId === skuId && b.batchNo === batchNo && b.expiry === expiry
    );
    if (existing) return existing.id;
    let max = 0;
    for (const id of this.batches.keys()) {
      const n = Number(id.replace(/^B/, ""));
      if (Number.isFinite(n) && n > max) max = n;
    }
    const id = `B${max + 1}`;
    this.batches.set(id, { id, skuId, batchNo, expiry, firstSeq: this.seq });
    return id;
  }
}

// ---------------------------------------------------------------------------
// 只读查询辅助
// ---------------------------------------------------------------------------

export interface BatchBalance {
  skuId: string;
  batchId: string;
  batchNo: string;
  expiry: string;
  storeId: string;
  locationId: string;
  qty: number;
  recalled: boolean;
}

export function batchBalances(state: ReplayState): BatchBalance[] {
  const rows: BatchBalance[] = [];
  for (const [key, qty] of state.balances) {
    if (qty <= 0) continue;
    const [skuId, batchId, storeId, locationId] = key.split("|");
    const b = state.batches.get(batchId);
    rows.push({
      skuId,
      batchId,
      batchNo: b?.batchNo ?? batchId,
      expiry: b?.expiry ?? "",
      storeId,
      locationId,
      qty,
      recalled: state.recalled.has(batchId)
    });
  }
  return rows.sort((a, b2) =>
    a.storeId < b2.storeId ? -1 : a.storeId > b2.storeId ? 1
    : a.locationId < b2.locationId ? -1 : a.locationId > b2.locationId ? 1
    : a.expiry < b2.expiry ? -1 : a.expiry > b2.expiry ? 1
    : a.batchNo < b2.batchNo ? -1 : 1
  );
}

export function freezeKey(storeId: string, locationId: string) {
  return posKey({ storeId, locationId });
}

export interface FefoPlanItem {
  batchId: string;
  batchNo: string;
  expiry: string;
  onHand: number;
  take: number;
}

/**
 * 纯函数 FEFO 计划：给定某库位某商品的批次余额，返回售出/调拨应依次扣减的批次。
 * 已召回批次剔除；按效期升序、同效期按首次入库顺序。
 * 引擎扣批与 UI 预览共用同一逻辑。
 */
export function fefoPlan(
  rows: { batch: BatchMeta; qty: number }[],
  recalled: Set<string>,
  need: number
): { items: FefoPlanItem[]; available: number; enough: boolean } {
  const items0 = rows
    .filter((r) => r.qty > 0 && !recalled.has(r.batch.id))
    .sort((x, y) =>
      x.batch.expiry < y.batch.expiry
        ? -1
        : x.batch.expiry > y.batch.expiry
        ? 1
        : x.batch.firstSeq - y.batch.firstSeq
    );
  const available = items0.reduce((a, r) => a + r.qty, 0);
  let remaining = need;
  const items: FefoPlanItem[] = [];
  if (Number.isFinite(need) && need > 0) {
    for (const r of items0) {
      if (remaining <= 0) break;
      const take = Math.min(r.qty, remaining);
      items.push({
        batchId: r.batch.id,
        batchNo: r.batch.batchNo,
        expiry: r.batch.expiry,
        onHand: r.qty,
        take
      });
      remaining -= take;
    }
  }
  return { items, available, enough: available >= need };
}

/** 批次完整去向：所有涉及该批次的流水行 */
export function batchTrace(txs: Transaction[], batchId: string) {
  const out: { seq: number; tx: Transaction; line: TxLine }[] = [];
  txs.forEach((tx, seq) => {
    for (const line of tx.lines) {
      if (line.batchId === batchId) out.push({ seq, tx, line });
    }
  });
  return out;
}
