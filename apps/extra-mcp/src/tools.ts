/**
 * Small helper around `McpServer.registerTool` that enforces this repo's tool conventions
 * (docs/contracts.md §3): snake_case names, `title` + `description` + the three annotation hints
 * on every tool, zod input schemas, and results that carry compact JSON text plus
 * `structuredContent`. Tool-level failures are `isError: true` results, never JSON-RPC errors.
 */
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from './logger.ts';

/** Success: `text` is the compact JSON of `data`, and `structuredContent` is the same object. */
export function ok(data: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

/** Tool-level failure: human-readable text with `isError: true`. */
export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Defaults to false: none of these tools talk to anything outside the process. */
  openWorldHint?: boolean;
}

/** A zod raw shape (`{ field: z.string(), ... }`), typed exactly as the SDK expects it. */
export type ToolShape = ZodRawShapeCompat;

/** The parsed arguments a handler receives for a given raw shape. */
export type ToolArgs<Shape extends ToolShape> = ShapeOutput<Shape>;

export interface ToolSpec<Shape extends ToolShape> {
  name: string;
  title: string;
  description: string;
  annotations: ToolHints;
  input: Shape;
  handler: (args: ToolArgs<Shape>) => CallToolResult | Promise<CallToolResult>;
}

/** `snake_case`, `[a-z0-9_]`, max 40 chars (docs/contracts.md §3). */
export const TOOL_NAME_RE = /^[a-z0-9_]{1,40}$/;

export function defineTool<Shape extends ToolShape>(
  server: McpServer,
  log: Logger,
  spec: ToolSpec<Shape>,
): void {
  if (!TOOL_NAME_RE.test(spec.name)) {
    throw new Error(`Tool name "${spec.name}" must match ${TOOL_NAME_RE}`);
  }
  const annotations: ToolAnnotations = {
    title: spec.title,
    openWorldHint: false,
    ...spec.annotations,
  };
  // ToolCallback<Shape> is a deferred conditional type, so TS cannot check the assignment
  // structurally for a generic Shape; the shape of the function is exactly what it expects.
  const callback = (async (args: ToolArgs<Shape>) => {
    const started = performance.now();
    try {
      const result = await spec.handler(args);
      log.info(
        { tool: spec.name, ms: Math.round(performance.now() - started), isError: result.isError === true },
        'tool call',
      );
      return result;
    } catch (err) {
      // Defensive: handlers are expected to return fail() themselves; an unexpected throw must
      // still surface as a tool-level error rather than a JSON-RPC -32603.
      log.error({ tool: spec.name, err }, 'tool handler threw');
      const message = err instanceof Error ? err.message : String(err);
      return fail(`Tool "${spec.name}" failed: ${message}`);
    }
  }) as unknown as ToolCallback<Shape>;
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      annotations,
    },
    callback,
  );
}
