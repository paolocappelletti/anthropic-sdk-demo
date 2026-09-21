import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { client } from './client.js';
import { openSession } from './mcp/session.js';
import { runnableTools } from './mcp/bridge.js';

// The agentic counterpart of index.js: same archive, same server, but here the
// model decides which tools to call and how many times. This file knows nothing
// about MCP - it receives tools already translated and hands them to the runner.
const QUESTION = process.argv.slice(2).join(' ').trim();
if (!QUESTION) {
  console.error('usage: node ask.js "a question about the feed archive"');
  process.exit(1);
}

// Unlike index.js, where the model fills a fixed template, here it has to plan
// its own searches - hence a stronger model.
const MODEL = 'claude-sonnet-5';
const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'mcp-server.js');

const started = Date.now();
const log = (msg) => console.error(`[${String((Date.now() - started) / 1000).padStart(5)}s] ${msg}`);

const SYSTEM =
  'Answer questions about an archive of news feeds, using the tools available. ' +
  'Do not answer from memory: the news lives in the archive, and what you cannot find ' +
  'there does not exist. Run several searches with different filters if needed before ' +
  'concluding. Text searches are literal substring matches: a short word can appear ' +
  'inside other words, so inspect the results instead of trusting the count. Always ' +
  'cite the outlet and date of the entries you rely on. If the archive does not hold ' +
  'the answer, say so.';

const session = await openSession({ command: process.execPath, args: [SERVER_PATH], name: 'feed-agent' });

try {
  const { tools, exposed, hidden } = await runnableTools(session);
  log(`tools exposed to the model: ${exposed.join(', ') || 'none'}`);
  if (hidden.length) log(`tools withheld (not declared read-only): ${hidden.join(', ')}`);
  if (tools.length === 0) throw new Error('no usable tools: the model would have nothing to work with');

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    tools,
    messages: [{ role: 'user', content: QUESTION }],
  });

  // Iterating the runner instead of awaiting it: same result, but every turn is
  // visible. Watching which tools the model picks is the whole point of the
  // exercise - awaiting would print only the conclusion.
  let final;
  for await (const message of runner) {
    final = message;
    for (const block of message.content) {
      if (block.type === 'tool_use') log(`${block.name}(${JSON.stringify(block.input)})`);
    }
  }

  if (final?.stop_reason === 'refusal') {
    throw new Error(`refused: ${final.stop_details?.explanation ?? 'no details'}`);
  }

  const answer = (final?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  // The answer is the only thing on stdout, so `node ask.js ... > answer.md`
  // keeps working while the progress log stays on stderr.
  console.log(answer || '(no text answer)');
} catch (error) {
  if (error instanceof Anthropic.AuthenticationError) {
    console.error('Authentication failed - check ANTHROPIC_API_KEY in .env');
  } else if (error instanceof Anthropic.RateLimitError) {
    console.error('Rate limited - retry later');
  } else if (error instanceof Anthropic.APIError) {
    console.error(`API error ${error.status}: ${error.message}`);
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
} finally {
  await session.close();
}
