export type Role = 'owner' | 'admin' | 'agent';
export interface Me { id: number; name: string; email: string; role: Role; totpEnabled: boolean }
export type Status = 'new' | 'open' | 'pending' | 'resolved' | 'closed';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type SlaState = 'met' | 'ok' | 'at_risk' | 'breached';
export interface Sla { firstResponse: { due: string; state: SlaState }; resolution: { due: string; state: SlaState }; worst: SlaState }
export interface TicketRow {
  id: number; number: number; subject: string; status: Status; priority: Priority; category: string; sentiment: string | null;
  created_at: string; updated_at: string; assignee_id: number | null; assignee_name: string | null; customer_name: string; sla: Sla;
}
export interface Message { id: number; author_type: 'customer' | 'agent' | 'system'; body: string; internal: boolean; created_at: string; author_name: string | null }
export interface Triage { category: string; priority: Priority; sentiment: string; summary: string; reasons: string[]; source: 'rules' | 'llm' }
export interface TicketDetail extends TicketRow { customer_email: string; messages: Message[]; ai_triage: Triage | null }
export interface User { id: number; email: string; name: string; role: Role; active: boolean; totp_enabled: boolean; locked_until: string | null; invite_pending: boolean }
export interface Article { id: number; title: string; body: string; tags: string[]; published: boolean; updated_at: string }
