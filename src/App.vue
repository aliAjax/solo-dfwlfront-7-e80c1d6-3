<script setup lang="ts">
import { computed, ref } from "vue";
import OperationPanel from "./components/OperationPanel.vue";
import StocktakePanel from "./components/StocktakePanel.vue";
import LedgerTable from "./components/LedgerTable.vue";
import TransactionLog from "./components/TransactionLog.vue";
import BatchTraceModal from "./components/BatchTraceModal.vue";
import { useInventoryStore } from "./stores/inventory";
import { useToast } from "./composables/useToast";
import { TX_TYPE_LABEL } from "./inventory/types";

const store = useInventoryStore();
const { toasts, dismiss } = useToast();

const traceBatchId = ref<string | null>(null);
function openTrace(batchId: string) {
  traceBatchId.value = batchId;
}

const metrics = computed(() => {
  const totalQty = store.balances.reduce((a, b) => a + b.qty, 0);
  const recalledBatches = new Set([...store.state.recalled]).size;
  const frozen = store.openStocktakes.length;
  return [
    { label: "在库批次行", value: store.balances.length },
    { label: "在库总数量", value: totalQty },
    { label: "已召回批次", value: recalledBatches },
    { label: "冻结库位", value: frozen },
    { label: "累计流水", value: store.transactions.length }
  ];
});

const lastTx = computed(() =>
  store.transactions.length ? TX_TYPE_LABEL[store.transactions[store.transactions.length - 1].type] : "—"
);

function resetDemo() {
  if (window.confirm("确定恢复演示数据？当前所有流水将被清空并重放种子流水。")) {
    store.resetDemo();
  }
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">加油站便利店 · 批次库存台</p>
          <h1>批次库存与流水台账</h1>
          <p class="subtitle">
            按批次记录入库 / 售出 / 退库 / 调拨 / 召回；售出按先到期先出自动扣批，
            跨店调拨出入成对，盘点冻结库位、差异只走调整流水，余额全部由不可变流水重放得出。
          </p>
        </div>
        <div class="top-actions">
          <span class="last-tx">最近流水：{{ lastTx }}</span>
          <button type="button" class="secondary" data-testid="btn-reset" @click="resetDemo">重置演示数据</button>
        </div>
      </header>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <div class="layout">
        <div class="col-left">
          <OperationPanel />
          <StocktakePanel />
        </div>
        <div class="col-right">
          <LedgerTable @trace="openTrace" />
          <TransactionLog />
        </div>
      </div>

      <footer class="foot">
        数据保存在本机浏览器 localStorage；刷新后余额由全部流水重新重放，不存在可被直接改写的余额字段。
      </footer>
    </div>

    <BatchTraceModal :batch-id="traceBatchId" @close="traceBatchId = null" />

    <div class="toast-stack" data-testid="toast-stack">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="t.kind"
        :data-testid="t.kind === 'ok' ? 'toast-ok' : 'toast-err'"
        @click="dismiss(t.id)"
      >
        <b>{{ t.kind === "ok" ? "成功" : "整单失败" }}</b>
        <span>{{ t.text }}</span>
      </div>
    </div>
  </main>
</template>
