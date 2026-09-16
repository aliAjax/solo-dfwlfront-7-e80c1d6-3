<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useInventoryStore } from "../stores/inventory";
import { InventoryError } from "../inventory/engine";
import { useToast } from "../composables/useToast";
import { locationName, storeName } from "../composables/labels";

const store = useInventoryStore();
const toast = useToast();

const startForm = reactive({
  storeId: store.stores[0]?.id ?? "",
  locationId: store.stores[0]?.locations[0]?.id ?? ""
});

function start() {
  try {
    const st = store.startStocktake({
      storeId: startForm.storeId,
      locationId: startForm.locationId
    });
    toast.ok(`盘点 ${st.id.slice(-5)} 已开始，库位已冻结`);
  } catch (e) {
    toast.err(e instanceof InventoryError ? e.message : String(e));
  }
}

const openList = computed(() => store.openStocktakes);

// 当前展开录入的盘点单
const activeId = ref<string | null>(null);
const counts = reactive<Record<string, number>>({});

function activate(id: string) {
  activeId.value = id;
  const st = store.stocktakes.find((x) => x.id === id)!;
  // 预填系统重放余额作为实盘初值
  for (const row of store.balancesAt(st.storeId, st.locationId)) {
    const k = `${row.skuId}|${row.batchId}`;
    counts[k] = st.counted[k] ?? row.qty;
  }
}

const activeStocktake = computed(() => store.stocktakes.find((x) => x.id === activeId.value));

const activeRows = computed(() => {
  const st = activeStocktake.value;
  if (!st) return [];
  return store.balancesAt(st.storeId, st.locationId);
});

function rowCount(skuId: string, batchId: string) {
  return counts[`${skuId}|${batchId}`];
}

const diffs = computed(() => {
  const st = activeStocktake.value;
  if (!st) return { diffs: [] as { key: string; batchNo: string; onHand: number; counted: number; delta: number }[], missing: 0 };
  const list = activeRows.value.map((r) => {
    const key = `${r.skuId}|${r.batchId}`;
    const counted = Number(counts[key]);
    return { key, batchNo: r.batchNo, onHand: r.qty, counted, delta: counted - r.qty };
  });
  return { diffs: list, missing: 0 };
});

function confirm() {
  const st = activeStocktake.value;
  if (!st) return;
  const payload = activeRows.value.map((r) => ({
    skuId: r.skuId,
    batchId: r.batchId,
    qty: Number(counts[`${r.skuId}|${r.batchId}`])
  }));
  try {
    const result = store.confirmStocktake(st.id, payload);
    if (result.adjustTx) {
      toast.ok(`盘点确认：生成 ${result.adjustTx.lines.length} 行库存调整流水，余额由流水重放更新`);
    } else {
      toast.ok("盘点确认：账实一致，未生成调整流水");
    }
    activeId.value = null;
  } catch (e) {
    toast.err(e instanceof InventoryError ? e.message : String(e));
  }
}

function cancel(id: string) {
  try {
    store.cancelStocktake(id);
    if (activeId.value === id) activeId.value = null;
    toast.ok("盘点已取消，库位解冻");
  } catch (e) {
    toast.err(e instanceof InventoryError ? e.message : String(e));
  }
}

const history = computed(() =>
  [...store.stocktakes]
    .filter((s) => s.status !== "open")
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
);
</script>

<template>
  <section class="panel" data-testid="stocktake-panel">
    <h2>库位盘点</h2>
    <p class="hint">开始盘点即冻结库位（入库/售出/退库/调拨全部拦截）；差异确认后<b>只生成库存调整流水</b>，不直接改余额。</p>

    <form class="inline-form" @submit.prevent="start">
      <label>门店
        <select v-model="startForm.storeId" data-testid="st-start-store">
          <option v-for="s in store.stores" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <label>库位
        <select v-model="startForm.locationId" data-testid="st-start-location">
          <option
            v-for="l in store.stores.find((s) => s.id === startForm.storeId)?.locations ?? []"
            :key="l.id"
            :value="l.id"
          >{{ l.name }}</option>
        </select>
      </label>
      <button type="submit" class="primary" data-testid="btn-st-start">开始盘点（冻结库位）</button>
    </form>

    <div v-if="openList.length" class="st-open" data-testid="st-open-list">
      <h3>进行中（库位冻结）</h3>
      <article v-for="st in openList" :key="st.id" class="st-card" :data-testid="`st-open-${st.id}`">
        <div class="st-card-head">
          <strong>{{ storeName(st.storeId) }} · {{ locationName(st.storeId, st.locationId) }}</strong>
          <span class="badge-frozen">冻结中</span>
        </div>
        <p class="muted">{{ st.id }} · 开始 {{ new Date(st.startedAt).toLocaleString() }}</p>
        <template v-if="activeId === st.id">
          <table class="count-table" data-testid="st-count-table">
            <thead><tr><th>商品</th><th>批次</th><th>到期</th><th>账面</th><th>实盘</th><th>差异</th></tr></thead>
            <tbody>
              <tr v-for="r in activeRows" :key="`${r.skuId}|${r.batchId}`">
                <td>{{ store.skus.find((s) => s.id === r.skuId)?.name }}</td>
                <td>{{ r.batchNo }}</td>
                <td>{{ r.expiry }}</td>
                <td>{{ r.qty }}</td>
                <td>
                  <input
                    v-model.number="counts[`${r.skuId}|${r.batchId}`]"
                    type="number"
                    min="0"
                    step="1"
                    :data-testid="`st-count-${r.batchId}`"
                  />
                </td>
                <td :class="rowCount(r.skuId, r.batchId) - r.qty > 0 ? 'diff-up' : rowCount(r.skuId, r.batchId) - r.qty < 0 ? 'diff-down' : ''">
                  {{ rowCount(r.skuId, r.batchId) - r.qty }}
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="activeRows.length === 0" class="muted">该库位当前无在库批次，可直接确认。</p>
          <div class="st-actions">
            <button type="button" class="primary" data-testid="btn-st-confirm" @click="confirm">
              确认盘点（差异生成调整流水）
            </button>
            <button type="button" class="secondary" @click="activeId = null">收起</button>
          </div>
        </template>
        <div v-else class="st-actions">
          <button type="button" class="secondary" data-testid="btn-st-enter" @click="activate(st.id)">录入实盘</button>
          <button type="button" class="danger-ghost" data-testid="btn-st-cancel" @click="cancel(st.id)">取消盘点</button>
        </div>
      </article>
    </div>

    <div v-if="history.length" class="st-history">
      <h3>已结束盘点</h3>
      <ul class="st-history-list">
        <li v-for="st in history" :key="st.id" :data-testid="`st-history-${st.id}`">
          <span>{{ storeName(st.storeId) }} · {{ locationName(st.storeId, st.locationId) }}</span>
          <span :class="st.status === 'confirmed' ? 'status-confirmed' : 'status-cancelled'">
            {{ st.status === "confirmed" ? "已确认" : "已取消" }}
          </span>
          <span v-if="st.adjustTxId" class="muted">调整流水 {{ st.adjustTxId }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>
