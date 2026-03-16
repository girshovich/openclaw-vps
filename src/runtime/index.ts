import { chat, DEFAULT_MODEL } from '../llm/index.js';
import type { ChatMessage } from '../llm/index.js';
import { appendMessage, getSessionHistory } from '../memory/sqlite.js';

function buildSystemPrompt(): string {
  return [
    'You are OpenClaw, a proactive AI assistant.',
    `Current time: ${new Date().toISOString()}.`,
    'Be helpful, direct, and thorough.',
  ].join(' ');
}

export async function runTurn(sessionId: string, userMessage: string): Promise<string> {
  // Persist the incoming user message
  appendMessage(sessionId, { role: 'user', content: userMessage });

  // Build message list for LLM from full session history
  const history = getSessionHistory(sessionId);
  const messages: ChatMessage[] = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const result = await chat(messages, DEFAULT_MODEL, buildSystemPrompt());

  // Persist assistant response
  appendMessage(sessionId, {
    role: 'assistant',
    content: result.text,
    modelUsed: result.modelUsed,
    tokenCount: result.outputTokens,
  });

  return result.text;
}
