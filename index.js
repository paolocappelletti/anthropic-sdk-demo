import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
// Anthropic stays imported for its typed error classes below; the client itself
// is built once in client.js, so ask.js gets the same timeouts and credentials.
import { client } from './client.js';
import { openSession, textOf as mcpText } from './mcp/session.js';

const TOPIC = process.argv[2] ?? process.env.FEED_TOPIC ?? 'artificial intelligence';
const WINDOW_HOURS = Number(process.env.FEED_WINDOW_HOURS ?? 24);
const ITEM_COUNT = Number(process.env.FEED_ITEM_COUNT ?? 5);
const MODEL = 'claude-haiku-4-5';

// The archive belongs to the MCP server; this process reaches it only through
// the protocol, never through the filesystem. Path resolved against this file,
// since the server is spawned as a child and inherits our cwd, whatever it is.
const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'mcp-server.js');

// The model has no reliable sense of "now", so "the last 24 hours" alone gets
// read against whatever date it assumes - a run on the 21st came back with items
// from the 18th. Both prompts get the interval spelled out in absolute dates.
const MAX_AGE_DAYS = Math.ceil(WINDOW_HOURS / 24);
const asDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const TODAY = asDate(Date.now());
const SINCE = asDate(Date.now() - MAX_AGE_DAYS * 86_400_000);

const started = Date.now();
// Progress goes to stderr so stdout stays pipeable. Web search takes ~a minute
// and silence is indistinguishable from a hang.
const log = (msg) => console.error(`[${String((Date.now() - started) / 1000).padStart(5)}s] ${msg}`);

// Structured outputs reject minItems/maxLength and friends, so the item count is
// enforced in the prompt and re-checked below rather than in the schema.
const FEED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        // published_at earns its place: an index or tag page has no single
        // publication date, so demanding one makes those awkward to include.
        required: ['headline', 'summary', 'source_id', 'source', 'published_at', 'why_it_matters'],
        properties: {
          headline: { type: 'string' },
          summary: { type: 'string' },
          // The URL is looked up from source_id rather than copied by the model.
          // Asked to reproduce URLs, it appended a stray "/sourice_url" to three
          // of five on a real run; a wrong index at worst points at the wrong
          // real article, never at one that does not exist.
          source_id: { type: 'integer' },
          source: { type: 'string' },
          published_at: { type: 'string', format: 'date' },
          why_it_matters: { type: 'string' },
        },
      },
    },
  },
};

// Section fronts and tag pages are what a generic topic search returns most of;
// they are never a news item. Cheap to spot by shape, so spot them here rather
// than trusting the prompt alone. The Italian path segments are kept alongside
// the English ones: these match URLs, not prose, and cost nothing when unused.
const INDEX_PAGE = /\/(tag|tags|argomenti|topic|topics|categoria|category|sezione|news|ultime)\/?$|\/(tag|tags|argomenti|topic|topics|categoria|category)\//i;

const textOf = (message) =>
  message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

// A web_search_tool_result carries a LIST of results on success and a single
// error OBJECT on failure - both with HTTP 200, so nothing throws. Branch on the
// shape or an unattended run silently produces a feed from zero sources.
function citedSources(message) {
  const sources = [];
  for (const block of message.content) {
    if (block.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) {
      log(`web_search failed: ${block.content?.error_code ?? 'unknown'}`);
      continue;
    }
    for (const result of block.content) {
      sources.push({ title: result.title, url: result.url });
    }
  }
  return sources;
}

// Headlines already archived, so the model can skip them on this run. Reading
// them is a resource fetch, not a file read: the client asks for a URI and the
// server decides what that means. A failure here is not worth aborting a run
// over - worst case the feed repeats an item.
async function previousHeadlines(session) {
  try {
    const contents = await session.readResource('feed://latest');
    return (JSON.parse(mcpText(contents)).items ?? []).map((item) => item.headline);
  } catch (error) {
    log(`feed://latest unreadable (${error.message}) - continuing without de-duplication`);
    return [];
  }
}

// Step 1: research. web_search is a server tool - it runs inside this request,
// so there is no tool loop to write. The server-side sampling loop does stop at
// 10 iterations with stop_reason "pause_turn"; resume by resending the turn
// unchanged (an extra "continue" message would break the resume).
//
// Basic variant on purpose: web_search_20260209 does its dynamic filtering via
// code execution, so it needs programmatic tool calling, which Haiku 4.5 lacks
// (400). The _20260209 variants want Opus 4.6+ / Sonnet 4.6+; on this model the
// _20250305 one is the documented choice. Same params, same result blocks.
async function research(seen) {
  const messages = [
    {
      role: 'user',
      content:
        `Today is ${TODAY}. Find the most important news about "${TOPIC}" published ` +
        `in the last ${WINDOW_HOURS} hours, that is between ${SINCE} and ${TODAY} ` +
        `inclusive. Anything published before ${SINCE} is not wanted: discard it.\n\n` +
        // Without this, a single generic query on the topic returns the section
        // fronts of news sites and the run produces a feed of landing pages.
        `Do not run one generic query on the topic: run several targeted searches ` +
        `on specific, recent facts (announcements, releases, deals, funding rounds, ` +
        `rulings, results, incidents), putting the date in the query.\n\n` +
        `Every story must be A SINGLE ARTICLE reporting ONE SPECIFIC FACT that ` +
        `happened inside the time window. Discard tag, category and section pages, ` +
        `round-ups and "everything about...": those are indexes, not news. If the ` +
        `headline does not say what happened, it is not a news item.\n\n` +
        `For each one report: article headline, outlet, direct URL to the article, ` +
        `publication date, what happened, why it matters. At least ${ITEM_COUNT} ` +
        `valid stories are needed.` +
        (seen.length ? `\n\nAlready published, exclude these:\n- ${seen.join('\n- ')}` : ''),
    },
  ];

  let response;
  for (let attempt = 0; attempt < 5; attempt++) {
    log(attempt === 0 ? 'web search in progress...' : `resuming search (${attempt}/4)...`);
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      messages,
    });
    if (response.stop_reason !== 'pause_turn') return response;
    messages.push({ role: 'assistant', content: response.content });
  }

  log('search still paused after 5 resumes - using the partial results');
  return response;
}

