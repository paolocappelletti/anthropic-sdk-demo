import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The MCP half of the client, and nothing else: this file knows how to reach a
// server and speak the protocol, never what any particular server is for. No
// tool name, resource URI or domain term belongs here - see plan.md, regola 2.
//
// It is also the only file that knows the transport is stdio. Moving the server
// behind HTTP means swapping the transport below and changing nothing else.
export async function openSession({ command, args = [], name = 'mcp-client', version = '0.1.0' }) {
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name, version });
  await client.connect(transport);

  return {
    async listTools() {
      return (await client.listTools()).tools;
    },

    async listResources() {
      return (await client.listResources()).resources;
    },

    // Returned as-is, including `isError`. Whether a failed tool call should
    // throw is a caller's policy: a CLI wants an exception, an agent wants the
    // error handed back to the model as a tool result.
    async callTool(toolName, args = {}) {
      return client.callTool({ name: toolName, arguments: args });
    },

    async readResource(uri) {
      return (await client.readResource({ uri })).contents;
    },

    async close() {
      await client.close();
    },
  };
}

// Content blocks carry text, images or embedded resources; joining the text ones
// is the shape every caller needs first. Protocol-level, so it lives here.
export const textOf = (blocks) =>
  (blocks ?? [])
    .filter((block) => typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
