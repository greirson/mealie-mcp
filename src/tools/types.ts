import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { MealieClient } from '../mealie/client.js';
import { toToolMessage } from '../mealie/errors.js';

export interface ToolContext {
  mealie: MealieClient;
}

export interface ToolAnnotationSet {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef<S extends z.ZodObject<any> = z.ZodObject<any>> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotationSet;
  /** Appended to 404 messages so Claude knows which lookup tool to use. */
  notFoundHint?: string;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export type AnyToolDef = ToolDef<z.ZodObject<any>>;

export const READ: ToolAnnotationSet = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
export const WRITE: ToolAnnotationSet = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
export const UPDATE: ToolAnnotationSet = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
export const DESTROY: ToolAnnotationSet = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };

export function defineTool<S extends z.ZodObject<any>>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export async function runTool(tool: AnyToolDef, rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult> {
  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { isError: true, content: [{ type: 'text', text: `Invalid input for ${tool.name}:\n${z.prettifyError(parsed.error)}` }] };
  }
  try {
    const data = await tool.run(parsed.data, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: toToolMessage(err, tool.notFoundHint) }] };
  }
}

export function registerTools(server: McpServer, tools: readonly AnyToolDef[], ctx: ToolContext): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: { title: tool.title, ...tool.annotations } },
      (args: unknown) => runTool(tool, args, ctx)
    );
  }
}
