<script setup lang="ts">
import { computed } from "vue";
import { useInventoryStore } from "../stores/inventory";
import { TX_TYPE_LABEL } from "../inventory/types";
import { fmtTime, locationName, skuName, storeName } from "../composables/labels";

const props = defineProps<{ batchId: string | null }>();
const emit = defineEmits<{ (e: "close"): void }>();

const store = useInventoryStore();

const meta = computed(() => (props.batchId ? store.state.batches.get(props.batchId) : undefined));
const trace = computed(() => (props.batchId ? store.trace(props.batchId) : []));

// 各店各库位当前结余，直接取重放余额表
const perStore = computed(() => {
  if (!props.batchId) return [];
  return store.balances
    .filter((b) => b.batchId === props.batchId)
    .map((b) => ({ storeId: b.storeId, locationId: b.locationId, qty: b.qty, recalled: b.recalled }));
});
</script>

<template>
  <div v-if="batchId" class="modal-mask" data-testid="trace-modal" @click.self="emit('close')">
    <div class="modal">
      <header>
        <h2>批次去向追溯</h2>
        <button type="button" class="icon-btn" data-testid="trace-close" @click="emit('close')">×</button>
      </header>
      <div v-if="meta" class="trace-meta">
        <div><span class="muted">商品</span>{{ skuName(meta.skuId) }}</div>
        <div><span class="muted">批次号</span><b class="mono">{{ meta.batchNo }}</b></div>
        <div><span class="muted">到期日</span>{{ meta.expiry }}</div>
        <div><span class="muted">状态</span><b v-if="store.state.recalled.has(batchId)" class="badge-recall">已召回 · 禁止出库</b><b v-else class="badge-ok">正常</b></div>
      </div>

      <section class="trace-now">
        <h3>当前分布（重放结果）</h3>
        <ul>
          <li v-for="x in perStore" :key="`${x.storeId}|${x.locationId}`">
            {{ storeName(x.storeId) }} / {{ locationName(x.storeId, x.locationId) }}：
            <b>{{ x.qty }}</b>
            <span v-if="x.recalled" class="badge-recall">已召回</span>
          </li>
          <li v-if="perStore.length === 0" class="muted">各店库位当前结余均为 0（已售罄 / 调出 / 召回）</li>
        </ul>
      </section>

      <section class="trace-timeline" data-testid="trace-timeline">
        <h3>完整流水去向</h3>
        <ol class="trace-list">
          <li v-for="{ seq, tx, line } in trace" :key="tx.id + seq" class="trace-item" :data-testid="`trace-line-${tx.type}`">
            <span class="trace-time">{{ fmtTime(tx.at) }}</span>
            <span class="type-badge" :class="`type-${tx.type}`">{{ TX_TYPE_LABEL[tx.type] }}</span>
            <span class="trace-detail">
              {{ storeName(line.storeId) }} / {{ locationName(line.storeId, line.locationId) }} ·
              <b :class="`q-${tx.type}`">
                {{ tx.type === "adjust" ? (line.qty > 0 ? "+" : "−") : ["inbound", "return", "transfer_in"].includes(tx.type) ? "+" : "−" }}{{ Math.abs(line.qty) }}
              </b>
            </span>
            <span class="muted trace-memo">{{ tx.memo }}</span>
          </li>
        </ol>
      </section>
    </div>
  </div>
</template>
