import { test, expect, mock } from 'claude-code/testing'

// The browser answers a JavaScript evaluation with the value as JSON, then a "Tab Context" footer.
const browserAnswer = (value: unknown) => ({
  isError: false,
  content: [{ type: 'text', text: `${JSON.stringify(value, null, 2)}\n\nTab Context:\n- Executed on tabId: tab-1` }],
})

test('/nudge loads nudge into the page the built-in browser shows', async ($, on) => {
  const calls: Array<{ server: string; tool: string; script: string }> = []
  on('mcp.call', async (_$, e) => {
    calls.push({ server: e.server, tool: e.tool, script: String(e.args.text) })
    return { value: browserAnswer('loading') }
  })
  const { text } = await $.command.run({ command: 'nudge', args: '' })
  expect(calls).toHaveLength(1)
  expect(calls[0].tool).toBe('javascript_tool')
  expect(calls[0].script).toContain('nudge.js')
  expect(calls[0].script).toContain('window.__nudge.toggle()')
  expect(text).toContain('loading in the browser pane')
})

test('/nudge batch takes the batch from the page and puts it in the prompt box', async ($, on) => {
  const batch = 'nudge batch · http://localhost:4321/ · viewport 1254×887\n\n1. h1.hero "Hello"\n   width 311px → 455px'
  on('mcp.call', async (_$, e) => {
    expect(String(e.args.text)).toContain('n.take()')
    return { value: browserAnswer({ text: batch, count: 1 }) }
  })
  const filled: string[] = []
  on('prompt.fill', async (_$, e) => { filled.push(e.text); return { isFilled: true } })
  const { text } = await $.command.run({ command: 'nudge', args: 'batch' })
  expect(filled).toEqual([batch])
  expect(text).toContain('1 change(s)')
})

test('/nudge batch reports a page without nudge, and a browser it cannot reach', async ($, on) => {
  on('mcp.call', async () => ({ value: browserAnswer({ error: 'nudge is not open on this page. Run /nudge first.' }) }))
  const first = await $.command.run({ command: 'nudge', args: 'batch' })
  expect(first.text).toContain('Run /nudge first')
})

test('an unreachable browser is reported, not thrown', async ($, on) => {
  on('mcp.call', async () => ({ value: { isError: true, content: [{ type: 'text', text: 'no such server' }] } }))
  const { text } = await $.command.run({ command: 'nudge', args: '' })
  expect(text).toContain('Could not reach the built-in browser')
})

test('/nudge at resizes the browser pane by width, size or preset', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  on('mcp.call', async (_$, e) => { calls.push({ tool: e.tool, args: e.args as Record<string, unknown> }); return { value: browserAnswer('ok') } })
  await $.command.run({ command: 'nudge', args: 'at 390' })
  await $.command.run({ command: 'nudge', args: 'at 1024x768' })
  const { text } = await $.command.run({ command: 'nudge', args: 'at mobile' })
  expect(calls.map((c) => c.tool)).toEqual(['resize_window', 'resize_window', 'resize_window'])
  expect(calls[0].args).toEqual({ width: 390, height: 900 })
  expect(calls[1].args).toEqual({ width: 1024, height: 768 })
  expect(calls[2].args).toEqual({ preset: 'mobile' })
  expect(text).toContain('mobile')
  const bad = await $.command.run({ command: 'nudge', args: 'at huge' })
  expect(bad.text).toContain('Say a width')
  expect(calls).toHaveLength(3)
})

test('/nudge verify reports what the page shows of the last batch', async ($, on) => {
  on('mcp.call', async (_$, e) => {
    expect(String(e.args.text)).toContain('n.verify(')
    return { value: browserAnswer({ text: 'Checked: 1 of 2 applied.\nnot applied: div.hero-media: width is 311px, wanted 455px', applied: 1, total: 2 }) }
  })
  const { text } = await $.command.run({ command: 'nudge', args: 'verify' })
  expect(text).toBe('Checked: 1 of 2 applied.\nnot applied: div.hero-media: width is 311px, wanted 455px')
})

