/**
 * Hoth POC UI (plan §10): a chat with an A/B backend dropdown, plus a
 * read-only Data browser over everything the backends persist in Cloudflare.
 *
 * Chat: two FlueClients (base URL fixed at construction) selected via
 * useFlueAgent({ client }). New session mints a lowercase UUID; for B, POST the
 * one-JSON-string bundle and await the 2xx before opening the chat (seeds the
 * bearer mapping and pre-warms the container); for A, POST the provision route.
 *
 * Data browser: a generic collection → record → detail tree with breadcrumbs.
 * Each backend exposes its stores as "collections" via /admin/collections:
 *   - kv        — the raw KV namespace (bundles, bearers, tags, session index)
 *   - sessions  — one record per conversation id (from the session index); the
 *                 detail streams the live conversation held in the Flue agent
 *                 Durable Object (its SQLite message/event tables)
 *   - runs      — the Flue registry's workflow-run index (listRuns/getRun)
 * No id is needed upfront — every level is enumerated from the server.
 *
 * POC caveat (plan §10): the browser as bundle-origin inverts the production
 * trust model — fine for the POC, not the prod seam.
 */
import { useFlueAgent } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';

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
type View = 'chat' | 'data';

const API_KEY_STORAGE = 'hoth-api-key';

export function App() {
  const [view, setView] = useState<View>('chat');
  // API key is entered at runtime (never baked into the build) and persisted
  // locally so it survives reloads. It rides every request as
  // Authorization: Bearer <key> — via the FlueClient `token` for chat + SSE,
  // and via an explicit header on the setup/admin fetches below.
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) ?? '');

  function updateApiKey(value: string) {
    setApiKey(value);
    localStorage.setItem(API_KEY_STORAGE, value);
  }

  return (
    <main>
      <header>
        <h1>Hoth Trip Planner</h1>
        <nav className="tabs">
          <button className={view === 'chat' ? 'tab active' : 'tab'} onClick={() => setView('chat')}>
            Chat
          </button>
          <button className={view === 'data' ? 'tab active' : 'tab'} onClick={() => setView('data')}>
            Data browser
          </button>
        </nav>
        <div className="controls">
          <input
            type="password"
            className="apikey"
            value={apiKey}
            placeholder="API key"
            onChange={(event) => updateApiKey(event.target.value.trim())}
          />
        </div>
        {!apiKey ? <p className="status">Enter your API key to begin.</p> : null}
      </header>
      {view === 'chat' ? (
        <ChatView key={apiKey} apiKey={apiKey} />
      ) : (
        <DataBrowser key={apiKey} apiKey={apiKey} />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function ChatView({ apiKey }: { apiKey: string }) {
  const [backend, setBackend] = useState<BackendKey>('a');
  const [sessionId, setSessionId] = useState<string>();
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'ready' | 'error'>('idle');
  const [detail, setDetail] = useState('');

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
    <>
      <div className="controls">
        <select
          value={backend}
          onChange={(event) => {
            setBackend(event.target.value as BackendKey);
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
        {sessionId ? `session ${sessionId} · ` : ''}
        {detail || (apiKey ? 'Start a new session to chat.' : '')}
      </p>
      {sessionId && phase === 'ready' ? (
        <Chat key={`${backend}:${sessionId}`} client={clients[backend]} sessionId={sessionId} />
      ) : null}
    </>
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
          <Message key={message.id} message={message} />
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

type AgentMessage = ReturnType<typeof useFlueAgent>['messages'][number];

function Message({ message }: { message: AgentMessage }) {
  return (
    <article className={`msg msg-${message.role}`}>
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
  );
}

// ---------------------------------------------------------------------------
// Data browser — generic collection → record → detail tree
// ---------------------------------------------------------------------------

type Collection = { id: string; label: string; kind: string; description?: string };
type RecordRef = { id: string; label: string; group?: string; meta?: unknown };
type RecordList = { records: RecordRef[]; note?: string };

async function adminGet<T>(base: string, apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
  const payload = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

function DataBrowser({ apiKey }: { apiKey: string }) {
  const [backend, setBackend] = useState<BackendKey>('b');
  const [collection, setCollection] = useState<Collection>();
  const [record, setRecord] = useState<RecordRef>();

  const base = BACKENDS[backend].baseUrl;

  // Changing backend resets the drill-down.
  useEffect(() => {
    setCollection(undefined);
    setRecord(undefined);
  }, [backend]);

  return (
    <section className="browser">
      <div className="controls">
        <select value={backend} onChange={(event) => setBackend(event.target.value as BackendKey)}>
          {Object.entries(BACKENDS).map(([key, value]) => (
            <option key={key} value={key}>
              {value.label}
            </option>
          ))}
        </select>
      </div>

      <nav className="crumbs" aria-label="Breadcrumb">
        <button
          className="crumb"
          onClick={() => {
            setCollection(undefined);
            setRecord(undefined);
          }}
        >
          {BACKENDS[backend].label.split(' — ')[0]}
        </button>
        {collection ? (
          <>
            <span className="crumb-sep">›</span>
            <button className="crumb" onClick={() => setRecord(undefined)}>
              {collection.label}
            </button>
          </>
        ) : null}
        {record ? (
          <>
            <span className="crumb-sep">›</span>
            <span className="crumb current">{record.label}</span>
          </>
        ) : null}
      </nav>

      {!apiKey ? (
        <p className="status">Enter your API key to browse data.</p>
      ) : !collection ? (
        <CollectionList base={base} apiKey={apiKey} onOpen={setCollection} />
      ) : !record ? (
        <RecordsList base={base} apiKey={apiKey} collection={collection} onOpen={setRecord} />
      ) : (
        <RecordDetail base={base} apiKey={apiKey} backend={backend} collection={collection} record={record} />
      )}
    </section>
  );
}

function CollectionList({ base, apiKey, onOpen }: { base: string; apiKey: string; onOpen: (c: Collection) => void }) {
  const [state, setState] = useState<{ collections?: Collection[]; error?: string; loading: boolean }>({ loading: true });

  const load = useCallback(() => {
    setState({ loading: true });
    adminGet<{ collections: Collection[] }>(base, apiKey, '/admin/collections')
      .then((r) => setState({ collections: r.collections, loading: false }))
      .catch((err) => setState({ error: String(err), loading: false }));
  }, [base, apiKey]);

  useEffect(() => load(), [load]);

  if (state.loading) return <p className="status">loading…</p>;
  if (state.error) return <p className="status status-error">{state.error}</p>;
  return (
    <div className="cards">
      {state.collections?.map((c) => (
        <button key={c.id} className="card" onClick={() => onOpen(c)}>
          <span className="card-title">{c.label}</span>
          {c.description ? <span className="card-desc">{c.description}</span> : null}
          <span className="card-open">Open ›</span>
        </button>
      ))}
    </div>
  );
}

function RecordsList({
  base,
  apiKey,
  collection,
  onOpen,
}: {
  base: string;
  apiKey: string;
  collection: Collection;
  onOpen: (r: RecordRef) => void;
}) {
  const [state, setState] = useState<{ data?: RecordList; error?: string; loading: boolean }>({ loading: true });

  const load = useCallback(() => {
    setState({ loading: true });
    adminGet<RecordList>(base, apiKey, `/admin/collections/${collection.id}/records`)
      .then((data) => setState({ data, loading: false }))
      .catch((err) => setState({ error: String(err), loading: false }));
  }, [base, apiKey, collection.id]);

  useEffect(() => load(), [load]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, RecordRef[]>();
    for (const r of state.data?.records ?? []) {
      const key = r.group ?? '';
      const arr = byGroup.get(key) ?? [];
      arr.push(r);
      byGroup.set(key, arr);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [state.data]);

  if (state.loading) return <p className="status">loading…</p>;
  if (state.error) return <p className="status status-error">{state.error}</p>;

  const total = state.data?.records.length ?? 0;
  return (
    <div>
      <div className="controls">
        <button onClick={() => load()}>Refresh</button>
        <span className="status">
          {total} record{total === 1 ? '' : 's'}
        </span>
      </div>
      {state.data?.note ? <p className="status">{state.data.note}</p> : null}
      <div className="keylist">
        {groups.map(([group, records]) => (
          <div key={group || '_'} className="keygroup">
            {group ? (
              <div className="keygroup-head">
                {group} <span className="count">{records.length}</span>
              </div>
            ) : null}
            {records.map((r) => (
              <button key={r.id} className="keyrow" onClick={() => onOpen(r)} title={r.id}>
                <span className="keyrow-label">{group ? r.label.replace(`${group}:`, '') || r.label : r.label}</span>
                <span className="keyrow-open">›</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

type Detail =
  | { kind: 'kv'; key: string; value: string; size: number; json: unknown }
  | { kind: 'session'; id: string; session: Record<string, unknown> }
  | { kind: 'run'; id: string; run: unknown }
  | Record<string, unknown>;

function RecordDetail({
  base,
  apiKey,
  backend,
  collection,
  record,
}: {
  base: string;
  apiKey: string;
  backend: BackendKey;
  collection: Collection;
  record: RecordRef;
}) {
  const [state, setState] = useState<{ detail?: Detail; error?: string; loading: boolean }>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    adminGet<Detail>(base, apiKey, `/admin/collections/${collection.id}/record?id=${encodeURIComponent(record.id)}`)
      .then((detail) => !cancelled && setState({ detail, loading: false }))
      .catch((err) => !cancelled && setState({ error: String(err), loading: false }));
    return () => {
      cancelled = true;
    };
  }, [base, apiKey, collection.id, record.id]);

  if (state.loading) return <div className="detail"><p className="status">loading…</p></div>;
  if (state.error) return <div className="detail"><p className="status status-error">{state.error}</p></div>;

  const detail = state.detail as Detail;
  return (
    <div className="detail">
      <div className="detail-head">
        <code className="detail-key">{record.id}</code>
        {'size' in detail && typeof detail.size === 'number' ? <span className="status">{detail.size} bytes</span> : null}
      </div>
      {detail.kind === 'kv' ? (
        <KvValue value={(detail as { value: string }).value} json={(detail as { json: unknown }).json} />
      ) : detail.kind === 'session' ? (
        <SessionDetail base={base} apiKey={apiKey} backend={backend} session={(detail as { session: Record<string, unknown> }).session} sessionId={record.id} />
      ) : detail.kind === 'run' ? (
        <pre className="value">{JSON.stringify((detail as { run: unknown }).run, null, 2)}</pre>
      ) : (
        <pre className="value">{JSON.stringify(detail, null, 2)}</pre>
      )}
    </div>
  );
}

function KvValue({ value, json }: { value: string; json: unknown }) {
  const bundle = asBundle(json);
  if (bundle) return <BundleView bundle={bundle} />;
  if (json !== null && json !== undefined) return <pre className="value">{JSON.stringify(json, null, 2)}</pre>;
  return <pre className="value">{value}</pre>;
}

function SessionDetail({
  base,
  apiKey,
  backend,
  session,
  sessionId,
}: {
  base: string;
  apiKey: string;
  backend: BackendKey;
  session: Record<string, unknown>;
  sessionId: string;
}) {
  return (
    <div>
      <dl className="meta">
        {Object.entries(session).map(([k, v]) => (
          <div key={k} className="meta-row">
            <dt>{k}</dt>
            <dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
      <h3 className="subhead">Conversation (live, from the agent Durable Object)</h3>
      <ConversationView base={base} apiKey={apiKey} backend={backend} sessionId={sessionId} />
    </div>
  );
}

/** Reads the stored conversation (Flue agent DO SQLite) for a session id. */
function ConversationView({ base, apiKey, sessionId }: { base: string; apiKey: string; backend: BackendKey; sessionId: string }) {
  const client = useMemo(() => createFlueClient({ baseUrl: base, token: apiKey }), [base, apiKey]);
  // Read-only catch-up: 'long-poll' reaches the stored state without holding the
  // SSE stream open (no live generation to follow when browsing).
  const agent = useFlueAgent({ name: 'hoth', id: sessionId, client, live: 'long-poll' });

  if (agent.messages.length === 0) {
    return <p className="status">No messages stored for this conversation ({agent.status}).</p>;
  }
  return (
    <div className="messages messages-read">
      {agent.messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
    </div>
  );
}

type Bundle = { skillName: string; version: string; baseImage: string; files: Record<string, string> };

function asBundle(json: unknown): Bundle | null {
  if (!json || typeof json !== 'object') return null;
  const b = json as Record<string, unknown>;
  if (typeof b.skillName === 'string' && typeof b.version === 'string' && b.files && typeof b.files === 'object') {
    return b as Bundle;
  }
  return null;
}

function BundleView({ bundle }: { bundle: Bundle }) {
  const files = Object.entries(bundle.files);
  const [open, setOpen] = useState<string>(files[0]?.[0]);
  return (
    <div className="bundle">
      <dl className="meta">
        <div className="meta-row">
          <dt>skill</dt>
          <dd>
            <code>{bundle.skillName}</code>@<code>{bundle.version}</code>
          </dd>
        </div>
        <div className="meta-row">
          <dt>baseImage</dt>
          <dd>
            <code>{bundle.baseImage}</code>
          </dd>
        </div>
        <div className="meta-row">
          <dt>files</dt>
          <dd>{files.length}</dd>
        </div>
      </dl>
      <div className="filelist">
        {files.map(([path]) => (
          <button
            key={path}
            className={open === path ? 'keyrow active' : 'keyrow'}
            onClick={() => setOpen(path)}
            title={path}
          >
            <span className="keyrow-label">{path}</span>
            <span className="count">{bundle.files[path].length}</span>
          </button>
        ))}
      </div>
      {open ? <pre className="value">{bundle.files[open]}</pre> : null}
    </div>
  );
}
