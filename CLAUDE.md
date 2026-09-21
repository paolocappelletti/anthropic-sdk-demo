# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A teaching experiment about MCP (Model Context Protocol), built around a news feed
generator. The feed is not the point: the point is having **one MCP server and two
hand-written clients**, in order to understand the protocol from the inside.

Claude Code is deliberately not used as the MCP client: the clients are `index.js`
and `ask.js`, in this repo.

## Commands

```bash
node index.js ["topic"]          # generate a feed and archive it over MCP
node ask.js "a question"         # query the archive with an agent

npx @modelcontextprotocol/inspector node mcp-server.js   # inspect the MCP server by hand
```

There are no tests, no build and no linter. `node --check <file>` is the syntax
check used so far. Both entry points spend tokens on every run: ask before
launching them.

Setup: copy `.env.template` to `.env` and fill in the key. `client.js` resolves
`.env` against its own directory, so it is found whatever the cwd is.

Environment variables, all optional except the credential:

| Variable | |
|---|---|
| `ANTHROPIC_API_KEY` | required; the only one in `.env.template` |
| `FEED_TOPIC` | default `artificial intelligence`; overridden by `node index.js "topic"` |
| `FEED_WINDOW_HOURS` | default 24 |
| `FEED_ITEM_COUNT` | default 5 |

## Architecture

Two branches that do not know about each other. Their only meeting point is the
archive, and it is reachable **only** through the MCP protocol.

```
index.js ──> client.js ──> Anthropic API        web search + structuring
    │
    └──────────────> mcp/session.js ──stdio──> mcp-server.js ──> archive/
                           ^
ask.js ──> mcp/bridge.js ──┘
    │
    └──> client.js ──> Anthropic API            agentic loop
```

| File | Role |
|---|---|
| `client.js` | builds the single Anthropic client; resolves `.env` against the file, not the cwd |
| `index.js` | deterministic CLI: web search → structuring → validation → `store_feed` |
| `mcp-server.js` | MCP server over stdio, **sole owner of `archive/`** |
| `mcp/session.js` | MCP transport and protocol, nothing else |
| `mcp/bridge.js` | exposes MCP tools to a model: filtering, prefixes, signature adaptation |
| `ask.js` | agent: the model picks the calls, driven by the SDK tool runner |

### The two clients are of different kinds

Both use Claude for their own work. The difference is **who decides the MCP
calls**:

| | Talks to Claude | Decides the MCP calls |
|---|---|---|
| `index.js` | yes, search and structuring | the code, with `if` and `await` |
| `ask.js` | yes, agentic loop | the model |

Hence the consequence that holds the whole structure up: **`index.js` uses
`session.js` but not `bridge.js`**. The bridge exists to expose tools *to a model*;
`index.js` exposes nothing to anyone, it just calls.

### Server surface

| Primitive | Name | Notes |
|---|---|---|
| Resource | `feed://latest` | the most recent feed in the archive |
| Resource | `feed://archive/{date}` | template, with a `list` enumerating one day per file |
| Tool | `store_feed` | merges by `url`, does not overwrite; `readOnlyHint: false` |
| Tool | `search_feed` | plain text matching; `readOnlyHint: true` |

MCP prompts and a `list_sources()` were considered and dropped: see "Decisions
already made".

## Invariant rules

They are checkable with a grep, and they are why the exercise is worth anything.
Breaking them turns the project into a bespoke RPC with extra hops.

1. **The server knows nothing about AI.** `mcp-server.js` does not import
   `@anthropic-ai/sdk` and holds no credentials.
2. **The modules under `mcp/` know nothing about the domain.** No strings such as
   `feed`, `store_feed`, `topic`, `feed://`. Tool names are discovered at runtime
   from `listTools()`, and filters look at annotations. `index.js` and `ask.js` are
   applications: those names belong there.
3. **Nobody touches `archive/` except over MCP.** That includes `index.js`, which
   is what fills it.
4. **No `console.log` in the server.** stdout is the JSON-RPC channel; diagnostics
   go to stderr. The same holds in `index.js` and `ask.js`, where stdout carries
   the result and stderr the progress log.

Two design criteria not to break:

- moving the server to HTTP must touch **only** `mcp/session.js`;
- switching to the `mcp_servers` connector must mean **deleting** `bridge.js` and
  changing a few lines of `ask.js`. If `ask.js` had to be rewritten, the bridge is
  leaky.

