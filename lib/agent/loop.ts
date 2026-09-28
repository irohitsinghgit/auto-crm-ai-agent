import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import { complete } from './llm';
import { buildSystemPrompt, testDrivePitch } from './prompt';
import { executeTool, toolStage, toolStatus, type Stage } from './tools';
import { appendHistory, awaitingConfirmation, hasTestDriveEnquiry, lastAssistantReply, toolContext, type Session } from '../session';

const TEST_DRIVE_MENTION = /test[\s-]?drive/i;

const MAX_ROUNDS = 5;

const WRITE_TOOLS = new Set(['create_lead', 'create_contact', 'create_service_case', 'update_deal_followup']);

// A bare approval such as "yes" or "go ahead". Anything carrying new details or doubts goes to the model instead.
const APPROVAL = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|correct|confirm(ed)?|go ahead|proceed|please do|do it|haan?|ji|that'?s (right|correct)|all (good|correct)|looks (good|right))\b/i;
const CARRIES_CHANGES = /@|\d{3,}|\b(but|change|except|wrong|not|no|instead|update)\b/i;
export const isApproval = (message: string) => message.length <= 60 && APPROVAL.test(message) && !CARRIES_CHANGES.test(message);

// Past-tense claims that a record was saved, e.g. "has been registered" or "I've noted your request".
const WRITE_CLAIM =
  /\b(has been|have been|is|are|was|were|successfully|i've|i have|we've|we have)\s+(\w+\s+){0,2}?(registered|created|logged|submitted|recorded|noted|saved|updated)\b|\b(registered|created|logged|submitted|recorded|saved|updated) successfully\b/i;
export const claimsWrite = (reply: string) => WRITE_CLAIM.test(reply);

const FALSE_CLAIM_CORRECTION =
  'Correction: your last reply said something was saved, registered or updated, but no save succeeded in this turn, so that reply was withdrawn. Do not claim anything was saved. If the customer has approved details for a record, call the matching tool now (it returns a summary first if one has not been approved yet). Otherwise tell the customer what is still needed.';

const SAVE_FAILED_REPLY =
  "Sorry, I couldn't save that just now, so nothing has been recorded yet. Please send your confirmation again, or tell me if any details should change.";

export type AgentEvent =
  | { type: 'stage'; stage: Stage }
  | { type: 'tool_start'; id: string; name: string; status: string }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; status?: string }
  | { type: 'text'; delta: string }
  // Discards the text streamed so far in this reply; sent when a reply is withdrawn by the save guard.
  | { type: 'reset' }
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

const parseArgs = (raw: string): Record<string, unknown> => {
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
};

