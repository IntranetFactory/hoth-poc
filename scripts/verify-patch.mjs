// Unit-level proof the patch works: call the durable-streams stream() with
// live:'sse' and assert the FIRST request URL carries live=sse (held SSE),
// instead of a param-less JSON catch-up read.
import { createRequire } from 'module';
import path from 'path';

// Resolve the exact @durable-streams/client that @flue/sdk (and the frontend
// build) uses, so we test the patched copy.
const require = createRequire(path.resolve('node_modules/.pnpm/@flue+sdk@1.0.0-beta.9/node_modules/@flue/sdk/dist/index.mjs'));
const dsPath = require.resolve('@durable-streams/client');
console.log('durable-streams:', dsPath);
const { stream } = await import('file://' + dsPath.replace(/\\/g, '/'));

const firstUrls = [];
const fakeFetch = async (url) => {
  firstUrls.push(url);
  // Return a minimal SSE response so stream() is happy and we stop.
  return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream', 'stream-next-offset': '0000000000000000_0000000000000000' } });
};

for (const live of ['sse', 'long-poll']) {
  firstUrls.length = 0;
  try {
    await stream({ url: 'https://example.com/agents/x/y?view=updates', offset: '0000000000000000_0000000000000000', live, json: true, fetch: fakeFetch });
  } catch { /* ignore consumption errors — we only care about the first URL */ }
  const first = new URL(firstUrls[0]);
  console.log(`live=${live}: first request live param = ${first.searchParams.get('live') ?? '(none)'}`);
}
