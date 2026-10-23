import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { project, workflow } from './fixture.mjs'

const CLI = new URL('../dist/cli.js', import.meta.url).pathname

async function connect(args, env = {}) {
  const client = new Client({ name: 'test', version: '0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, ...args],
    env: { ...process.env, ...env },
    stderr: 'pipe',
  })
  await client.connect(transport)
  return client
}
const text = (r) => JSON.parse(r.content[0].text)

test('the CLI serves the five tools over stdio and transitions a real project', async () => {
  const root = project({ state: { workflow_state: 'idle' } })
  const client = await connect(['--root', root])
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((t) => t.name),
      ['flow_check', 'flow_transition', 'flow_explain', 'flow_history', 'flow_modify'],
    )
    const check = text(await client.callTool({ name: 'flow_check', arguments: {} }))
    assert.equal(check.state, 'idle')
    const moved = text(
      await client.callTool({
        name: 'flow_transition',
        arguments: { event: 'task-picked', state_updates: { task: 'T-9' } },
      }),
    )
    assert.equal(moved.new_state, 'implementing')
    const history = text(await client.callTool({ name: 'flow_history', arguments: {} }))
    assert.equal(history.returned, 1)
    const unknown = await client.callTool({ name: 'flow_nope', arguments: {} })
    assert.equal(unknown.isError, true)
  } finally {
    await client.close()
  }
})

test('FLOW_PROJECT_PATH still selects the root, as the Forge shim and the fleet .mcp.json entries expect', async () => {
  const root = project({ state: { workflow_state: 'implementing' } })
  const client = await connect([], { FLOW_PROJECT_PATH: root })
  try {
    assert.equal(text(await client.callTool({ name: 'flow_check', arguments: {} })).state, 'implementing')
  } finally {
    await client.close()
  }
})

test('a missing workflow keeps the server up and every call returns the same error', async () => {
  const root = project()
  const client = await connect(['--root', root, '--workflow', 'missing.json'])
  try {
    const { tools } = await client.listTools()
    assert.equal(tools.length, 5)
    const r = await client.callTool({ name: 'flow_check', arguments: { workflow_state: 'idle' } })
    assert.equal(r.isError, true)
    assert.match(text(r).error, /No workflow at .*missing\.json/)
  } finally {
    await client.close()
  }
})

test('--validate reports a valid file and a broken one', () => {
  const root = project()
  const ok = spawnSync(process.execPath, [CLI, '--validate', '--root', root], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stderr, /valid \(5 states\)/)
  const w = workflow()
  w.states.idle.transitions[0].target = 'nowhere'
  writeFileSync(join(root, '.forge/workflow.json'), JSON.stringify(w))
  const bad = spawnSync(process.execPath, [CLI, '--validate', '--root', root], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /unknown state "nowhere"/)
})
