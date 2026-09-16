<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useInventoryStore } from "../stores/inventory";
import { InventoryError, fefoPlan } from "../inventory/engine";
import { useToast } from "../composables/useToast";
import { expiryState, skuUnit } from "../composables/labels";

const store = useInventoryStore();
const toast = useToast();

const tabs = [
  { key: "inbound", label: "入库" },
  { key: "sale", label: "售出" },
  { key: "return", label: "退库" },
  { key: "transfer", label: "跨店调拨" },
  { key: "recall", label: "召回" }
] as const;
type OpKey = (typeof tabs)[number]["key"];
const active = ref<OpKey>("inbound");

const stores = store.stores;
const skus = store.skus;
function locations(storeId: string) {
  return stores.find((s) => s.id === storeId)?.locations ?? [];
}

function run(action: () => unknown, okText: string) {
  try {
    action();
    toast.ok(okText);
    return true;
  } catch (e) {
    toast.err(e instanceof InventoryError ? e.message : `操作失败：${String(e)}`);
    return false;
  }
}

// ---- 入库 ----
const inboundForm = reactive({
  skuId: skus[0]?.id ?? "",
  batchNo: "",
  expiry: "",
  qty: 24,
  storeId: stores[0]?.id ?? "",
  locationId: stores[0]?.locations[0]?.id ?? "",
  memo: ""
});
function submitInbound() {
  run(
    () =>
      store.inbound({
        skuId: inboundForm.skuId,
        batchNo: inboundForm.batchNo.trim(),
        expiry: inboundForm.expiry,
        qty: Number(inboundForm.qty),
        storeId: inboundForm.storeId,
        locationId: inboundForm.locationId,
        memo: inboundForm.memo
      }),
    `入库成功：${inboundForm.qty}${skuUnit(inboundForm.skuId)} / 批次 ${inboundForm.batchNo}`
  );
}

// ---- 售出（FEFO 自动扣批） ----
const saleForm = reactive({
  skuId: skus[0]?.id ?? "",
  qty: 1,
  storeId: stores[0]?.id ?? "",
  locationId: stores[0]?.locations[0]?.id ?? "",
  memo: ""
});

const saleRows = computed(() =>
  store.balancesAt(saleForm.storeId, saleForm.locationId).filter((b) => b.skuId === saleForm.skuId)
);
const salePlan = computed(() =>
  fefoPlan(
    saleRows.value.map((b) => ({
      batch: store.state.batches.get(b.batchId)!,
      qty: b.qty
    })),
    store.state.recalled,
    Number(saleForm.qty) || 0
  )
);
const saleFrozen = computed(() => store.isFrozen(saleForm.storeId, saleForm.locationId));

function submitSale() {
  run(
    () =>
      store.sale({
        skuId: saleForm.skuId,
        qty: Number(saleForm.qty),
        storeId: saleForm.storeId,
        locationId: saleForm.locationId,
        memo: saleForm.memo
      }),
    `售出成功：${saleForm.qty}${skuUnit(saleForm.skuId)}，已按先到期先出自动扣批`
  );
}

// ---- 退库 ----
const returnForm = reactive({
  skuId: skus[0]?.id ?? "",
  batchId: "",
  qty: 1,
  storeId: stores[0]?.id ?? "",
  locationId: stores[0]?.locations[0]?.id ?? "",
  memo: ""
});
const returnBatches = computed(() =>
  store
    .balancesAt(returnForm.storeId, returnForm.locationId)
    .filter((b) => b.skuId === returnForm.skuId && !b.recalled)
);
function submitReturn() {
  run(
    () =>
      store.returnGoods({
        skuId: returnForm.skuId,
        batchId: returnForm.batchId,
        qty: Number(returnForm.qty),
        storeId: returnForm.storeId,
        locationId: returnForm.locationId,
        memo: returnForm.memo
      }),
    `退库成功：${returnForm.qty}${skuUnit(returnForm.skuId)} 已回批次 ${returnForm.batchId}`
  );
}

