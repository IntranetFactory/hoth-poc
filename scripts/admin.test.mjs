#!/usr/bin/env node
/**
 * Data-browser (admin) unit tests — the host-agnostic collection model in
 * @hoth/core, exercised with an in-memory KV and injected run-registry deps.
 * Zero Cloudflare/Flue present, so this runs anywhere `node` does.
 *
 * Covers: KV listing (cursor pagination + grouping + sort), value reads
 * (JSON vs opaque vs missing), the session index round-trip, and the generic
 * collection resolvers (kv / sessions / runs, including empty + failure notes).
 */
import {
  listKvEntries,
  readKvEntry,
  kvGroupOf,
  putSessionIndex,
  listSessions,
  readSession,
  removeSessionIndex,
  adminCollections,
  listCollectionRecords,
  readCollectionRecord,
} from '../core/src/admin.js';

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

/**
 * In-memory KV that mimics the Workers KV surface the browser uses: cursor
 * pagination (page size 2, to force multi-page), prefix filtering, TTL-bearing
 * put, get, delete.
 */
function fakeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  const PAGE = 2;
  return {
    _map: map,
    async list(options = {}) {
      const { prefix = '', cursor } = options;
      const all = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + PAGE);
      const next = start + PAGE;
      const complete = next >= all.length;
      return {
        keys: slice.map((name) => ({ name, expiration: map.get(name)?.expiration ?? null })),
        list_complete: complete,
        cursor: complete ? undefined : String(next),
      };
    },
    async get(key) {
      const v = map.get(key);
      return v === undefined ? null : v.value ?? v;
    },
    async put(key, value, opts = {}) {
      map.set(key, { value, expiration: opts.expirationTtl ? 1800000000 : null });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const bundleJson = JSON.stringify({ skillName: 'trip-planner', version: 'v1', baseImage: 'node', files: { 'SKILL.md': '# hi' } });

await (async function run() {
  // --- kvGroupOf ---------------------------------------------------------
  check('kvGroupOf splits on first colon', kvGroupOf('bearer:abc') === 'bearer');
  check('kvGroupOf handles no colon', kvGroupOf('flat') === '(ungrouped)');

  // --- listKvEntries: pagination + grouping + sort -----------------------
  const kv = fakeKv({
    'tag:c2': 'tenant-9f',
    'bearer:c1': 'hoth-bearer-1',
    'bundle:9f8a': bundleJson,
    'bearer:c2': 'hoth-bearer-2',
    'session:9f8a': JSON.stringify({ id: '9f8a', backend: 'b' }),
  });
  const keys = await listKvEntries(kv);
  check('listKvEntries collects all pages', keys.length === 5, `got ${keys.length}`);
  check('listKvEntries sorts by name', keys[0].name === 'bearer:c1' && keys.at(-1).name === 'tag:c2');
  check('listKvEntries assigns groups', keys.find((k) => k.name === 'bundle:9f8a')?.group === 'bundle');

  // --- readKvEntry: json / opaque / missing ------------------------------
  const bundleEntry = await readKvEntry(kv, 'bundle:9f8a');
  check('readKvEntry parses JSON', bundleEntry?.json?.skillName === 'trip-planner');
  check('readKvEntry reports size', bundleEntry?.size === bundleJson.length);
  const bearerEntry = await readKvEntry(kv, 'bearer:c1');
  check('readKvEntry leaves opaque strings unparsed', bearerEntry?.json === null && bearerEntry?.value === 'hoth-bearer-1');
  check('readKvEntry returns null when absent', (await readKvEntry(kv, 'nope')) === null);

  // --- session index round-trip ------------------------------------------
  const skv = fakeKv();
  await putSessionIndex(skv, 'aaaa-1111', { backend: 'b', tenantTag: 'tenant-aa' });
  await putSessionIndex(skv, 'bbbb-2222', { backend: 'a' });
  const sessions = await listSessions(skv);
  check('listSessions enumerates indexed sessions', sessions.length === 2, `got ${sessions.length}`);
  check('listSessions preserves metadata', sessions.find((s) => s.id === 'aaaa-1111')?.tenantTag === 'tenant-aa');
  check('readSession returns one record', (await readSession(skv, 'bbbb-2222'))?.backend === 'a');
  check('putSessionIndex writes under session: prefix', skv._map.has('session:aaaa-1111'));
  await removeSessionIndex(skv, 'aaaa-1111');
  check('removeSessionIndex deletes the record', (await readSession(skv, 'aaaa-1111')) === null);
  check('removeSessionIndex leaves others', (await listSessions(skv)).length === 1);

  // --- collections descriptor --------------------------------------------
  const cols = adminCollections('STORE');
  check('adminCollections exposes kv/sessions/runs', cols.map((c) => c.id).join(',') === 'kv,sessions,runs');
  check('adminCollections labels kv with namespace', cols[0].label.includes('STORE'));

  // --- generic record listing --------------------------------------------
  const fakeRuns = { runs: [{ runId: 'run-1', workflowName: 'nightly', status: 'completed' }] };
  const deps = { kv, listRuns: async () => fakeRuns, getRun: async (id) => (id === 'run-1' ? fakeRuns.runs[0] : null) };

  const kvRecords = await listCollectionRecords('kv', deps);
  check('listCollectionRecords(kv) maps keys to records', kvRecords.records.length === 5);
  const sessRecords = await listCollectionRecords('sessions', deps);
  check('listCollectionRecords(sessions) reads the index', sessRecords.records.some((r) => r.id === '9f8a'));
  const runRecords = await listCollectionRecords('runs', deps);
  check('listCollectionRecords(runs) uses injected listRuns', runRecords.records[0]?.id === 'run-1');
  check('listCollectionRecords(runs) labels status', runRecords.records[0]?.label.includes('completed'));
  check('listCollectionRecords(unknown) returns null', (await listCollectionRecords('nope', deps)) === null);

  // runs: empty note + failure note
  const emptyRuns = await listCollectionRecords('runs', { kv, listRuns: async () => ({ runs: [] }) });
  check('listCollectionRecords(runs) notes empty', !!emptyRuns.note && emptyRuns.records.length === 0);
  const brokenRuns = await listCollectionRecords('runs', {
    kv,
    listRuns: async () => {
      throw new Error('registry down');
    },
  });
  check('listCollectionRecords(runs) survives registry error', brokenRuns.records.length === 0 && brokenRuns.note.includes('registry down'));
  const noRunApi = await listCollectionRecords('runs', { kv });
  check('listCollectionRecords(runs) handles missing run API', noRunApi.records.length === 0 && !!noRunApi.note);

  // --- generic record detail ---------------------------------------------
  const kvDetail = await readCollectionRecord('kv', 'bundle:9f8a', deps);
  check('readCollectionRecord(kv) returns parsed value', kvDetail?.kind === 'kv' && kvDetail?.json?.skillName === 'trip-planner');
  const sessDetail = await readCollectionRecord('sessions', '9f8a', deps);
  check('readCollectionRecord(sessions) returns the session', sessDetail?.kind === 'session' && sessDetail?.session?.backend === 'b');
  const runDetail = await readCollectionRecord('runs', 'run-1', deps);
  check('readCollectionRecord(runs) returns the run', runDetail?.kind === 'run' && runDetail?.run?.workflowName === 'nightly');
  check('readCollectionRecord(kv) missing -> null', (await readCollectionRecord('kv', 'nope', deps)) === null);
  check('readCollectionRecord(runs) missing -> null', (await readCollectionRecord('runs', 'ghost', deps)) === null);
  check('readCollectionRecord(unknown) -> null', (await readCollectionRecord('zzz', 'x', deps)) === null);
})();

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
