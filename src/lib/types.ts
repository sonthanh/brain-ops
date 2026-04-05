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

export interface ExecutionResult {
  ok: boolean;
  skip: boolean;
  reason?: string;
}

export interface CleanupStats {
  actions: Record<string, number>;
  skipped: number;
  total: number;
}