// ---- 跨店调拨 ----
const transferForm = reactive({
  skuId: skus[0]?.id ?? "",
  qty: 12,
  fromStoreId: stores[0]?.id ?? "",
  fromLocationId: stores[0]?.locations[0]?.id ?? "",
  toStoreId: stores[1]?.id ?? stores[0]?.id ?? "",
  toLocationId: stores[1]?.locations[0]?.id ?? stores[0]?.locations[0]?.id ?? "",
  memo: ""
});
const fromRows = computed(() =>
  store
    .balancesAt(transferForm.fromStoreId, transferForm.fromLocationId)
    .filter((b) => b.skuId === transferForm.skuId)
);
const transferPlan = computed(() =>
  fefoPlan(
    fromRows.value.map((b) => ({ batch: store.state.batches.get(b.batchId)!, qty: b.qty })),
    store.state.recalled,
    Number(transferForm.qty) || 0
  )
);
const transferFrozen = computed(
  () =>
    store.isFrozen(transferForm.fromStoreId, transferForm.fromLocationId) ||
    store.isFrozen(transferForm.toStoreId, transferForm.toLocationId)
);
function submitTransfer() {
  run(
    () =>
      store.transfer({
        skuId: transferForm.skuId,
        qty: Number(transferForm.qty),
        from: { storeId: transferForm.fromStoreId, locationId: transferForm.fromLocationId },
        to: { storeId: transferForm.toStoreId, locationId: transferForm.toLocationId },
        memo: transferForm.memo
      }),
    `调拨成功：${transferForm.qty}${skuUnit(transferForm.skuId)} 已扣来源并落到目标同批次`
  );
}

// ---- 召回 ----
const recallForm = reactive({
  skuId: skus[0]?.id ?? "",
  storeId: stores[0]?.id ?? "",
  locationId: stores[0]?.locations[0]?.id ?? "",
  batchId: "",
  memo: ""
});
const recallBatches = computed(() =>
  store
    .balancesAt(recallForm.storeId, recallForm.locationId)
    .filter((b) => b.skuId === recallForm.skuId && !b.recalled)
);
function submitRecall() {
  run(
    () =>
      store.recall({
        skuId: recallForm.skuId,
        batchId: recallForm.batchId,
        storeId: recallForm.storeId,
        locationId: recallForm.locationId,
        memo: recallForm.memo
      }),
    `批次已召回并全额出库，此后该批次禁止出库`
  );
}

function frozenBadge(storeId: string, locationId: string) {
  return store.isFrozen(storeId, locationId);
}
</script>

