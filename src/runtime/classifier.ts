import { simpleChat, CLASSIFY_MODEL } from '../llm/index.js';

const SYSTEM = `You are a session classifier. Reply with exactly one word: "new" or "continue".
"new" = the message starts a clearly different topic.
"continue" = it continues or references the current topic.
When in doubt, reply "continue".`;

export async function classifySession(
  recentHistory: string,
  newMessage: string,
): Promise<'new' | 'continue'> {
  const prompt = `Recent conversation:\n${recentHistory}\n\nNew message: "${newMessage}"\n\nNew topic or continuing?`;
  const result = await simpleChat(prompt, CLASSIFY_MODEL, SYSTEM);
  return result.text.trim().toLowerCase().startsWith('new') ? 'new' : 'continue';
}
