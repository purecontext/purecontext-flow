import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Engine } from './engine.js'
import * as check from './tools/check.js'
import * as explain from './tools/explain.js'
import * as history from './tools/history.js'
import * as modify from './tools/modify.js'
import * as transition from './tools/transition.js'

export const SERVER_NAME = 'purecontext-flow'

// biome-ignore lint/suspicious/noExplicitAny: each handler narrows its own args
type Handler = (engine: Engine, args: any) => unknown

export const tools: { schema: { name: string; description: string; inputSchema: object }; handler: Handler }[] = [
  check,
  transition,
  explain,
  history,
  modify,
]

export interface ServerOptions {
  version: string
  /** When the engine failed to start, every call returns this message instead of crashing the server. */
  startupError?: string
  /**
   * How to start the engine when it is not running: tried on every call until
   * one succeeds, so a workflow created after the server came up is picked up
   * without a restart. A failure returns its message as that call's error.
   */
  start?: () => Engine
}

/** An MCP server over an engine, or over a startup error the agent can read and act on. */
export function createServer(initial: Engine | null, options: ServerOptions): Server {
  let engine = initial
  const server = new Server({ name: SERVER_NAME, version: options.version }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.schema.name,
      description: t.schema.description,
      inputSchema: t.schema.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const tool = tools.find((t) => t.schema.name === name)
    const reply = (body: unknown, isError = false) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
      ...(isError ? { isError: true } : {}),
    })
    if (!tool) return reply({ error: `Unknown tool: ${name}` }, true)
    if (!engine && options.start) {
      try {
        engine = options.start()
      } catch (err) {
        return reply({ error: (err as Error).message }, true)
      }
    }
    if (!engine) return reply({ error: options.startupError ?? 'The flow engine failed to start' }, true)
    try {
      return reply(tool.handler(engine, args ?? {}))
    } catch (err) {
      return reply({ error: (err as Error).message }, true)
    }
  })

  return server
}

export async function serveStdio(engine: Engine | null, options: ServerOptions): Promise<Server> {
  const server = createServer(engine, options)
  await server.connect(new StdioServerTransport())
  return server
}