// `llm` defaults to the Groq client; tests can pass a scripted completion to exercise the loop deterministically.
export async function runAgentTurn(session: Session, userMessage: string, emit: Emit, signal?: AbortSignal, llm: typeof complete = complete) {
  const setStage = (stage: Stage | null) => {
    if (stage && stage !== session.stage) {
      session.stage = stage;
      emit({ type: 'stage', stage });
    }
  };
  setStage(detectStage(userMessage, session.stage));

  const turnNumber = session.turn + 1;
  const ctx = toolContext(session, { turn: turnNumber, approvedReply: isApproval(userMessage) ? lastAssistantReply(session) : null });
  const turn: ChatCompletionMessageParam[] = [{ role: 'user', content: userMessage }];
  const log = { model: '-', tools: [] as string[], guard: '' };
  let answeredVehicleQuestion = false;
  let wroteRecord = false;
  let corrected = false;

  const runTool = async (id: string, name: string, rawArgs: string) => {
    setStage(toolStage(name));
    emit({ type: 'tool_start', id, name, status: toolStatus(name) });
    const result = await executeTool(name, rawArgs, ctx);
    if (result.error === 'confirmation_required') {
      session.pendingAction = { tool: name, args: parseArgs(rawArgs), turn: turnNumber };
      // A pending confirmation is an expected step, not a failure, so the badge says so.
      emit({ type: 'tool_end', id, name, ok: true, status: 'Details ready to confirm' });
    } else {
      emit({ type: 'tool_end', id, name, ok: result.ok === true });
    }
    if (name === 'get_vehicle_info' && result.ok) answeredVehicleQuestion = true;
    if (WRITE_TOOLS.has(name) && result.ok) wroteRecord = true;
    log.tools.push(`${name}:${result.ok ? 'ok' : result.error}`);
    turn.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) });
  };

  // A summary shown last turn and approved now is saved by the server itself, so the write never
  // depends on the model remembering to call the tool. The pending action only lives for one turn.
  const pending = session.pendingAction;
  if (pending && pending.turn === session.turn && isApproval(userMessage)) {
    session.pendingAction = null;
    const id = `approved-${turnNumber}`;
    const rawArgs = JSON.stringify({ ...pending.args, customer_confirmed: true });
    turn.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: pending.tool, arguments: rawArgs } }] });
    await runTool(id, pending.tool, rawArgs);
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const prompt = buildSystemPrompt({
      stage: session.stage,
      collected: session.collected,
      testDriveRegistered: hasTestDriveEnquiry(session),
      awaitingConfirmation: awaitingConfirmation(session),
    });
    const { content, toolCalls, model } = await llm([{ role: 'system', content: prompt }, ...session.history, ...turn], {
      allowTools: round < MAX_ROUNDS - 1,
      signal,
      onText: (delta) => emit({ type: 'text', delta }),
    });
    log.model = model;

    if (!toolCalls.length) {
      let reply = content.trim() || 'Sorry, I could not put together an answer. Could you rephrase that?';
      if (!content.trim()) emit({ type: 'text', delta: reply });

      // Never let a reply claim a save that did not happen: withdraw it, give the model one chance
      // to actually make the call, and otherwise tell the customer plainly that nothing was saved.
      if (claimsWrite(reply) && !wroteRecord) {
        emit({ type: 'reset' });
        if (!corrected && round < MAX_ROUNDS - 2) {
          corrected = true;
          log.guard = 'corrected';
          turn.push({ role: 'assistant', content: reply }, { role: 'system', content: FALSE_CLAIM_CORRECTION });
          continue;
        }
        log.guard = 'blocked';
        reply = SAVE_FAILED_REPLY;
        emit({ type: 'text', delta: reply });
      }

      // Backstop for the prompt's test drive rule: a vehicle answer always ends with the pitch.
      const testDriveDiscussed = TEST_DRIVE_MENTION.test(reply) || TEST_DRIVE_MENTION.test(userMessage);
      if (answeredVehicleQuestion && !hasTestDriveEnquiry(session) && !testDriveDiscussed) {
        const pitch = `\n\n${testDrivePitch(session.collected.customer)}`;
        emit({ type: 'text', delta: pitch });
        reply += pitch;
      }
      finishTurn(session, userMessage, reply, emit, log);
      return;
    }

    turn.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      await runTool(call.id, call.function.name, call.function.arguments);
    }
  }

  const fallback = 'I was not able to complete that request just now. Please try again or rephrase it.';
  emit({ type: 'text', delta: fallback });
  finishTurn(session, userMessage, fallback, emit, log);
}

// Only the user message and final reply are kept across turns. Raw tool traffic stays within its turn;
// the IDs and facts later turns rely on are carried by session.collected in the system prompt.
function finishTurn(session: Session, userMessage: string, reply: string, emit: Emit, log: { model: string; tools: string[]; guard: string }) {
  appendHistory(session, [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: reply },
  ]);
  session.turn++;
  // A summary not approved in the turn right after it was shown expires.
  if (session.pendingAction && session.pendingAction.turn !== session.turn) session.pendingAction = null;
  // One line per turn without customer data, so a conversation can be traced from the server log.
  console.info(
    `[turn] session=${session.id.slice(0, 8)} #${session.turn} model=${log.model} tools=${log.tools.join(',') || '-'}${log.guard ? ` guard=${log.guard}` : ''}`,
  );
  emit({ type: 'done' });
}
