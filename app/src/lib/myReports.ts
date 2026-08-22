// Reports submitted from this device (tracking tokens only — no account).
export interface MyReport { id: string; category: string; address: string; createdAt: string; }
const KEY = 'snappvd.myReports';

export function listMyReports(): MyReport[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as MyReport[]; } catch { return []; }
}
export function rememberReport(r: MyReport) {
  try {
    const list = listMyReports().filter((x) => x.id !== r.id);
    list.unshift(r);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 50)));
  } catch { /* ignore */ }
}
export function forgetReport(id: string) {
  try { localStorage.setItem(KEY, JSON.stringify(listMyReports().filter((x) => x.id !== id))); } catch { /* ignore */ }
}
