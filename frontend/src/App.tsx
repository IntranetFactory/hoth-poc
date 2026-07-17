/**
 * Hoth POC UI (plan §10): one chat, a New-session button, and an A/B backend
 * dropdown. Two FlueClients (base URL fixed at construction) selected via
 * useFlueAgent({ client }).
 *
 * New session: mint a lowercase UUID; for B, POST the one-JSON-string bundle
 * and await the 2xx before opening the chat (this also seeds the bearer
 * mapping and pre-warms the container); for A, POST the provision route.
 *
 * POC caveat (plan §10): the browser as bundle-origin inverts the production
 * trust model — fine for the POC, not the prod seam.
 */
import { useFlueAgent } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { useMemo, useState } from 'react';

import hothBundle from './generated/hoth-bundle.json';

const BACKENDS = {
  a: {
    label: 'Backend A — image-baked skill (OOTB)',
    baseUrl: import.meta.env.VITE_BACKEND_A_URL ?? 'http://localhost:3583',
  },
  b: {
    label: 'Backend B — dynamic bundle',
    baseUrl: import.meta.env.VITE_BACKEND_B_URL ?? 'http://localhost:3584',
  },
} as const;

type BackendKey = keyof typeof BACKENDS;

const API_KEY_STORAGE = 'hoth-api-key';

export function App() {
  const [backend, setBackend] = useState<BackendKey>('a');
  const [sessionId, setSessionId] = useState<string>();
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'ready' | 'error'>('idle');
  const [detail, setDetail] = useState('');
  // API key is entered at runtime (never baked into the build) and persisted
  // locally so it survives reloads. It rides every request as
  // Authorization: Bearer <key> — via the FlueClient `token` for chat + SSE,
  // and via an explicit header on the session-setup fetches below.
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) ?? '');

  function updateApiKey(value: string) {
    setApiKey(value);
    localStorage.setItem(API_KEY_STORAGE, value);
    // Changing the key invalidates the current session's clients/stream.
    setSessionId(undefined);
    setPhase('idle');
    setDetail('');
  }

  const clients = useMemo(
    () => ({
      a: createFlueClient({ baseUrl: BACKENDS.a.baseUrl, token: apiKey }),
      b: createFlueClient({ baseUrl: BACKENDS.b.baseUrl, token: apiKey }),
    }),
    [apiKey],
  );

  async function newSession(nextBackend: BackendKey) {
    const id = crypto.randomUUID();
    setPhase('preparing');
    setSessionId(undefined);
    setDetail('provisioning session…');
    try {
      const base = BACKENDS[nextBackend].baseUrl;
      const url =
        nextBackend === 'b'
          ? `${base}/sessions/${id}/skills`
          : `${base}/sessions/${id}/provision`;
      const body =
        nextBackend === 'b'
          ? JSON.stringify({ bundle: hothBundle, tenantTag: `tenant-${id.slice(0, 8)}` })
          : '{}';
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
      setSessionId(id);
      setPhase('ready');
      setDetail(
        nextBackend === 'b'
          ? `bundle ${payload.skillName}@${payload.version} → ${payload.reconstructed ? 'reconstructed' : 'already present'}; tag ${payload.tenantTag}`
          : 'static provision OK',
      );
    } catch (err) {
      setPhase('error');
      setDetail(String(err));
    }
  }

  return (
    <main>
      <header>
        <h1>Hoth Trip Planner</h1>
        <div className="controls">
          <input
            type="password"
            className="apikey"
            value={apiKey}
            placeholder="API key"
            onChange={(event) => updateApiKey(event.target.value.trim())}
          />
          <select
            value={backend}
            onChange={(event) => {
              const next = event.target.value as BackendKey;
              setBackend(next);
              setSessionId(undefined);
              setPhase('idle');
              setDetail('');
            }}
          >
            {Object.entries(BACKENDS).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
              </option>
            ))}
          </select>
          <button onClick={() => newSession(backend)} disabled={phase === 'preparing' || !apiKey}>
            {phase === 'preparing' ? 'Preparing…' : 'New session'}
          </button>
        </div>
        <p className={`status status-${phase}`}>
          {!apiKey ? 'Enter your API key to begin. ' : ''}
          {sessionId ? `session ${sessionId} · ` : ''}
          {detail || (apiKey ? 'Start a new session to chat.' : '')}
        </p>
      </header>
      {sessionId && phase === 'ready' ? (
        <Chat key={`${backend}:${sessionId}`} client={clients[backend]} sessionId={sessionId} />
      ) : null}
    </main>
  );
}

function Chat({ client, sessionId }: { client: ReturnType<typeof createFlueClient>; sessionId: string }) {
  const [input, setInput] = useState('');
  // live: 'sse' — ONE held connection streams both idle and active generation.
  // Requires the @durable-streams/client patch (patches/): stock beta only
  // opens SSE after reaching up-to-date, so it busy-polls catch-up reads while
  // an agent is generating (never up-to-date) — a request flood. The patch
  // sends live=sse on the first request so the held stream opens immediately.
  const agent = useFlueAgent({ name: 'hoth', id: sessionId, client, live: 'sse' });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;
    setInput('');
    await agent.sendMessage(message);
  }

  return (
    <section className="chat">
      <div className="messages" aria-live="polite">
        {agent.messages.map((message) => (
          <article key={message.id} className={`msg msg-${message.role}`}>
            <strong>{message.role}</strong>
            {message.parts.map((part, index) =>
              part.type === 'text' ? (
                <p key={index}>{part.text}</p>
              ) : part.type === 'dynamic-tool' ? (
                <details key={index} className="tool">
                  <summary>tool: {'toolName' in part ? String(part.toolName) : 'call'}</summary>
                  <pre>{JSON.stringify(part, null, 2)}</pre>
                </details>
              ) : null,
            )}
          </article>
        ))}
      </div>
      <form onSubmit={submit}>
        <input
          value={input}
          placeholder='Try: "Plan me a spa day in the Echo Basin, Aug 1-3 2026"'
          onChange={(event) => setInput(event.target.value)}
        />
        <button disabled={!input.trim()} type="submit">
          Send
        </button>
      </form>
      <p className="status">stream: {agent.status}</p>
    </section>
  );
}
