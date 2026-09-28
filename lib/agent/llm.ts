import Groq from 'groq-sdk';
import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall } from 'groq-sdk/resources/chat/completions';
import { toolDefinitions } from './tools';

// Each Groq model has its own per-minute and per-day token quota, so a rate-limited model is
// skipped until its quota resets and the request moves on to the next model in the list.
const DEFAULT_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
const DEFAULT_COOLDOWN_MS = 60_000;

interface Cooldown {
  until: number;
  daily: boolean;
}

export class ModelsUnavailableError extends Error {
  daily: boolean;
  retryAfterMs: number;

  constructor(daily: boolean, retryAfterMs: number) {
    super(daily ? 'All models have reached their daily token limit' : 'All models are rate limited');
    this.name = 'ModelsUnavailableError';
    this.daily = daily;
    this.retryAfterMs = retryAfterMs;
  }
}

interface CompletionOptions {
  allowTools: boolean;
  signal?: AbortSignal;
  onText: (delta: string) => void;
}

// Retries are handled here: rate limits switch models instead of waiting, transient errors retry once.
let client: Groq | null = null;
const groq = () => (client ??= new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: 0, timeout: 30_000 }));

// Stored on globalThis so cooldowns survive Next.js dev-mode module reloads.
const globalStore = globalThis as typeof globalThis & { __groqCooldowns?: Map<string, Cooldown> };
const cooldowns: Map<string, Cooldown> = (globalStore.__groqCooldowns ??= new Map());

export function configuredModels(): string[] {
  const list = process.env.GROQ_MODELS?.split(',').map((m) => m.trim()).filter(Boolean);
  const models = list?.length ? list : DEFAULT_MODELS;
  const primary = process.env.GROQ_MODEL?.trim();
  return primary ? [primary, ...models.filter((m) => m !== primary)] : models;
}

// Reasoning models need their thinking kept out of the reply text.
function modelOptions(model: string) {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'medium' as const };
  if (model.startsWith('qwen/')) return { reasoning_format: 'hidden' as const };
  return {};
}

function retryAfterMs(err: InstanceType<typeof Groq.APIError>): number {
  const header = Number(err.headers?.get('retry-after'));
  if (header > 0) return header * 1000;

  // Daily limits carry the wait only in the message, e.g. "Please try again in 10m53.6s".
  const match = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/.exec(err.message);
  if (match && (match[1] || match[2] || match[3])) {
    return ((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000;
  }
  return DEFAULT_COOLDOWN_MS;
}

const errorCode = (err: unknown) => (err as { error?: { error?: { code?: string } } }).error?.error?.code;

function isTransient(err: unknown): boolean {
  if (err instanceof Groq.APIConnectionError) return !(err instanceof Groq.APIUserAbortError);
  return err instanceof Groq.APIError && (err.status ?? 0) >= 500;
}

async function streamCompletion(model: string, messages: ChatCompletionMessageParam[], { allowTools, signal, onText }: CompletionOptions) {
  const stream = await groq().chat.completions.create(
    {
      model,
      messages,
      tools: toolDefinitions,
      tool_choice: allowTools ? 'auto' : 'none',
      temperature: 0.3,
      stream: true,
      ...modelOptions(model),
    },
    { signal },
  );

  let content = '';
  const toolCalls: ChatCompletionMessageToolCall[] = [];

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      onText(delta.content);
    }
    for (const call of delta.tool_calls ?? []) {
      const slot = (toolCalls[call.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.function.name += call.function.name;
      if (call.function?.arguments) slot.function.arguments += call.function.arguments;
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean) };
}

// A malformed tool call (tool_use_failed) or a transient network/5xx error usually succeeds on a second attempt.
async function streamWithRetry(model: string, messages: ChatCompletionMessageParam[], options: CompletionOptions) {
  try {
    return await streamCompletion(model, messages, options);
  } catch (err) {
    if (errorCode(err) !== 'tool_use_failed' && !isTransient(err)) throw err;
    return streamCompletion(model, messages, options);
  }
}

export async function complete(messages: ChatCompletionMessageParam[], options: CompletionOptions) {
  const skipped: Cooldown[] = [];

  for (const model of configuredModels()) {
    const cooldown = cooldowns.get(model);
    if (cooldown && cooldown.until > Date.now()) {
      skipped.push(cooldown);
      continue;
    }

    try {
      return await streamWithRetry(model, messages, options);
    } catch (err) {
      if (!(err instanceof Groq.APIError) || err.status !== 429) throw err;
      const waitMs = retryAfterMs(err);
      const limited = { until: Date.now() + waitMs, daily: /per day/i.test(err.message) };
      cooldowns.set(model, limited);
      skipped.push(limited);
      console.warn(`[llm] ${model} hit its ${limited.daily ? 'daily' : 'per-minute'} limit; skipping it for ${Math.ceil(waitMs / 1000)}s`);
    }
  }

  const soonest = Math.min(...skipped.map((c) => c.until));
  throw new ModelsUnavailableError(skipped.every((c) => c.daily), Math.max(soonest - Date.now(), 0));
}
