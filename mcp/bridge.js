import { mcpTools } from '@anthropic-ai/sdk/helpers/beta/mcp';

// The only file that knows both protocols. Like session.js it must stay free of
// domain terms - no tool name, no resource URI (plan.md, regola 2).
//
// The schema and result conversion itself is NOT hand-written: the Anthropic SDK
// ships it as mcpTools(), and it handles the content shapes a hand-rolled version
// gets wrong first (image, audio, embedded resource, resource_link). What is left
// here is the part no SDK can decide - which tools a model is allowed to see, and
// what they are called once several servers are in play.

// Fail closed: only a tool that explicitly declares itself read-only is exposed.
// A tool with no annotations stays hidden, because "unknown" and "safe" are not
// the same thing - and a server can always be made to say so.
const isReadOnly = (tool) => tool.annotations?.readOnlyHint === true;

const SEPARATOR = '__';

/**
 * Turns the tools a session advertises into tools a model can be handed.
 * `prefix` namespaces them, for when more than one server is connected.
 */
export async function runnableTools(session, { prefix = '' } = {}) {
  const expose = (name) => (prefix ? `${prefix}${SEPARATOR}${name}` : name);
  const strip = (name) =>
    prefix && name.startsWith(`${prefix}${SEPARATOR}`) ? name.slice(prefix.length + SEPARATOR.length) : name;

  const discovered = await session.listTools();
  const allowed = discovered.filter(isReadOnly);
  const hidden = discovered.filter((tool) => !isReadOnly(tool)).map((tool) => tool.name);

  // mcpTools() expects the raw MCP client's callTool({ name, arguments }); the
  // session exposes callTool(name, args). Adapting between the two is exactly
  // this file's job, and it is also where the prefix is undone before the call
  // reaches the server, which never knew about it.
  const adapter = {
    callTool: ({ name, arguments: args }) => session.callTool(strip(name), args),
  };

  return {
    tools: mcpTools(allowed.map((tool) => ({ ...tool, name: expose(tool.name) })), adapter),
    exposed: allowed.map((tool) => expose(tool.name)),
    hidden,
  };
}
