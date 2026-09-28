import Groq from 'groq-sdk';
import { runAgentTurn, type AgentEvent } from '@/lib/agent/loop';
import { deleteSession, getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_MESSAGE_LENGTH = 2000;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

function friendlyError(err: unknown): string {
  if (err instanceof Groq.APIError) {
    if (err.status === 429) return 'I am handling a lot of requests right now. Please try again in a few seconds.';
    if (err.status === 401) return 'The assistant is not configured correctly. Please contact support.';
  }
  return 'Sorry, I could not respond just now. Please try again.';
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const sessionId = body?.sessionId;
  const message = typeof body?.message === 'string' ? body.message.trim() : '';

  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return Response.json({ error: 'Invalid sessionId' }, { status: 400 });
  }
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: `Message must be 1-${MAX_MESSAGE_LENGTH} characters` }, { status: 400 });
  }

  const session = getSession(sessionId);
  if (session.busy) {
    return Response.json({ error: 'A reply is already in progress for this conversation' }, { status: 409 });
  }
  session.busy = true;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Stream already closed because the client disconnected.
        }
      };

      try {
        await runAgentTurn(session, message, emit, request.signal);
      } catch (err) {
        if (!request.signal.aborted) {
          console.error('[chat] turn failed', err);
          emit({ type: 'error', message: friendlyError(err) });
        }
      } finally {
        session.busy = false;
        try {
          controller.close();
        } catch {
          // Already closed by a client disconnect.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function DELETE(request: Request) {
  const sessionId = new URL(request.url).searchParams.get('sessionId');
  if (sessionId && SESSION_ID.test(sessionId)) deleteSession(sessionId);
  return new Response(null, { status: 204 });
}
