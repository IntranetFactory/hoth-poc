#!/usr/bin/env node
/**
 * Hoth Tourism API client.
 *
 * Calls the Hoth tourism API (an HTTP echo endpoint in the POC) with the
 * request details and NO Authorization header — the platform's egress layer
 * injects per-tenant credentials outside this sandbox. Then prints
 * deterministic per-date opening times as JSON.
 *
 * Usage:
 *   node opening-times.js --sites="Echo Base Thermal Springs,Wampa Ridge Spa" --from=2026-08-01 --to=2026-08-03
 *
 * Flags:
 *   --debug-echo   print what the upstream API received (headers) instead of
 *                  opening times; for diagnostics only.
 *
 * Environment:
 *   HOTH_API_URL   override the API endpoint (default: httpbin echo).
 */
'use strict';
// No imports: this file must run as both CommonJS (bare container /workspace)
// and ESM (repo checkouts with "type": "module"), on plain `node`.

// HTTP (not HTTPS) to the echo host: the Cloudflare Sandbox egress proxy
// injects the per-tenant bearer on port 80 in this environment. HTTPS
// interception needs the CA-provisioning base image (recorded caveat); the
// zero-trust property — secret injected at the proxy, never in the sandbox —
// is identical on either port. Override with HOTH_API_URL.
const API_URL = process.env.HOTH_API_URL || 'http://postman-echo.com/post?api=hoth-tourism&query=opening-times';

function parseArgs(argv) {
  const args = { debugEcho: false };
  for (const arg of argv) {
    if (arg === '--debug-echo') args.debugEcho = true;
    else if (arg.startsWith('--sites=')) args.sites = arg.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--from=')) args.from = arg.slice(7);
    else if (arg.startsWith('--to=')) args.to = arg.slice(5);
  }
  return args;
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function snakeCase(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function* dates(from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
    yield d.toISOString().slice(0, 10);
  }
}

/** FNV-1a 32-bit — a tiny deterministic hash with no imports. */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Deterministic synthetic times: same (site, date) always yields the same hours. */
function openingTimesFor(siteId, date) {
  const seed = fnv1a(`${siteId}:${date}`);
  const openHour = 6 + (seed % 4);           // 06:00 - 09:00
  const closeHour = 18 + ((seed >>> 8) % 5); // 18:00 - 22:00
  const pad = (n) => String(n).padStart(2, '0');
  return { date, open: `${pad(openHour)}:00`, close: `${pad(closeHour)}:00` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sites || args.sites.length === 0) fail('--sites is required (comma-separated site names)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from || '')) fail('--from must be YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.to || '')) fail('--to must be YYYY-MM-DD');
  if (args.to < args.from) fail('--to must not be before --from');

  // Authenticated call to the Hoth Tourism API. Note: no Authorization header
  // here — credentials are attached outside this environment.
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'opening-times', sites: args.sites, from: args.from, to: args.to }),
    });
  } catch (err) {
    fail(`Hoth Tourism API unreachable: ${err.message}`);
  }
  if (!response.ok) fail(`Hoth Tourism API returned HTTP ${response.status}`);
  const echo = await response.json();

  if (args.debugEcho) {
    process.stdout.write(JSON.stringify({ status: response.status, upstream_received_headers: echo.headers ?? null }, null, 2) + '\n');
    return;
  }

  const result = args.sites.map((siteName) => {
    const siteId = snakeCase(siteName);
    return {
      site_name: siteName,
      site_id: siteId,
      opening_times: [...dates(args.from, args.to)].map((date) => openingTimesFor(siteId, date)),
    };
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => fail(err.stack || String(err)));
