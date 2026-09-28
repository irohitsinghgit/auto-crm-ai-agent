import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import { complete } from './llm';
import { buildSystemPrompt } from './prompt';
import { executeTool, toolStage, toolStatus, type Stage } from './tools';
import { appendHistory, toolContext, type Session } from '../session';

const MAX_ROUNDS = 5;

export type AgentEvent =
  | { type: 'stage'; stage: Stage }
  | { type: 'tool_start'; id: string; name: string; status: string }
  | { type: 'tool_end'; id: string; name: string; ok: boolean }
  | { type: 'text'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

type Emit = (event: AgentEvent) => void;

const STAGE_SIGNALS: Record<Stage, RegExp[]> = {
  booked: [
    /\b(booking|booked|delivery|deliver(ed)?|vin|allocat\w*|dispatch\w*|balance payment|waiting period)\b/i,
    /\bMAH-?\s?\d{3,}/i,
  ],
  service: [
    /\b(service|servicing|complaint|repair|breakdown|warranty|workshop|odometer|registration)\b/i,
    /\b(noise|leak\w*|brake\w*|clutch|battery|tyre|not working|problem with|issue with)\b/i,
  ],
  pipeline: [
    /\b(quotation|quote|deal id|dealer contact|sales (person|executive)|follow[- ]?up)\b/i,
    /\btest ?drive\b.*\b(status|confirm\w*|scheduled|when)\b|\b(status|confirm\w*)\b.*\btest ?drive\b/i,
  ],
  new_lead: [
    /\b(price|pricing|cost|variant|features?|specs?|mileage|engine|on-?road|ex-?showroom|compare)\b/i,
    /\b(xuv\s?700|thar|scorpio)\b/i,
    /\b(book|schedule|want) (a )?test ?drive\b/i,
  ],
};

// Keyword routing gives an immediate stage hint for the UI; tool calls later confirm or correct it.
export function detectStage(message: string, current: Stage | null): Stage | null {
  let best: Stage | null = null;
  let bestScore = 0;
  for (const [stage, patterns] of Object.entries(STAGE_SIGNALS) as [Stage, RegExp[]][]) {
    const score = patterns.filter((p) => p.test(message)).length;
    const winsTie = score === bestScore && stage === current;
    if (score > bestScore || (score > 0 && winsTie)) {
      best = stage;
      bestScore = score;
    }
  }
  return best ?? current;
}

export async function runAgentTurn(session: Session, userMessage: string, emit: Emit, signal?: AbortSignal) {
  const setStage = (stage: Stage | null) => {
    if (stage && stage !== session.stage) {
      session.stage = stage;
      emit({ type: 'stage', stage });
    }
  };
  setStage(detectStage(userMessage, session.stage));

  const ctx = toolContext(session);
  const turn: ChatCompletionMessageParam[] = [{ role: 'user', content: userMessage }];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const system: ChatCompletionMessageParam = { role: 'system', content: buildSystemPrompt(session.stage, session.collected) };
    const { content, toolCalls } = await complete([system, ...session.history, ...turn], {
      allowTools: round < MAX_ROUNDS - 1,
      signal,
      onText: (delta) => emit({ type: 'text', delta }),
    });

    if (!toolCalls.length) {
      const reply = content.trim() || 'Sorry, I could not put together an answer. Could you rephrase that?';
      if (!content.trim()) emit({ type: 'text', delta: reply });
      finishTurn(session, userMessage, reply, emit);
      return;
    }

    turn.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const { name } = call.function;
      setStage(toolStage(name));
      emit({ type: 'tool_start', id: call.id, name, status: toolStatus(name) });
      const result = await executeTool(name, call.function.arguments, ctx);
      emit({ type: 'tool_end', id: call.id, name, ok: result.ok === true });
      turn.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  const fallback = 'I was not able to complete that request just now. Please try again or rephrase it.';
  emit({ type: 'text', delta: fallback });
  finishTurn(session, userMessage, fallback, emit);
}

// Only the user message and final reply are kept across turns. Raw tool traffic stays within its turn;
// the IDs and facts later turns rely on are carried by session.collected in the system prompt.
function finishTurn(session: Session, userMessage: string, reply: string, emit: Emit) {
  appendHistory(session, [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: reply },
  ]);
  emit({ type: 'done' });
}
