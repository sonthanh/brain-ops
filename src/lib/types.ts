export interface Email {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
}

export interface TriageAction {
  action: string;
  id: string;
  from: string;
  subject: string;
  reply_hint?: string;
}

export type ExecutionResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface CleanupStats {
  actions: Record<string, number>;
  skipped: number;
  total: number;
}
