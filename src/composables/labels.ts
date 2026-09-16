import { SKUS, STORES } from "../inventory/seed";

export function storeName(id: string) {
  return STORES.find((s) => s.id === id)?.name ?? id;
}

export function locationName(storeId: string, id: string) {
  return STORES.find((s) => s.id === storeId)?.locations.find((l) => l.id === id)?.name ?? id;
}

export function skuName(id: string) {
  return SKUS.find((s) => s.id === id)?.name ?? id;
}

export function skuUnit(id: string) {
  return SKUS.find((s) => s.id === id)?.unit ?? "";
}

export function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function expiryState(expiry: string): "expired" | "near" | "ok" {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${expiry}T00:00:00`);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (days < 0) return "expired";
  if (days <= 30) return "near";
  return "ok";
}