test('after a batch is sent, the next answered turn carries the verdict', async ($, on) => {
  const scripts: string[] = []
  on('mcp.call', async (_$, e) => {
    scripts.push(String(e.args.text))
    if (/n\.take\(\)/.test(String(e.args.text))) return { value: browserAnswer({ text: 'nudge batch\n\n1. x', count: 1 }) }
    return { value: browserAnswer({ text: 'Checked: 1 of 1 applied.', applied: 1, total: 1 }) }
  })
  on('prompt.fill', async () => ({ isFilled: true }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))   // the engine beneath: the answer as it stands
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => { toasts.push(e.text); return { value: {} } })
  const quiet = await $.turn.complete({ answer: 'before any batch', durationMs: 10, reason: 'answer' } as any)
  expect(quiet.text).toBe('before any batch')
  await $.command.run({ command: 'nudge', args: 'batch' })
  const { text } = await $.turn.complete({ answer: 'Applied the width.', durationMs: 10, reason: 'answer' } as any)
  expect(text).toBe('nudge · Checked: 1 of 1 applied.')
  expect(scripts.some((s) => s.includes('n.verify('))).toBe(true)
  expect(toasts.at(-1)).toBe('nudge: Checked: 1 of 1 applied.')
  // Only the one turn: the next completes untouched.
  const after = await $.turn.complete({ answer: 'later', durationMs: 10, reason: 'answer' } as any)
  expect(after.text).toBe('later')
})

test('/nudge batch send submits the batch as the user\'s prompt', async ($, on) => {
  on('mcp.call', async () => ({ value: browserAnswer({ text: 'nudge batch\n\n1. x', count: 1 }) }))
  const clock = mock.clock(on)
  const sent: Array<{ text: string; asUser?: boolean }> = []
  on('prompt.submit', async (_$, e) => { sent.push({ text: e.text, asUser: (e as any).origin?.asUser }); return { text: e.text } as any })
  const { text } = await $.command.run({ command: 'nudge', args: 'batch send' })
  expect(text).toContain('sent')
  expect(sent).toEqual([])                        // not from inside the command's own turn
  await clock.advance(100)
  expect(sent.map((s) => s.text)).toEqual(['nudge batch\n\n1. x'])
})

test('/nudge dark and /nudge history', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  on('mcp.call', async (_$, e) => {
    calls.push({ tool: e.tool, args: e.args as Record<string, unknown> })
    if (e.tool === 'resize_window') return { value: browserAnswer('ok') }
    return { value: browserAnswer({ items: [{ batch: 1, at: '2026-10-11T13:00:00.000Z', text: 'nudge batch\n\n1. a\n   width 1px → 2px\n\n2. b\n   moved right 1px' }] }) }
  })
  const dark = await $.command.run({ command: 'nudge', args: 'dark' })
  expect(calls[0]).toEqual({ tool: 'resize_window', args: { colorScheme: 'dark' } })
  expect(dark.text).toContain('dark')
  const hist = await $.command.run({ command: 'nudge', args: 'history' })
  expect(hist.text).toContain('batch 1 · 2026-10-11 13:00 · 2 change(s)')
  expect(hist.text).toContain('moved right 1px')
})

test('after /nudge, a navigation in the pane loads nudge on the new page', async ($, on) => {
  const scripts: string[] = []
  on('mcp.call', async (_$, e) => { scripts.push(String(e.args.text)); return { value: browserAnswer('loading') } })
  on('tool.call', async () => ({ result: { ok: true } } as any))
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://localhost:4321/about' } as any)
  expect(scripts).toHaveLength(0)                                  // nothing to restore before /nudge ran
  await $.command.run({ command: 'nudge', args: '' })
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://localhost:4321/pricing' } as any)
  expect(scripts).toHaveLength(2)
  expect(scripts[1]).toContain("if (window.__nudge) return 'present'")
})
