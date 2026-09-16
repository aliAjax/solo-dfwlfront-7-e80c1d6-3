// 极简全局提示：成功/失败的即时反馈（不引入额外依赖）
import { reactive } from "vue";

export interface Toast {
  id: number;
  kind: "ok" | "err";
  text: string;
}

const toasts = reactive<Toast[]>([]);
let seq = 0;

export function useToast() {
  function push(kind: Toast["kind"], text: string) {
    const id = ++seq;
    toasts.push({ id, kind, text });
    window.setTimeout(() => dismiss(id), 4200);
  }
  function ok(text: string) {
    push("ok", text);
  }
  function err(text: string) {
    push("err", text);
    // 失败提示保留更久，便于人工核对「整单失败、无流水产生」
    window.setTimeout(() => dismiss(seq), 6000);
  }
  function dismiss(id: number) {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }
  return { toasts, ok, err, dismiss };
}
