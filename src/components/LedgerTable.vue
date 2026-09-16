<script setup lang="ts">
import { computed, reactive } from "vue";
import { useInventoryStore } from "../stores/inventory";
import { expiryState, locationName, skuName, skuUnit, storeName } from "../composables/labels";

const emit = defineEmits<{ (e: "trace", batchId: string): void }>();

const store = useInventoryStore();
const filter = reactive({ storeId: "", skuId: "", hideRecalled: false });

const rows = computed(() =>
  store.balances.filter(
    (b) =>
      (!filter.storeId || b.storeId === filter.storeId) &&
      (!filter.skuId || b.skuId === filter.skuId) &&
      (!filter.hideRecalled || !b.recalled)
  )
);

const totalUnits = computed(() => rows.value.reduce((a, r) => a + r.qty, 0));
const batchCount = computed(() => new Set(rows.value.map((r) => r.batchId)).size);
</script>

<template>
  <section class="panel" data-testid="ledger-panel">
    <div class="toolbar">
      <h2>批次库存台账</h2>
      <div class="filters">
        <select v-model="filter.storeId" data-testid="ledger-filter-store">
          <option value="">全部门店</option>
          <option v-for="s in store.stores" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <select v-model="filter.skuId" data-testid="ledger-filter-sku">
          <option value="">全部商品</option>
          <option v-for="s in store.skus" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <label class="check">
          <input v-model="filter.hideRecalled" type="checkbox" data-testid="ledger-hide-recalled" />
          隐藏召回
        </label>
      </div>
    </div>
    <p class="muted ledger-summary">
      {{ batchCount }} 个在库批次 · 合计 {{ totalUnits }} 件（余额全部由流水重放得出）
    </p>

    <div class="table-scroll">
      <table class="ledger-table" data-testid="ledger-table">
        <thead>
          <tr>
            <th>门店 / 库位</th><th>商品</th><th>批次号</th><th>到期日</th>
            <th class="num">在库数量</th><th>状态</th><th>去向</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="`${r.storeId}|${r.locationId}|${r.batchId}`" :data-testid="`ledger-row-${r.batchId}`">
            <td>{{ storeName(r.storeId) }}<span class="loc">/ {{ locationName(r.storeId, r.locationId) }}</span></td>
            <td>{{ skuName(r.skuId) }}</td>
            <td class="mono">{{ r.batchNo }}</td>
            <td :class="`exp-${expiryState(r.expiry)}`">{{ r.expiry }}</td>
            <td class="num strong">{{ r.qty }} <span class="unit">{{ skuUnit(r.skuId) }}</span></td>
            <td>
              <span v-if="r.recalled" class="badge-recall">已召回</span>
              <span v-else-if="store.isFrozen(r.storeId, r.locationId)" class="badge-frozen">盘点冻结</span>
              <span v-else class="badge-ok">正常</span>
            </td>
            <td>
              <button type="button" class="link-btn" :data-testid="`trace-btn-${r.batchId}`" @click="emit('trace', r.batchId)">
                查看去向
              </button>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="7" class="empty-cell">无匹配批次</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
