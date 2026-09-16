<script setup lang="ts">
import { computed, ref } from "vue";
import { useInventoryStore } from "../stores/inventory";
import { TX_TYPE_LABEL, type TxType } from "../inventory/types";
import { fmtTime, locationName, skuName, storeName } from "../composables/labels";

const store = useInventoryStore();
const typeFilter = ref<"" | TxType>("");

const txs = computed(() =>
  [...store.transactions]
    .reverse()
    .filter((t) => !typeFilter.value || t.type === typeFilter.value)
);

const typeOptions = Object.entries(TX_TYPE_LABEL);

function sign(type: TxType) {
  if (type === "inbound" || type === "return" || type === "transfer_in") return "+";
  if (type === "adjust") return "±";
  return "−";
}
</script>

<template>
  <section class="panel" data-testid="tx-panel">
    <div class="toolbar">
      <h2>库存流水账（不可变）</h2>
      <select v-model="typeFilter" data-testid="tx-filter">
        <option value="">全部类型</option>
        <option v-for="[key, label] in typeOptions" :key="key" :value="key">{{ label }}</option>
      </select>
    </div>
    <p class="muted">共 {{ store.transactions.length }} 笔流水；流水只追加、不修改，批次余额随时可由全量重放复算。</p>

    <div class="table-scroll">
      <table class="tx-table" data-testid="tx-table">
        <thead>
          <tr><th>时间</th><th>类型</th><th>摘要</th><th>明细行（批次 / 库位 / 数量）</th></tr>
        </thead>
        <tbody>
          <tr v-for="tx in txs" :key="tx.id" :data-testid="`tx-row-${tx.id}`" :class="`tx-${tx.type}`">
            <td class="nowrap">{{ fmtTime(tx.at) }}</td>
            <td><span class="type-badge" :class="`type-${tx.type}`">{{ TX_TYPE_LABEL[tx.type] }}</span></td>
            <td class="memo">{{ tx.memo }}<span v-if="tx.refTxId" class="muted"> · 关联 {{ tx.refTxId }}</span></td>
            <td>
              <ul class="tx-lines">
                <li v-for="(l, i) in tx.lines" :key="i">
                  <span class="mono">{{ l.batchNo }}</span>
                  <span class="muted">{{ skuName(l.skuId) }}</span>
                  <span class="muted">{{ storeName(l.storeId) }} / {{ locationName(l.storeId, l.locationId) }}</span>
                  <span class="qty" :class="`q-${tx.type}`">
                    {{ tx.type === "adjust" ? (l.qty > 0 ? "+" : "−") : sign(tx.type) }}{{ Math.abs(l.qty) }}
                  </span>
                </li>
              </ul>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
