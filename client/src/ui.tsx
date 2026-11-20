import { CATEGORY, PRIORITY, SLA, STATUS } from './format';

export const PriorityTag = ({ p }: { p: string }) => <span className={`tag p-${p}`}>{PRIORITY[p] ?? p}</span>;
export const StatusTag = ({ s }: { s: string }) => <span className={`tag s-${s}`}>{STATUS[s] ?? s}</span>;
export const SlaTag = ({ s }: { s: string }) => <span className={`tag sla-${s}`}>SLA: {SLA[s] ?? s}</span>;
export const CatTag = ({ c }: { c: string }) => <span className="tag">{CATEGORY[c] ?? c}</span>;
export const ErrorBox = ({ e }: { e: string }) => (e ? <div className="err" role="alert">{e}</div> : null);
