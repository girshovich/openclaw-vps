import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ModelId } from '../types.js';

export { type ModelId };

export const MODEL_CONTEXT_SIZES: Record<ModelId, number> = {
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-6': 200_000,
  'gpt-5.4': 128_000,
  'gpt-5-mini': 128_000,
};

export const DEFAULT_MODEL: ModelId = 'gpt-5.4';
export const SUMMARIZE_MODEL: ModelId = 'gpt-5.4';
export const CLASSIFY_MODEL: ModelId = 'gpt-5-mini';

// ── Message types ─────────────────────────────────────────────────────────────

export type LLMMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LLMResponse =
  | { type: 'text'; text: string; inputTokens: number; outputTokens: number; modelUsed: ModelId }
  | { type: 'tool_calls'; calls: ToolCall[]; text: string; inputTokens: number; outputTokens: number; modelUsed: ModelId };

export interface SimpleResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

// ── Zero-balance callback ─────────────────────────────────────────────────────

type ZeroBalanceHandler = (provider: 'anthropic' | 'openai') => Promise<void>;
let _zeroBalanceHandler: ZeroBalanceHandler | undefined;

export function onZeroBalance(handler: ZeroBalanceHandler): void {
  _zeroBalanceHandler = handler;
}

// ── Client factories ──────────────────────────────────────────────────────────

let _anthropic: Anthropic | undefined;
let _openai: OpenAI | undefined;

function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

export function isAnthropicModel(model: ModelId): boolean {
  return model.startsWith('claude-');
}

function isZeroBalanceError(err: unknown, provider: 'anthropic' | 'openai'): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const status = 'status' in err ? (err as { status: unknown }).status : undefined;
  if (provider === 'anthropic') {
    return (
      status === 402 ||
      msg.includes('credit_balance_too_low') ||
      msg.includes('credit balance is too low') ||
      msg.includes('insufficient_balance')
    );
  }
  return msg.includes('insufficient_quota') || msg.includes('exceeded your current quota');
}

function fallbackModel(model: ModelId): ModelId {
  return isAnthropicModel(model) ? 'gpt-5.4' : 'claude-sonnet-4-6';
}

// ── Message conversion ────────────────────────────────────────────────────────

function toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
      i++;
    } else if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      result.push({ role: 'assistant', content: content.length ? content : msg.content });
      i++;
    } else {
      // Collect consecutive tool results into one user message
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      while (i < messages.length && messages[i]!.role === 'tool') {
        const m = messages[i]! as Extract<LLMMessage, { role: 'tool' }>;
        toolResults.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
        i++;
      }
      result.push({ role: 'user', content: toolResults });
    }
  }
  return result;
}

function toOpenAIMessages(
  messages: LLMMessage[],
  systemPrompt: string | undefined,
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];
  if (systemPrompt !== undefined) result.push({ role: 'system', content: systemPrompt });
  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls?.length) {
        result.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    } else {
      result.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content });
    }
  }
  return result;
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema'],
  }));
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ── Provider calls ────────────────────────────────────────────────────────────

async function callAnthropic(
  messages: LLMMessage[],
  model: ModelId,
  systemPrompt: string | undefined,
  tools: ToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
): Promise<LLMResponse> {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: 8192,
    messages: toAnthropicMessages(messages),
  };
  if (systemPrompt !== undefined) params.system = systemPrompt;
  if (tools?.length) params.tools = toAnthropicTools(tools);

  const response = await getAnthropic().messages.create(params, { signal });
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  if (response.stop_reason === 'tool_use') {
    const calls: ToolCall[] = [];
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        calls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
    }
    return { type: 'tool_calls', calls, text, inputTokens, outputTokens, modelUsed: model };
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { type: 'text', text, inputTokens, outputTokens, modelUsed: model };
}

async function callOpenAI(
  messages: LLMMessage[],
  model: ModelId,
  systemPrompt: string | undefined,
  tools: ToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
): Promise<LLMResponse> {
  const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages: toOpenAIMessages(messages, systemPrompt),
  };
  if (tools?.length) params.tools = toOpenAITools(tools);

  const response = await getOpenAI().chat.completions.create(params, { signal });
  const choice = response.choices[0];
  if (!choice) throw new Error('No choices in OpenAI response');

  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  const rawCalls = choice.message.tool_calls?.filter((tc) => tc.type === 'function');
  if (choice.finish_reason === 'tool_calls' && rawCalls?.length) {
    const calls: ToolCall[] = rawCalls.map((tc) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const f = (tc as any).function as { name: string; arguments: string };
      return { id: tc.id, name: f.name, input: JSON.parse(f.arguments) as Record<string, unknown> };
    });
    return {
      type: 'tool_calls',
      calls,
      text: choice.message.content ?? '',
      inputTokens,
      outputTokens,
      modelUsed: model,
    };
  }

  return { type: 'text', text: choice.message.content ?? '', inputTokens, outputTokens, modelUsed: model };
}

async function withFallback(
  fn: (m: ModelId) => Promise<LLMResponse>,
  model: ModelId,
): Promise<LLMResponse> {
  const provider = isAnthropicModel(model) ? 'anthropic' : 'openai';
  try {
    return await fn(model);
  } catch (err) {
    if (isZeroBalanceError(err, provider)) {
      await _zeroBalanceHandler?.(provider);
      return await fn(fallbackModel(model));
    }
    throw err;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function chat(
  messages: LLMMessage[],
  model: ModelId = DEFAULT_MODEL,
  systemPrompt?: string,
  tools?: ToolDefinition[],
  signal?: AbortSignal,
): Promise<LLMResponse> {
  return withFallback(
    (m) =>
      isAnthropicModel(m)
        ? callAnthropic(messages, m, systemPrompt, tools, signal)
        : callOpenAI(messages, m, systemPrompt, tools, signal),
    model,
  );
}

// One-shot call for classifier / summarizer — always returns text
export async function simpleChat(
  prompt: string,
  model: ModelId,
  systemPrompt?: string,
): Promise<SimpleResult> {
  const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
  const result = await withFallback(
    (m) =>
      isAnthropicModel(m)
        ? callAnthropic(messages, m, systemPrompt, undefined, undefined)
        : callOpenAI(messages, m, systemPrompt, undefined, undefined),
    model,
  );
  return {
    text: result.type === 'text' ? result.text : '',
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
