# feed-archive

A small teaching experiment about the [Anthropic Typescript SDK](https://github.com/anthropics/anthropic-sdk-typescript)
and [MCP](https://modelcontextprotocol.io): an MCP server that owns an archive of
news feeds, and two hand-written clients that reach it — one deterministic, one
agentic. Claude Code is deliberately not used as the client; the clients are in
this repo.

What it exercises, on the SDK side:

- the **`web_search` server tool**, with the `pause_turn` resume loop
- **structured outputs**, `messages.parse()` against a JSON Schema
- the **tool runner**, `beta.messages.toolRunner()`, iterated turn by turn so the
  model's tool choices are visible
- the **MCP helpers**, `@anthropic-ai/sdk/helpers/beta/mcp`, which convert MCP
  tools and results into the API's shapes
- adaptive thinking, typed error classes, and two models picked per job —
  Haiku for the mechanical pass, Sonnet for the one that has to plan

...and on the MCP side: resources, tools, tool annotations, a stdio transport, and
a client that is not a model.

## Setup

```bash
npm install
cp .env.template .env     # then fill in ANTHROPIC_API_KEY
```

## Running

```bash
# Generate a feed on a topic and archive it over MCP.
# The model searches the web and structures the result; the code validates it
# and hands it to the server's store_feed tool.
node index.js
node index.js "quantum computing"
FEED_WINDOW_HOURS=48 FEED_ITEM_COUNT=8 node index.js "AI chips"

# Ask questions about what has been archived. Here the model chooses which
# searches to run, through the read-only tools the server exposes.
node ask.js "which outlets show up most often?"
node ask.js "anything about export controls in the last week?"

# Inspect the server by hand, with no model involved.
npx @modelcontextprotocol/inspector node mcp-server.js
```

<b>Both entry points call the Claude API and spend tokens on every run.</b>

Progress goes to stderr and the result to stdout, so `node ask.js "..." > answer.md` works.

## Everything else

Architecture, the invariant rules that make the exercise worthwhile, the design
decisions already settled, known limitations and next steps: see
[CLAUDE.md](CLAUDE.md).