<template>
  <section class="panel ops-panel" data-testid="ops-panel">
    <div class="op-tabs" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        role="tab"
        :class="{ active: active === t.key }"
        :data-testid="`op-tab-${t.key}`"
        @click="active = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 入库 -->
    <form v-if="active === 'inbound'" class="op-form" data-testid="form-inbound" @submit.prevent="submitInbound">
      <div class="form-row">
        <label>商品
          <select v-model="inboundForm.skuId" data-testid="inbound-sku">
            <option v-for="s in skus" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label>数量
          <input v-model.number="inboundForm.qty" type="number" min="1" step="1" data-testid="inbound-qty" />
        </label>
      </div>
      <div class="form-row">
        <label>批次号
          <input v-model="inboundForm.batchNo" placeholder="如 PC260915" data-testid="inbound-batchno" />
        </label>
        <label>到期日
          <input v-model="inboundForm.expiry" type="date" data-testid="inbound-expiry" />
        </label>
      </div>
      <div class="form-row">
        <label>门店
          <select v-model="inboundForm.storeId" data-testid="inbound-store">
            <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label>库位
          <select v-model="inboundForm.locationId" data-testid="inbound-location">
            <option v-for="l in locations(inboundForm.storeId)" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </label>
      </div>
      <label>备注
        <input v-model="inboundForm.memo" placeholder="供应商、单号等（可选）" data-testid="inbound-memo" />
      </label>
      <button type="submit" class="primary" data-testid="btn-inbound">确认入库</button>
    </form>

    <!-- 售出 -->
    <form v-else-if="active === 'sale'" class="op-form" data-testid="form-sale" @submit.prevent="submitSale">
      <div v-if="saleFrozen" class="inline-warn" data-testid="sale-frozen-warn">
        该库位正在盘点冻结中，售出已被禁止。
      </div>
      <div class="form-row">
        <label>商品
          <select v-model="saleForm.skuId" data-testid="sale-sku">
            <option v-for="s in skus" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label>售出数量
          <input v-model.number="saleForm.qty" type="number" min="1" step="1" data-testid="sale-qty" />
        </label>
      </div>
      <div class="form-row">
        <label>门店
          <select v-model="saleForm.storeId" data-testid="sale-store">
            <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label>库位
          <select v-model="saleForm.locationId" data-testid="sale-location">
            <option v-for="l in locations(saleForm.storeId)" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </label>
      </div>

      <div class="plan" data-testid="sale-plan">
        <p class="plan-title">FEFO 扣批预览（先到期先出）</p>
        <p v-if="saleRows.length === 0" class="plan-empty">该库位此商品无在库批次</p>
        <table v-else class="plan-table">
          <thead><tr><th>批次</th><th>到期日</th><th>在库</th><th>本次扣减</th></tr></thead>
          <tbody>
            <tr v-for="r in saleRows" :key="r.batchId" :class="{ recalled: r.recalled }">
              <td>{{ r.batchNo }}<span v-if="r.recalled" class="tag-recall">已召回</span></td>
              <td :class="`exp-${expiryState(r.expiry)}`">{{ r.expiry }}</td>
              <td>{{ r.qty }}</td>
              <td>{{ salePlan.items.find((i) => i.batchId === r.batchId)?.take ?? 0 }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="saleRows.length" class="plan-sum" :class="{ bad: !salePlan.enough }">
          可售 {{ salePlan.available }}{{ skuUnit(saleForm.skuId) }}，
          <template v-if="salePlan.enough">将拆为 {{ salePlan.items.length }} 笔批次流水</template>
          <template v-else>库存不足，整笔售出将被拒绝（不会产生任何流水）</template>
        </p>
      </div>

      <label>备注
        <input v-model="saleForm.memo" placeholder="可选" data-testid="sale-memo" />
      </label>
      <button type="submit" class="primary" data-testid="btn-sale">确认售出</button>
    </form>

    <!-- 退库 -->
    <form v-else-if="active === 'return'" class="op-form" data-testid="form-return" @submit.prevent="submitReturn">
      <div class="form-row">
        <label>商品
          <select v-model="returnForm.skuId" data-testid="return-sku">
            <option v-for="s in skus" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label>数量
          <input v-model.number="returnForm.qty" type="number" min="1" step="1" data-testid="return-qty" />
        </label>
      </div>
      <div class="form-row">
        <label>门店
          <select v-model="returnForm.storeId" data-testid="return-store">
            <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label>库位
          <select v-model="returnForm.locationId" data-testid="return-location">
            <option v-for="l in locations(returnForm.storeId)" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </label>
      </div>
      <label>退回批次
        <select v-model="returnForm.batchId" data-testid="return-batch">
          <option value="" disabled>请选择批次</option>
          <option v-for="b in returnBatches" :key="b.batchId" :value="b.batchId">
            {{ b.batchNo }}（到期 {{ b.expiry }}，在库 {{ b.qty }}）
          </option>
        </select>
      </label>
      <label>备注
        <input v-model="returnForm.memo" placeholder="可选" data-testid="return-memo" />
      </label>
      <button type="submit" class="primary" data-testid="btn-return">确认退库</button>
    </form>

    <!-- 调拨 -->
    <form v-else-if="active === 'transfer'" class="op-form" data-testid="form-transfer" @submit.prevent="submitTransfer">
      <div v-if="transferFrozen" class="inline-warn" data-testid="transfer-frozen-warn">
        来源或目标库位正在盘点冻结中，调拨已被禁止。
      </div>
      <div class="form-row">
        <label>商品
          <select v-model="transferForm.skuId" data-testid="transfer-sku">
            <option v-for="s in skus" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label>调拨数量
          <input v-model.number="transferForm.qty" type="number" min="1" step="1" data-testid="transfer-qty" />
        </label>
      </div>
      <div class="form-grid-2">
        <fieldset class="pos-block">
          <legend>来源库位（扣减）</legend>
          <select v-model="transferForm.fromStoreId" data-testid="transfer-from-store">
            <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <select v-model="transferForm.fromLocationId" data-testid="transfer-from-location">
            <option v-for="l in locations(transferForm.fromStoreId)" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </fieldset>
        <fieldset class="pos-block">
          <legend>目标库位（落同批次）</legend>
          <select v-model="transferForm.toStoreId" data-testid="transfer-to-store">
            <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <select v-model="transferForm.toLocationId" data-testid="transfer-to-location">
            <option v-for="l in locations(transferForm.toStoreId)" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </fieldset>
      </div>
      <div class="plan" data-testid="transfer-plan">
        <p class="plan-title">来源 FEFO 扣批 → 同批次落入目标</p>
        <p v-if="fromRows.length === 0" class="plan-empty">来源库位此商品无在库批次</p>
        <table v-else class="plan-table">
          <thead><tr><th>批次</th><th>到期日</th><th>来源在库</th><th>调拨量</th></tr></thead>
          <tbody>
            <tr v-for="r in fromRows" :key="r.batchId">
              <td>{{ r.batchNo }}<span v-if="r.recalled" class="tag-recall">已召回</span></td>
              <td :class="`exp-${expiryState(r.expiry)}`">{{ r.expiry }}</td>
              <td>{{ r.qty }}</td>
              <td>{{ transferPlan.items.find((i) => i.batchId === r.batchId)?.take ?? 0 }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="fromRows.length" class="plan-sum" :class="{ bad: !transferPlan.enough }">
          可调 {{ transferPlan.available }}{{ skuUnit(transferForm.skuId) }}，
          <template v-if="transferPlan.enough">出入成对生成 {{ transferPlan.items.length * 2 }} 行流水</template>
          <template v-else>来源不足，整笔调拨将被拒绝</template>
        </p>
      </div>
      <label>备注
        <input v-model="transferForm.memo" placeholder="可选" data-testid="transfer-memo" />
      </label>
      <button type="submit" class="primary" data-testid="btn-transfer">确认调拨</button>
    </form>

    <!-- 召回 -->
    <form v-else class="op-form" data-testid="form-recall" @submit.prevent="submitRecall">
      <p class="hint">召回将把该批次在所选库位的<b>全部余额</b>出库，并在全店永久禁止该批次继续出库。</p>
      <div class="form-row">
        <label>商品
          <select v-model="recallForm.skuId" data-testid="recall-sku">
            <option v-for="s in skus" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label>门店
          <select v-model="recallForm.storeId" data-testid="recall-store">
            <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>库位
          <select v-model="recallForm.locationId" data-testid="recall-location">
            <option v-for="l in locations(recallForm.storeId)" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </label>
        <label>召回批次
          <select v-model="recallForm.batchId" data-testid="recall-batch">
            <option value="" disabled>请选择批次</option>
            <option v-for="b in recallBatches" :key="b.batchId" :value="b.batchId">
              {{ b.batchNo }}（到期 {{ b.expiry }}，在库 {{ b.qty }}）
            </option>
          </select>
        </label>
      </div>
      <label>召回原因
        <input v-model="recallForm.memo" placeholder="如：总部质量通报" data-testid="recall-memo" />
      </label>
      <button type="submit" class="danger" data-testid="btn-recall">执行召回</button>
    </form>
  </section>
</template>
