'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { AgentEvent } from '@/lib/agent/loop';
import type { Stage } from '@/lib/agent/tools';
import styles from './page.module.css';

interface ToolBadge {
  id: string;
  status: string;
  state: 'running' | 'done' | 'failed';
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: ToolBadge[];
  error?: string;
  retryOf?: string;
}

const STAGES: { key: Stage; label: string }[] = [
  { key: 'new_lead', label: 'New Lead' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'booked', label: 'Booked' },
  { key: 'service', label: 'Service' },
];

const SUGGESTIONS = [
  'What variants does the XUV700 come in?',
  'Is my test drive confirmed? My number is 9876500002',
  'Where is my booking MAH-9921?',
  'Book a service for my car, my number is 9876543201',
];

const newId = () => crypto.randomUUID();

// Minimal formatting for model output: paragraphs, "-" or "1." lists, **bold** and https links.
function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|https:\/\/[^\s)<>]+[^\s)<>.,;:!?])/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{renderInline(part.slice(2, -2))}</strong>;
    if (part.startsWith('https://')) {
      return (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer">
          {part}
        </a>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function FormattedText({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        const isList = lines.length > 0 && lines.every((l) => /^([-*•]|\d+[.)])\s+/.test(l));
        if (isList) {
          const ordered = /^\d/.test(lines[0]);
          const items = lines.map((l, j) => <li key={j}>{renderInline(l.replace(/^([-*•]|\d+[.)])\s+/, ''))}</li>);
          return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        return (
          <p key={i}>
            {lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

async function* readEvents(response: Response): AsyncGenerator<AgentEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, boundary).replace(/^data: /, '');
      buffer = buffer.slice(boundary + 2);
      if (chunk) yield JSON.parse(chunk) as AgentEvent;
    }
  }
}

export default function ChatPage() {
  const [sessionId, setSessionId] = useState(newId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [stage, setStage] = useState<Stage | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const updateMessage = (id: string, update: (m: Message) => Message) =>
    setMessages((all) => all.map((m) => (m.id === id ? update(m) : m)));

  const send = useCallback(
    async (text: string, retryOf?: string) => {
      const message = text.trim();
      if (!message || busy) return;

      const assistantId = newId();
      setMessages((all) => [
        ...all.filter((m) => m.id !== retryOf),
        ...(retryOf ? [] : [{ id: newId(), role: 'user' as const, text: message, tools: [] }]),
        { id: assistantId, role: 'assistant', text: '', tools: [] },
      ]);
      setInput('');
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let breakBeforeText = false;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, message }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error ?? 'The assistant is unavailable right now.');
        }

        for await (const event of readEvents(response)) {
          switch (event.type) {
            case 'stage':
              setStage(event.stage);
              break;
            case 'text': {
              const prefix = breakBeforeText ? '\n\n' : '';
              breakBeforeText = false;
              updateMessage(assistantId, (m) => ({ ...m, text: m.text + (m.text ? prefix : '') + event.delta }));
              break;
            }
            case 'tool_start':
              breakBeforeText = true;
              updateMessage(assistantId, (m) => ({ ...m, tools: [...m.tools, { id: event.id, status: event.status, state: 'running' }] }));
              break;
            case 'tool_end':
              updateMessage(assistantId, (m) => ({
                ...m,
                tools: m.tools.map((t) => (t.id === event.id ? { ...t, state: event.ok ? 'done' : 'failed' } : t)),
              }));
              break;
            case 'error':
              throw new Error(event.message);
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          updateMessage(assistantId, (m) => ({ ...m, error: (err as Error).message, retryOf: message }));
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(false);
          inputRef.current?.focus();
        }
      }
    },
    [busy, sessionId],
  );

  const startNewConversation = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    fetch(`/api/chat?sessionId=${sessionId}`, { method: 'DELETE' }).catch(() => {});
    setSessionId(newId());
    setMessages([]);
    setStage(null);
    setInput('');
    setBusy(false);
    inputRef.current?.focus();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  };

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">DA</span>
          <div>
            <h1>Drive Assist</h1>
            <p>Sales and service for XUV700, Thar and Scorpio-N</p>
          </div>
        </div>
        <button type="button" className={styles.newChat} onClick={startNewConversation}>
          New conversation
        </button>
      </header>

      <nav className={styles.stages} aria-label="Detected customer stage">
        {STAGES.map((s) => (
          <span key={s.key} className={s.key === stage ? styles.stageActive : styles.stage} aria-current={s.key === stage ? 'step' : undefined}>
            {s.label}
          </span>
        ))}
      </nav>

      <div className={styles.messages} ref={listRef} aria-live="polite">
        {messages.length === 0 ? (
          <div className={styles.welcome}>
            <h2>How can we help today?</h2>
            <p>Explore models and prices, check a test drive or booking, or book a service.</p>
            <div className={styles.suggestions}>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? styles.userRow : styles.assistantRow}>
              <div className={m.role === 'user' ? styles.userBubble : styles.assistantBubble}>
                {m.tools.length > 0 && (
                  <div className={styles.tools}>
                    {m.tools.map((t) => (
                      <span key={t.id} className={`${styles.tool} ${styles[t.state]}`}>
                        {t.state === 'running' && <span className={styles.spinner} aria-hidden="true" />}
                        {t.state === 'running' ? `${t.status}...` : t.status}
                      </span>
                    ))}
                  </div>
                )}
                {m.text ? (
                  m.role === 'assistant' ? <FormattedText text={m.text} /> : <p>{m.text}</p>
                ) : (
                  !m.error && m.tools.every((t) => t.state !== 'running') && <span className={styles.typing} aria-label="Assistant is typing" />
                )}
                {m.error && (
                  <div className={styles.error} role="alert">
                    <span>{m.error}</span>
                    <button type="button" onClick={() => send(m.retryOf!, m.id)} disabled={busy}>
                      Retry
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <form className={styles.composer} onSubmit={onSubmit}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type your message..."
          rows={1}
          maxLength={2000}
          aria-label="Message"
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
