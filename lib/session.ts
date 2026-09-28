import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import type { Stage, ToolContext } from './agent/tools';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_HISTORY_MESSAGES = 40;

export interface Session {
  id: string;
  history: ChatCompletionMessageParam[];
  stage: Stage | null;
  // Details the customer stated, kept apart from records found by lookups, which may belong to someone else.
  collected: { customer: Record<string, string>; lookups: Record<string, string> };
  knownContactIds: Set<string>;
  knownDealIds: Set<string>;
  unmatchedPhones: Set<string>;
  matchedPhones: Map<string, string>;
  createdRecords: Map<string, Record<string, unknown>>;
  busy: boolean;
  updatedAt: number;
}

// Stored on globalThis so sessions survive Next.js dev-mode module reloads.
const globalStore = globalThis as typeof globalThis & { __sessions?: Map<string, Session> };
const sessions: Map<string, Session> = (globalStore.__sessions ??= new Map());

function evictStale() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.updatedAt < cutoff && !session.busy) sessions.delete(id);
  }
  // Map iteration follows insertion order, so the first entries are the oldest.
  for (const id of sessions.keys()) {
    if (sessions.size < MAX_SESSIONS) break;
    sessions.delete(id);
  }
}

export function getSession(id: string): Session {
  let session = sessions.get(id);
  if (!session) {
    evictStale();
    session = {
      id,
      history: [],
      stage: null,
      collected: { customer: {}, lookups: {} },
      knownContactIds: new Set(),
      knownDealIds: new Set(),
      unmatchedPhones: new Set(),
      matchedPhones: new Map(),
      createdRecords: new Map(),
      busy: false,
      updatedAt: Date.now(),
    };
    sessions.set(id, session);
  }
  session.updatedAt = Date.now();
  return session;
}

export function deleteSession(id: string) {
  sessions.delete(id);
}

export function hasTestDriveEnquiry(session: Session): boolean {
  return [...session.createdRecords.keys()].some((key) => key.startsWith('lead:'));
}

export function toolContext(session: Session): ToolContext {
  return {
    knownContactIds: session.knownContactIds,
    knownDealIds: session.knownDealIds,
    unmatchedPhones: session.unmatchedPhones,
    matchedPhones: session.matchedPhones,
    createdRecords: session.createdRecords,
    remember(details, source = 'customer') {
      const target = session.collected[source];
      for (const [key, value] of Object.entries(details)) {
        if (value) target[key] = value;
      }
    },
  };
}

export function appendHistory(session: Session, messages: ChatCompletionMessageParam[]) {
  session.history.push(...messages);
  if (session.history.length <= MAX_HISTORY_MESSAGES) return;

  // Trim at a user message so no tool result is left without its assistant tool call.
  const overflow = session.history.length - MAX_HISTORY_MESSAGES;
  const cut = session.history.findIndex((m, i) => i >= overflow && m.role === 'user');
  if (cut > 0) session.history = session.history.slice(cut);
}
