import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

// Resolve .env next to this file, not against the cwd: ask.js will spawn the MCP
// server as a child process, and a cwd-relative path would quietly stop finding
// credentials the first time something runs from another directory.
const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

// ANTHROPIC_API_KEY is resolved by the SDK straight from the environment - it is
// deliberately never read here, so the value cannot reach a log line, an error
// message or a prompt through this module.
export const client = new Anthropic({
  // The default is 10 minutes with 2 retries, so a wedged request can hold an
  // unattended job for half an hour. Cap the worst case at ~6 minutes instead.
  timeout: 180_000,
  maxRetries: 1,
});
