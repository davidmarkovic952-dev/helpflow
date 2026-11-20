export const fmtDate = (s: string) => new Date(s).toLocaleString('sr-RS', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export function rel(s: string) {
  const d = (new Date(s).getTime() - Date.now()) / 60000;
  const a = Math.abs(d);
  const v = a < 60 ? `${Math.round(a)} min` : a < 1440 ? `${Math.round(a / 60)} h` : `${Math.round(a / 1440)} d`;
  return d >= 0 ? `za ${v}` : `pre ${v}`;
}
export const STATUS: Record<string, string> = { new: 'Novo', open: 'Otvoreno', pending: 'Čeka kupca', resolved: 'Rešeno', closed: 'Zatvoreno' };
export const PRIORITY: Record<string, string> = { urgent: 'Hitno', high: 'Visok', normal: 'Normalan', low: 'Nizak' };
export const CATEGORY: Record<string, string> = { billing: 'Naplata', technical: 'Tehničko', account: 'Nalog', shipping: 'Dostava', feedback: 'Utisak', general: 'Opšte' };
export const SLA: Record<string, string> = { met: 'Ispunjen', ok: 'U roku', at_risk: 'Ističe', breached: 'Probijen' };
export const ROLE: Record<string, string> = { owner: 'Vlasnik', admin: 'Administrator', agent: 'Agent' };
