import type { PublicTool } from '../core/gatewayCore.ts';
import type { ToolDef } from './types.ts';

export const SEARCH_TOOL = 'search_tools';
export const CALL_TOOL = 'call_tool';
export const SEARCH_TOP_N = 10;

/** The two meta-tools exposed when the visible tool count exceeds CHAT_TOOL_SEARCH_THRESHOLD. */
export function metaTools(total: number): ToolDef[] {
  return [
    {
      name: SEARCH_TOOL,
      description: `Search the ${total} available gateway tools by keyword. Returns the top ${SEARCH_TOP_N} matches with their full input schemas. Call this before call_tool.`,
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords describing what you want to do' } }, required: ['query'] },
    },
    {
      name: CALL_TOOL,
      description: 'Execute one gateway tool by its exact name (as returned by search_tools) with a JSON object of arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact tool name, e.g. notes__list_notes' },
          arguments: { type: 'object', description: 'Arguments matching the tool input schema', additionalProperties: true },
        },
        required: ['name'],
      },
    },
  ];
}

const tokenize = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

/** Keyword scoring over name / title / description; name hits weigh more than description hits. */
export function searchTools(tools: PublicTool[], query: string, topN = SEARCH_TOP_N): PublicTool[] {
  const terms = tokenize(query);
  if (terms.length === 0) return tools.slice(0, topN);
  const scored = tools.map((t) => {
    const name = tokenize(`${t.publicName} ${t.name} ${t.serverSlug} ${t.serverName}`);
    const title = tokenize(t.title ?? '');
    const desc = tokenize(t.description ?? '');
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 5;
      else if (name.some((n) => n.includes(term) || term.includes(n))) score += 2;
      if (title.includes(term)) score += 3;
      if (desc.includes(term)) score += 1;
    }
    return { t, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.t.publicName.localeCompare(b.t.publicName))
    .slice(0, topN)
    .map((s) => s.t);
}

export function searchResultText(tools: PublicTool[]): string {
  return JSON.stringify(tools.map((t) => ({ name: t.publicName, server: t.serverName, title: t.title, description: t.description, inputSchema: t.inputSchema })));
}
