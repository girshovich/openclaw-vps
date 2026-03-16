import type { ToolDefinition, ToolCall } from '../llm/index.js';
import { executeBash } from '../tools/bash.js';
import { browserNavigate, browserClick, browserType, browserGetText, browserEval } from '../tools/browser.js';
import { executeCronCreate, executeCronList, executeCronDelete } from '../tools/cron.js';
import { executeMemorySearch } from '../tools/memory-search.js';
import { createTask, updateTaskStatus, listTasks } from '../memory/sqlite.js';

export interface ToolContext {
  sessionId: string;
  depth: number;
  signal: AbortSignal | undefined;
  spawnSubAgent: (task: string) => Promise<string>;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const ALL_TOOLS: ToolDefinition[] = [
  {
    name: 'bash',
    description: 'Execute a bash command on the VPS. Returns stdout, stderr, and exit code.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Bash command to run' } },
      required: ['command'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL and return the page title and text content.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the current page using a CSS selector.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector to click' } },
      required: ['selector'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into a form field.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_get_text',
    description: 'Get text from the current page or a specific element.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Optional CSS selector' } },
      required: [],
    },
  },
  {
    name: 'browser_eval',
    description: 'Evaluate JavaScript in the browser and return the result.',
    parameters: {
      type: 'object',
      properties: { script: { type: 'string', description: 'JS expression to evaluate' } },
      required: ['script'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search long-term memory for relevant past conversations.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'cron_create',
    description: 'Schedule a recurring or one-time task. Schedules: "every Xm", "every Xh", "every Xd", "daily HH:MM", or ISO 8601 datetime.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What to do when the job fires' },
        schedule: { type: 'string', description: 'Schedule string' },
      },
      required: ['description', 'schedule'],
    },
  },
  {
    name: 'cron_list',
    description: 'List active cron jobs for this session.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cron_delete',
    description: 'Delete a cron job by ID.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Cron job ID' } },
      required: ['id'],
    },
  },
  {
    name: 'task_create',
    description: 'Create a task record to track something that needs to be done.',
    parameters: {
      type: 'object',
      properties: { description: { type: 'string', description: 'Task description' } },
      required: ['description'],
    },
  },
  {
    name: 'task_complete',
    description: 'Mark a task as completed.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task ID' } },
      required: ['id'],
    },
  },
  {
    name: 'task_list',
    description: 'List all tasks for this session.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'spawn_sub_agent',
    description: "Spawn a sub-agent to handle a task autonomously. Returns its final response. Cannot be used from within a sub-agent.",
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task for the sub-agent' },
      },
      required: ['task'],
    },
  },
];

// Sub-agents get a restricted set (no spawning, no task/cron management)
const SUB_AGENT_TOOLS = new Set([
  'bash', 'browser_navigate', 'browser_click', 'browser_type',
  'browser_get_text', 'browser_eval', 'memory_search',
]);

export function getToolDefinitions(depth: number): ToolDefinition[] {
  if (depth >= 1) return ALL_TOOLS.filter((t) => SUB_AGENT_TOOLS.has(t.name));
  return ALL_TOOLS;
}

// ── Tool executor ─────────────────────────────────────────────────────────────

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<string> {
  const { sessionId, depth, signal, spawnSubAgent } = ctx;
  const i = call.input;

  try {
    switch (call.name) {
      case 'bash':
        return await executeBash(String(i['command']), signal);

      case 'browser_navigate':
        return await browserNavigate(sessionId, String(i['url']));

      case 'browser_click':
        return await browserClick(sessionId, String(i['selector']));

      case 'browser_type':
        return await browserType(sessionId, String(i['selector']), String(i['text']));

      case 'browser_get_text':
        return await browserGetText(
          sessionId,
          i['selector'] !== undefined ? String(i['selector']) : undefined,
        );

      case 'browser_eval':
        return await browserEval(sessionId, String(i['script']));

      case 'memory_search':
        return await executeMemorySearch(String(i['query']));

      case 'cron_create':
        return executeCronCreate(sessionId, String(i['description']), String(i['schedule']));

      case 'cron_list':
        return executeCronList(sessionId);

      case 'cron_delete':
        return executeCronDelete(String(i['id']));

      case 'task_create': {
        const id = createTask(sessionId, String(i['description']));
        return `Task created (id: ${id}): ${String(i['description'])}`;
      }

      case 'task_complete':
        updateTaskStatus(String(i['id']), 'completed');
        return `Task ${String(i['id'])} marked as completed.`;

      case 'task_list': {
        const tasks = listTasks(sessionId);
        if (tasks.length === 0) return 'No tasks.';
        return tasks.map((t) => `[${t.id.slice(0, 8)}] [${t.status}] ${t.description}`).join('\n');
      }

      case 'spawn_sub_agent':
        if (depth >= 1) return 'Error: sub-agents cannot spawn further sub-agents (max depth 1).';
        return await spawnSubAgent(String(i['task']));

      default:
        return `Unknown tool: ${call.name}`;
    }
  } catch (err) {
    return `Tool error (${call.name}): ${err instanceof Error ? err.message : String(err)}`;
  }
}