## Decisions already made (do not revisit without reason)

- **`mcp_servers` (the Messages API MCP connector) is unusable here.** It makes
  Anthropic's servers open the connection, and they can only reach public URLs: it
  cannot talk to a local stdio process.
- **Schema and result conversion is not hand-written.** The TypeScript SDK ships
  `@anthropic-ai/sdk/helpers/beta/mcp` (`mcpTool`, `mcpTools`, `mcpMessage`,
  `mcpResourceToContent`), which also covers `image`, `audio`, `resource` and
  `resource_link` blocks. `bridge.js` delegates to `mcpTools()`.
- **Tool filtering is fail closed:** only `readOnlyHint === true` passes. A tool
  that annotates nothing stays hidden — "unknown" is not "safe". That is how
  `store_feed` never reaches the agent.
- **`store_feed` merges by `url` instead of overwriting.** Two runs on the same day
  are the normal case, and the CLI de-duplicates against the archive itself.
- **`search_feed` filters filenames on the upper bound only.** An entry can be
  published before the day it was collected, so a lower bound on filenames would
  drop valid results.
- **The model never writes URLs.** It returns a `source_id` indexing the list of
  sources found by `web_search`; `index.js` resolves the URL. It used to append
  invented suffixes to URLs.
- **Dates in the prompts are absolute.** `TODAY` and `SINCE` derive from the same
  constant the filter uses, so prompt and validation cannot drift apart.
- **`index.js` stays on `claude-haiku-4-5`** (mechanical work against a fixed
  template); `ask.js` uses `claude-sonnet-5` (it has to plan tool calls).
- **Everything is in English** — comments, prompts, log lines, docs. The feed
  therefore comes back in English, from English-language outlets. To get a
  different language, say so explicitly in the two prompts in `index.js`; changing
  `FEED_TOPIC` alone is not enough.

## Next steps

None started. In order of interest.

### `generate_feed`: the tool with real side effects

Expose feed generation as an MCP tool. It takes about a minute, spends tokens, and
unlike `store_feed` it decides for itself what to write. This is where MCP stops
being plumbing: per-turn approval hooks in the tool runner, topic allow-lists,
repeat suppression, progress notifications against the client's timeout.

Cost: the pipeline would have to be extracted from `index.js` into a shared module,
and the server would take on a dependency on the Anthropic SDK and on credentials —
losing rule 1. Watch out for the cycle: that module must stay a leaf and never
reach back towards MCP.

Reward: `node ask.js "update the feed on AI chips and tell me what changed since
yesterday"` in a single sentence.

### Deployment and the `mcp_servers` connector

Needs a public URL and an `authorization_token`. Conceptually it only moves who
opens the connection, but it creates the credentials problem that does not exist
today, because the server talks to no API at all.

### Several servers behind one agent

That is where the prefixes in `bridge.js` stop being theory.

### Housekeeping

The repo is under git on `main`, with only `CLAUDE.md` committed so far;
everything else is still untracked.

`.gitignore` covers `.env`, `node_modules/` and `archive/`. Two details:
`.env.template` is committed, so there is no blanket `.env*` pattern; and
`archive/` is ignored by choice even though it is **not reproducible** — the news
of a given day cannot be fetched again later, so the working copy is the only one
and nothing backs it up.

A fresh clone therefore starts with no `archive/` at all. That is handled: the
server creates the directory on the first `store_feed`, and until then
`feed://latest` answers `{"items":[]}`, `search_feed` returns zero matches, and
`resources/list` lists only `feed://latest`. Nothing errors on a cold start.

## Known limitations

- `search_feed` is an `includes()` over lowercased strings, so short queries match
  inside longer words. If the agent gets results that are too broad, that is the
  cause, not the bridge.
- `index.js` can finish with no valid entries: that is correct, and it means
  nothing good came out within the window. The knob is `FEED_WINDOW_HOURS`; do not
  loosen the checks in `index.js`.
- `INDEX_PAGE` still matches Italian URL path segments (`argomenti`, `categoria`,
  `sezione`, `ultime`) alongside the English ones. Those match URLs, not prose, and
  cost nothing when unused.
- `web_search_20250305` is the *basic* variant, chosen because Haiku 4.5 does not
  support the programmatic tool calling the `_20260209` variants require.
