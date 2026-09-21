import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// This server is the only owner of archive/: nothing else reads or writes it,
// so the file naming below is an internal detail nobody else depends on.
// Resolved against this file, never the cwd - a stdio server is spawned by its
// client, whose working directory we do not control.
const ARCHIVE = join(dirname(fileURLToPath(import.meta.url)), 'archive');
const FILENAME = /^feed-(\d{4}-\d{2}-\d{2})\.json$/;
const fileFor = (date) => join(ARCHIVE, `feed-${date}.json`);

// stdout carries the JSON-RPC stream, so every diagnostic goes to stderr.
const log = (msg) => console.error(`[mcp-server] ${msg}`);

// Ascending, so the last entry is the most recent day.
async function archivedDates() {
  let entries;
  try {
    entries = await readdir(ARCHIVE);
  } catch (error) {
    if (error.code === 'ENOENT') return []; // nothing stored yet
    throw error;
  }
  return entries
    .map((name) => FILENAME.exec(name)?.[1])
    .filter(Boolean)
    .sort();
}

async function readArchive(date) {
  return JSON.parse(await readFile(fileFor(date), 'utf8'));
}

const asJson = (uri, value) => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
});

const asText = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

const server = new McpServer(
  { name: 'feed-archive', version: '0.1.0' },
  { capabilities: { resources: {}, tools: {} } },
);

// --- Resources: addressable reads, chosen by the client ----------------------

server.registerResource(
  'latest',
  'feed://latest',
  {
    title: 'Latest archived feed',
    description: 'The most recent feed in the archive, with its topic, generation date and entries.',
    mimeType: 'application/json',
  },
  async (uri) => {
    const dates = await archivedDates();
    if (dates.length === 0) return asJson(uri, { items: [] });
    return asJson(uri, await readArchive(dates.at(-1)));
  },
);

server.registerResource(
  'archive',
  new ResourceTemplate('feed://archive/{date}', {
    // Required even when undefined, so that resource listing is never forgotten
    // by accident. Here it is cheap and genuinely useful: one entry per day.
    list: async () => ({
      resources: (await archivedDates()).map((date) => ({
        uri: `feed://archive/${date}`,
        name: `Feed for ${date}`,
        mimeType: 'application/json',
      })),
    }),
  }),
  {
    title: 'Feed for one day',
    description: 'The feed archived on a specific date (YYYY-MM-DD).',
    mimeType: 'application/json',
  },
  async (uri, { date }) => {
    try {
      return asJson(uri, await readArchive(date));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`no feed archived for ${date}`);
      throw error;
    }
  },
);

// --- Tools: calls whose arguments the caller chooses -------------------------

const FEED_ITEM = z.object({
  headline: z.string(),
  summary: z.string(),
  url: z.string(),
  source: z.string(),
  published_at: z.string(),
  why_it_matters: z.string(),
});

server.registerTool(
  'store_feed',
  {
    title: 'Archive a feed',
    description:
      'Stores a feed in the archive, under the date in generated_at. Repeating the ' +
      'same call changes nothing: entries already present for that day are matched ' +
      'by url and not duplicated.',
    inputSchema: {
      topic: z.string(),
      generated_at: z.string().describe('ISO timestamp; its date decides the archive day'),
      window_hours: z.number(),
      items: z.array(FEED_ITEM),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ topic, generated_at, window_hours, items }) => {
    const date = generated_at.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return asText(`generated_at is not readable as a date: ${generated_at}`, true);
    }

    // Merge instead of overwrite: two runs on the same day are the normal case
    // (the CLI de-duplicates against what is already stored), and overwriting
    // would throw away the earlier run's items.
    await mkdir(ARCHIVE, { recursive: true });
    let existing = { items: [] };
    try {
      existing = await readArchive(date);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const byUrl = new Map(existing.items.map((item) => [item.url, item]));
    let added = 0;
    for (const item of items) {
      if (byUrl.has(item.url)) continue;
      byUrl.set(item.url, item);
      added += 1;
    }

    const stored = {
      topic,
      generated_at,
      window_hours,
      items: [...byUrl.values()].sort((a, b) => b.published_at.localeCompare(a.published_at)),
    };
    await writeFile(fileFor(date), JSON.stringify(stored, null, 2));
    log(`${date}: ${added} new entries, ${stored.items.length} in total`);

    return asText(
      `Archived under ${date}: ${added} new entries out of ${items.length} sent, ` +
        `${stored.items.length} entries in total for that day.`,
    );
  },
);

server.registerTool(
  'search_feed',
  {
    title: 'Search the archived feeds',
    description:
      'Searches the entries of every archived feed. All parameters are optional: ' +
      'with no filters it returns the most recent entries. query and source are ' +
      'case-insensitive partial text matches.',
    inputSchema: {
      query: z.string().optional().describe('text searched in headline, summary and why it matters'),
      from: z.string().optional().describe('earliest publication date, YYYY-MM-DD'),
      to: z.string().optional().describe('latest publication date, YYYY-MM-DD'),
      source: z.string().optional().describe('outlet, partial match allowed'),
      limit: z.number().int().min(1).max(100).optional().describe('default 20'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, from, to, source, limit = 20 }) => {
    let dates = await archivedDates();
    // Only the upper bound can be applied to filenames: an item is published on
    // or before the day it was collected, never after. A lower bound on the
    // filename would wrongly drop items collected later than they were
    // published, which is exactly what a long FEED_WINDOW_HOURS produces.
    if (to) dates = dates.filter((date) => date <= to);

    const needle = query?.toLowerCase();
    const outlet = source?.toLowerCase();
    const hits = [];

    for (const date of dates) {
      const feed = await readArchive(date);
      for (const item of feed.items ?? []) {
        if (from && item.published_at < from) continue;
        if (to && item.published_at > to) continue;
        if (outlet && !item.source.toLowerCase().includes(outlet)) continue;
        if (needle) {
          const haystack = `${item.headline} ${item.summary} ${item.why_it_matters}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        hits.push({ ...item, archived_on: date, topic: feed.topic });
      }
    }

    hits.sort((a, b) => b.published_at.localeCompare(a.published_at));
    const page = hits.slice(0, limit);

    return asText(
      JSON.stringify({ matched: hits.length, returned: page.length, items: page }, null, 2),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`listening on stdio, archive at ${ARCHIVE}`);