// Step 2: shape it. No tools here on purpose - output_config.format returns a 400
// alongside citations, and search results are what carry them.
async function structure(notes, sources) {
  log('structuring the feed...');
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    messages: [
      {
        role: 'user',
        content:
          `Format this news about "${TOPIC}" as a feed of ${ITEM_COUNT} entries, ` +
          `most important first. Importance criteria, in order: concrete impact, ` +
          `novelty of the fact, authority of the source.\n\n` +
          `Do not write URLs: for each entry put in source_id the number in square ` +
          `brackets of the matching source in the list below.\n\n` +
          `Include only single articles about specific facts published between ` +
          `${SINCE} and ${TODAY}: discard tag, category and round-up pages, and ` +
          `anything earlier than ${SINCE}. Fewer entries is better than entries ` +
          `that are not news.\n\n` +
          `## Research\n${notes}\n\n` +
          `## Sources found\n${sources.map((s, i) => `[${i}] ${s.title} - ${s.url}`).join('\n')}`,
      },
    ],
    output_config: { format: jsonSchemaOutputFormat(FEED_SCHEMA) },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`refused: ${response.stop_details?.explanation ?? 'no details'}`);
  }
  // Invalid JSON throws inside the SDK; parsed_output is null when the response
  // carried no text block at all (max_tokens before any output, say). Different
  // failure, same need to stop rather than write an empty feed.
  if (!response.parsed_output) throw new Error('no structured content in the response');
  return response.parsed_output;
}

// Spawning the server is the first thing and closing it the last: an aborted run
// must not leave a child process behind.
const session = await openSession({ command: process.execPath, args: [SERVER_PATH], name: 'feed-cli' });

try {
  const seen = await previousHeadlines(session);
  const notes = await research(seen);
  const sources = citedSources(notes);
  log(`${sources.length} sources collected`);

  if (sources.length === 0) throw new Error('no sources found - feed not updated');

  const { items } = await structure(textOf(notes), sources);

  // Three things the model fails silently and repeatedly: inventing a URL,
  // passing off a section front as a story, and ignoring the time window (it
  // returned three-week-old items for a 24h window). Each is cheap to check
  // here and unreliable to ask for in the prompt.
  // published_at is a date, so compare whole days: a 24h window accepts today
  // and yesterday.
  const ageInDays = (iso) => (Date.now() - Date.parse(`${iso}T23:59:59Z`)) / 86_400_000;

  // The URL is resolved here, from the index the model returned - so an item
  // either carries a URL that web_search actually produced, or it is dropped.
  const clean = [];
  for (const item of items) {
    const source = sources[item.source_id];
    if (!source) {
      log(`dropped (source ${item.source_id} does not exist): ${item.headline}`);
      continue;
    }
    if (INDEX_PAGE.test(source.url)) {
      log(`dropped (index page): ${source.url}`);
      continue;
    }
    const age = ageInDays(item.published_at);
    if (!Number.isFinite(age)) {
      log(`dropped (unreadable date): ${item.published_at}`);
      continue;
    }
    if (age > MAX_AGE_DAYS) {
      log(`dropped (${item.published_at}, outside the window): ${item.headline}`);
      continue;
    }
    const { source_id, ...rest } = item;
    clean.push({ ...rest, url: source.url });
  }

  if (clean.length === 0) throw new Error('no valid entries - feed not updated');
  if (clean.length !== ITEM_COUNT) log(`expected ${ITEM_COUNT} entries, ${clean.length} valid`);

  // topic and timestamp come from here, not from the model - no reason to let it
  // guess values the process already knows. Where the feed physically lands, and
  // under what name, is the server's business.
  const stored = await session.callTool('store_feed', {
    topic: TOPIC,
    generated_at: new Date().toISOString(),
    window_hours: WINDOW_HOURS,
    items: clean,
  });
  // session.callTool hands back `isError` rather than throwing, so the policy is
  // decided here: for a CLI, a failed store means the run failed.
  if (stored.isError) throw new Error(`store_feed failed: ${mcpText(stored.content)}`);
  log(mcpText(stored.content));
} catch (error) {
  if (error instanceof Anthropic.AuthenticationError) {
    console.error('Authentication failed - check ANTHROPIC_API_KEY in .env');
  } else if (error instanceof Anthropic.RateLimitError) {
    // An unattended job can just wait for the next tick.
    console.error('Rate limited - retry later');
  } else if (error instanceof Anthropic.APIError) {
    console.error(`API error ${error.status}: ${error.message}`);
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
} finally {
  // Closing the session kills the server child process; without this the CLI
  // would hang on an otherwise finished run.
  await session.close();
}
