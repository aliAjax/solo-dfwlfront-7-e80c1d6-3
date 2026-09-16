import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  batchBalances,
  batchTrace,
  freezeKey,
  InventoryError,
  Ledger,
  replay,
  type BatchBalance
} from "../inventory/engine";
import { SKUS, STORES, seedStocktakes, seedTransactions } from "../inventory/seed";
import type { Stocktake, Transaction, TxLine, TxType } from "../inventory/types";

const STORAGE_KEY = "gas-station-batch-inventory-v1";

interface PersistShape {
  transactions: Transaction[];
  stocktakes: Stocktake[];
}

function load(): PersistShape {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.transactions)) return parsed;
    } catch {
      // 落盘损坏时回退种子
    }
  }
  return { transactions: seedTransactions(), stocktakes: seedStocktakes() };
}

let serial = 0;
function nextId(prefix: string) {
  serial += 1;
  return `${prefix}${Date.now().toString(36)}${serial.toString(36)}`;
}

export const useInventoryStore = defineStore("inventory", () => {
  const initial = load();
  const transactions = ref<Transaction[]>(initial.transactions);
  const stocktakes = ref<Stocktake[]>(initial.stocktakes);

  // -- 只读投影：全部由不可变流水重放得出 ----------------------------------
  const state = computed(() => replay(transactions.value));
  const balances = computed<BatchBalance[]>(() => batchBalances(state.value));

  const openStocktakes = computed(() => stocktakes.value.filter((s) => s.status === "open"));
  const frozenKeys = computed(
    () => new Set(openStocktakes.value.map((s) => freezeKey(s.storeId, s.locationId)))
  );

  function persist() {
    const payload: PersistShape = {
      transactions: transactions.value,
      stocktakes: stocktakes.value
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function isFrozen(storeId: string, locationId: string) {
    return frozenKeys.value.has(freezeKey(storeId, locationId));
  }

  /**
   * 在「从已提交流水重放的全新账本」上试算一笔操作。
   * ledger 内部余额在试算中途可能已被改写，但只有不抛错时才把产出的
   * 流水追加进 store；一旦抛错，ledger 直接丢弃 —— 已提交流水一行都不会多。
   */
  function trial(run: (ledger: Ledger) => { type: TxType; lines: TxLine[] }[]) {
    const ledger = new Ledger(STORES, SKUS, new Set(frozenKeys.value));
    ledger.load(transactions.value);
    return run(ledger);
  }

  function commit(
    groups: { type: TxType; lines: TxLine[] }[],
    memo: string,
    refs?: Partial<Transaction>[]
  ): Transaction[] {
    const now = new Date().toISOString();
    const created: Transaction[] = groups.map((g, i) => ({
      id: nextId("T"),
      type: g.type,
      at: now,
      memo,
      lines: g.lines,
      ...(refs?.[i] ?? {})
    }));
    transactions.value = [...transactions.value, ...created];
    persist();
    return created;
  }

  // -- 业务操作 -------------------------------------------------------------

  function inbound(input: {
    skuId: string;
    batchNo: string;
    expiry: string;
    qty: number;
    storeId: string;
    locationId: string;
    memo?: string;
  }) {
    const memo = input.memo?.trim() || "入库";
    const groups = trial((l) => [l.inbound({ ...input, memo })]);
    return commit(groups, memo);
  }

  function sale(input: {
    skuId: string;
    qty: number;
    storeId: string;
    locationId: string;
    memo?: string;
  }) {
    const memo = input.memo?.trim() || "门店零售";
    const groups = trial((l) => [l.sale({ ...input, memo })]);
    return commit(groups, memo);
  }

  function returnGoods(input: {
    skuId: string;
    batchId: string;
    qty: number;
    storeId: string;
    locationId: string;
    memo?: string;
  }) {
    const memo = input.memo?.trim() || "顾客退库";
    const groups = trial((l) => [l.return({ ...input, memo })]);
    return commit(groups, memo);
  }

  function transfer(input: {
    skuId: string;
    qty: number;
    from: { storeId: string; locationId: string };
    to: { storeId: string; locationId: string };
    memo?: string;
  }) {
    const memo = input.memo?.trim() || "跨店调拨";
    // 出入成对：先在同一 ledger 上完整试算两端，成功才生成一对带互相指向的流水
    const result = trial((l) => {
      const r = l.transfer({ ...input, memo });
      return [r.out, r.in];
    });
    const ids = [nextId("T"), nextId("T")];
    const now = new Date().toISOString();
    const created: Transaction[] = [
      { id: ids[0], type: result[0].type, at: now, memo, lines: result[0].lines, refTxId: ids[1] },
      { id: ids[1], type: result[1].type, at: now, memo, lines: result[1].lines, refTxId: ids[0] }
    ];
    transactions.value = [...transactions.value, ...created];
    persist();
    return created;
  }

  function recall(input: {
    skuId: string;
    batchId: string;
    storeId: string;
    locationId: string;
    memo?: string;
  }) {
    const memo = input.memo?.trim() || "批次召回";
    const groups = trial((l) => [l.recall({ ...input, memo })]);
    return commit(groups, memo);
  }

  // -- 盘点 -----------------------------------------------------------------

  function startStocktake(input: { storeId: string; locationId: string; memo?: string }) {
    if (isFrozen(input.storeId, input.locationId)) {
      throw new InventoryError("该库位已有进行中的盘点，已处于冻结状态");
    }
    const st: Stocktake = {
      id: nextId("ST"),
      storeId: input.storeId,
      locationId: input.locationId,
      startedAt: new Date().toISOString(),
      status: "open",
      counted: {},
      memo: input.memo?.trim() || "周期盘点"
    };
    stocktakes.value = [...stocktakes.value, st];
    persist();
    return st;
  }

  function saveCount(stocktakeId: string, counted: Record<string, number>) {
    const st = stocktakes.value.find((x) => x.id === stocktakeId);
    if (!st || st.status !== "open") throw new InventoryError("盘点单不存在或已结束");
    st.counted = { ...counted };
    persist();
  }

  function confirmStocktake(
    stocktakeId: string,
    counted: { skuId: string; batchId: string; qty: number }[]
  ) {
    const st = stocktakes.value.find((x) => x.id === stocktakeId);
    if (!st || st.status !== "open") throw new InventoryError("盘点单不存在或已结束");

    const groups = trial((l) => [
      l.stocktakeAdjust({
        storeId: st.storeId,
        locationId: st.locationId,
        counted
      })
    ]);

    let adjustTx: Transaction | undefined;
    if (groups[0].lines.length > 0) {
      // 差异确认后只能生成库存调整流水，绝不直接改余额
      adjustTx = {
        id: nextId("T"),
        type: "adjust",
        at: new Date().toISOString(),
        memo: `盘点差异调整：${st.memo}`,
        lines: groups[0].lines,
        stocktakeId: st.id
      };
      transactions.value = [...transactions.value, adjustTx];
    }

    st.status = "confirmed";
    st.finishedAt = new Date().toISOString();
    st.counted = Object.fromEntries(counted.map((c) => [`${c.skuId}|${c.batchId}`, c.qty]));
    st.adjustTxId = adjustTx?.id;
    persist();
    return { stocktake: st, adjustTx };
  }

  function cancelStocktake(stocktakeId: string) {
    const st = stocktakes.value.find((x) => x.id === stocktakeId);
    if (!st || st.status !== "open") throw new InventoryError("盘点单不存在或已结束");
    st.status = "cancelled";
    st.finishedAt = new Date().toISOString();
    persist();
  }

  // -- 查询 -----------------------------------------------------------------

  function balancesAt(storeId: string, locationId: string) {
    return balances.value.filter((b) => b.storeId === storeId && b.locationId === locationId);
  }

  function trace(batchId: string) {
    return batchTrace(transactions.value, batchId);
  }

  function resetDemo() {
    transactions.value = seedTransactions();
    stocktakes.value = seedStocktakes();
    persist();
  }

  return {
    // state
    transactions,
    stocktakes,
    skus: SKUS,
    stores: STORES,
    // getters
    balances,
    state,
    openStocktakes,
    frozenKeys,
    // actions
    isFrozen,
    inbound,
    sale,
    returnGoods,
    transfer,
    recall,
    startStocktake,
    saveCount,
    confirmStocktake,
    cancelStocktake,
    balancesAt,
    trace,
    resetDemo
  };
});
