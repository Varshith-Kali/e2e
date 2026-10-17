import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAgentError } from '../../src/agent/error.ts';
import { createModelAdapter } from '../../src/agent/model/sdk.ts';
import { serializeError } from '../../src/internal/errors.ts';
import { isRetryEligible } from '../../src/run/retry.ts';

let server: Server;
let baseURL: string;

/** A provider that refuses every request: OpenAI's `content_filter` wire reason. */
beforeAll(async () => {
  server = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'scripted',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '' },
              finish_reason: 'content_filter',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function chatModel() {
  return createOpenAICompatible({ name: 'scripted', baseURL }).chatModel('scripted');
}

function adapter() {
  const model = chatModel();
  return createModelAdapter({ provider: model.provider, id: model.modelId, model });
}

function call(schemaName: string, schema: { type: string } | undefined) {
  return {
    system: 's',
    prompt: 'p',
    schemaName,
    schema,
    validate: (value: unknown) => ({ ok: true as const, value }),
    maxOutputTokens: 16,
    maxInputTokens: 64_000,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  };
}

describe('model refusal', () => {
  it('structured call: refusal is MODEL_REFUSED, not MODEL_PROVIDER_FAILED', async () => {
    const error = await adapter()
      .generate(call('agent-extract-2', { type: 'object' }))
      .then(
        () => {
          throw new Error('expected the refused call to throw');
        },
        (cause: unknown) => cause,
      );

    expect(isAgentError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_REFUSED', category: 'configuration' });
    const message = (error as Error).message;
    expect(message).toContain("step 'agent-extract-2'");
    expect(message).toContain("model 'scripted'");
    expect(message).toContain("'content-filter'");
  });

  it('text call: refusal is MODEL_REFUSED, not MODEL_OUTPUT_INVALID', async () => {
    const error = await adapter()
      .generate(call('agent-judgment-2', undefined))
      .then(
        () => {
          throw new Error('expected the refused call to throw');
        },
        (cause: unknown) => cause,
      );

    expect(isAgentError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_REFUSED', category: 'configuration' });
    expect((error as Error).message).toContain("'content-filter'");
  });

  it('a refusal never consumes retry budget', async () => {
    const error = await adapter()
      .generate(call('agent-extract-2', { type: 'object' }))
      .then(
        () => {
          throw new Error('expected the refused call to throw');
        },
        (cause: unknown) => cause,
      );
    if (!isAgentError(error)) throw new Error('expected an AgentError');
    const serialized = serializeError(error);
    expect(serialized.retryable).toBe(false);
    expect(isRetryEligible({ status: 'failed', error: serialized })).toBe(false);
  });
});
