// 库存领域类型：一切余额都由「不可变流水」重放得出，批次/库位不另存余额。

export type TxType =
  | "inbound" // 入库
  | "sale" // 售出（FEFO 自动扣批）
  | "return" // 退库（顾客退货回货架）
  | "transfer_out" // 调拨出库
  | "transfer_in" // 调拨入库（与 transfer_out 成对）
  | "recall" // 召回（整批次全额扣减）
  | "adjust"; // 盘点调整（带符号差额）

export interface Sku {
  id: string;
  name: string;
  unit: string;
}

export interface StoreLocation {
  id: string;
  name: string;
}

export interface Store {
  id: string;
  name: string;
  locations: StoreLocation[];
}

/** 不可变流水的单行。数量恒为非负；adjust 的正负由 delta 表达。 */
export interface TxLine {
  skuId: string;
  batchId: string;
  batchNo: string;
  expiry: string; // YYYY-MM-DD
  storeId: string;
  locationId: string;
  qty: number; // adjust 时为带符号差额，其余类型恒为正
}

export interface Transaction {
  id: string;
  type: TxType;
  at: string; // ISO 时间
  memo: string;
  lines: TxLine[];
  /** 成对流水（调拨出入库互相指向） */
  refTxId?: string;
  /** 盘点调整归属的盘点单号 */
  stocktakeId?: string;
}

/** 批次主数据：重放过程中从入库/调拨入流水推导，不单独持久化 */
export interface BatchMeta {
  id: string;
  skuId: string;
  batchNo: string;
  expiry: string;
  firstSeq: number; // 首次出现的流水序号，FEFO 并列时做稳定排序
}

export interface Stocktake {
  id: string;
  storeId: string;
  locationId: string;
  startedAt: string;
  status: "open" | "confirmed" | "cancelled";
  /** 实盘数：键为 batchId */
  counted: Record<string, number>;
  finishedAt?: string;
  adjustTxId?: string;
  memo?: string;
}

export const TX_TYPE_LABEL: Record<TxType, string> = {
  inbound: "入库",
  sale: "售出",
  return: "退库",
  transfer_out: "调拨出",
  transfer_in: "调拨入",
  recall: "召回",
  adjust: "盘点调整"
};
