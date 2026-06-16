import type { ToolDefinition, ToolCall } from '../llm/index.js';

export interface SkillToolContext {
  sessionId: string;
  signal: AbortSignal | undefined;
}

export interface Skill {
  name: string;
  description: string;
  examples: string[];
  tools: ToolDefinition[];
  executeTool(call: ToolCall, ctx: SkillToolContext): Promise<string>;
  systemPromptFragment?: string;
  migrate(): void;
}
