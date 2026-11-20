/** SLA ciljevi i stanje — čiste funkcije. */
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type SlaState = 'met' | 'ok' | 'at_risk' | 'breached';

export const SLA_TARGETS: Record<Priority, { firstResponseH: number; resolutionH: number }> = {
  urgent: { firstResponseH: 1, resolutionH: 8 },
  high: { firstResponseH: 4, resolutionH: 24 },
  normal: { firstResponseH: 8, resolutionH: 72 },
  low: { firstResponseH: 24, resolutionH: 120 }
};

const H = 3_600_000;

function clock(start: Date, done: Date | null, targetH: number, now: Date) {
  const due = new Date(start.getTime() + targetH * H);
  if (done) return { due: due.toISOString(), state: (done <= due ? 'met' : 'breached') as SlaState };
  const used = (now.getTime() - start.getTime()) / (targetH * H);
  return { due: due.toISOString(), state: (used >= 1 ? 'breached' : used >= 0.75 ? 'at_risk' : 'ok') as SlaState };
}

export function slaStatus(t: { priority: Priority; created_at: Date | string; first_response_at: Date | string | null; resolved_at: Date | string | null }, now = new Date()) {
  const created = new Date(t.created_at);
  const target = SLA_TARGETS[t.priority];
  const firstResponse = clock(created, t.first_response_at ? new Date(t.first_response_at) : null, target.firstResponseH, now);
  const resolution = clock(created, t.resolved_at ? new Date(t.resolved_at) : null, target.resolutionH, now);
  const order: SlaState[] = ['breached', 'at_risk', 'ok', 'met'];
  const worst = [firstResponse.state, resolution.state].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  return { firstResponse, resolution, worst };
}

/** Dozvoljeni prelazi statusa — sprečava npr. da se zatvoren tiket "vrati" u new. */
const TRANSITIONS: Record<string, string[]> = {
  new: ['open', 'pending', 'resolved', 'closed'],
  open: ['pending', 'resolved', 'closed'],
  pending: ['open', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open']
};
export const canTransition = (from: string, to: string) => from === to || (TRANSITIONS[from] || []).includes(to);
