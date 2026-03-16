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

export const DEFAULT_MODEL: ModelId = 'claude-sonnet-4-6';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  modelUsed: ModelId;
}

type ZeroBalanceHandler = (provider: 'anthropic' | 'openai') => Promise<void>;
let _zeroBalanceHandler: ZeroBalanceHandler | undefined;

export function onZeroBalance(handler: ZeroBalanceHandler): void {
  _zeroBalanceHandler = handler;
}

// Lazy-initialize clients so dotenv loads before API key is read
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

function isAnthropicModel(model: ModelId): boolean {
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
      msg.includes('insufficient_balance')
    );
  } else {
    return msg.includes('insufficient_quota') || msg.includes('exceeded your current quota');
  }
}

function fallbackModel(model: ModelId): ModelId {
  return isAnthropicModel(model) ? 'gpt-5.4' : 'claude-sonnet-4-6';
}

async function callAnthropic(
  messages: ChatMessage[],
  model: ModelId,
  systemPrompt: string | undefined,
): Promise<ChatResult> {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: 8192,
    messages,
  };
  if (systemPrompt !== undefined) params.system = systemPrompt;

  const response = await getAnthropic().messages.create(params);
  const block = response.content[0];
  if (!block || block.type !== 'text') throw new Error('Unexpected Anthropic response type');
  return {
    text: block.text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    modelUsed: model,
  };
}

async function callOpenAI(
  messages: ChatMessage[],
  model: ModelId,
  systemPrompt: string | undefined,
): Promise<ChatResult> {
  const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];
  if (systemPrompt !== undefined) {
    openaiMessages.push({ role: 'system', content: systemPrompt });
  }
  for (const m of messages) {
    openaiMessages.push({ role: m.role, content: m.content });
  }

  const response = await getOpenAI().chat.completions.create({
    model,
    messages: openaiMessages,
  });

  const choice = response.choices[0];
  if (!choice) throw new Error('No choices in OpenAI response');
  return {
    text: choice.message.content ?? '',
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    modelUsed: model,
  };
}

export async function chat(
  messages: ChatMessage[],
  model: ModelId = DEFAULT_MODEL,
  systemPrompt?: string,
): Promise<ChatResult> {
  const provider = isAnthropicModel(model) ? 'anthropic' : 'openai';
  try {
    if (provider === 'anthropic') {
      return await callAnthropic(messages, model, systemPrompt);
    } else {
      return await callOpenAI(messages, model, systemPrompt);
    }
  } catch (err) {
    if (isZeroBalanceError(err, provider)) {
      await _zeroBalanceHandler?.(provider);
      const fb = fallbackModel(model);
      if (isAnthropicModel(fb)) {
        return await callAnthropic(messages, fb, systemPrompt);
      } else {
        return await callOpenAI(messages, fb, systemPrompt);
      }
    }
    throw err;
  }
}
