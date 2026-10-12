import type { Register } from 'claude-code'

// nudge.js stays exactly as published; this mod only loads it into the page the built-in browser shows
// and carries its batch back into the prompt box.
// Pinned to a release tag, like the bookmarklet. Bump it when a release changes what the mod relies on.
const NUDGE_URL = 'https://cdn.jsdelivr.net/gh/g1d30nB/nudge@v1.3.1/nudge.js'

// Runs in the page, as the bookmarklet does: toggle if loaded, else load.
const OPEN_SCRIPT = `(function () {
  if (window.__nudge) { window.__nudge.toggle(); return window.__nudge && window.__nudge._state.awake ? 'woken' : 'closed'; }
  var s = document.createElement('script');
  s.src = '${NUDGE_URL}?t=' + Date.now();
  document.documentElement.appendChild(s);
  return 'loading';
})()`

// Runs in the page after the pane navigates: load nudge again only where it is absent.
const ENSURE_SCRIPT = `(function () {
  if (window.__nudge) return 'present';
  var s = document.createElement('script');
  s.src = '${NUDGE_URL}?t=' + Date.now();
  document.documentElement.appendChild(s);
  return 'loading';
})()`

// Runs in the page: the batches sent this page load, newest last.
const HISTORY_SCRIPT = `(function () {
  var n = window.__nudge;
  if (!n) return { error: 'nudge is not open on this page. Run /nudge first.' };
  if (typeof n.history !== 'function') return { error: 'This nudge is older than v1.5.0 and keeps no history; update the script tag.' };
  return { items: n.history() };
})()`

// Runs in the page: the batch of unsent changes, then mark them sent through the panel's own button.
const BATCH_SCRIPT = `(function () {
  var n = window.__nudge;
  if (!n) return { error: 'nudge is not open on this page. Run /nudge first.' };
  var count = n._state.changes.filter(function (r) { return !r.sent; }).length;
  if (!count) return { error: 'No new changes to send.' };
  if (typeof n.take !== 'function') return { error: 'This nudge is older than v1.2.2 and has no take(); update the script tag.' };
  return { text: n.take(), count: count };
})()`

// Runs in the page: measure the last sent batch against the page as it is now.
const VERIFY_SCRIPT = `(function () {
  var n = window.__nudge;
  if (!n) return { error: 'nudge is not open on this page. Run /nudge first.' };
  if (typeof n.verify !== 'function') return { error: 'This nudge is older than v1.4.0 and cannot verify; update the script tag.' };
  var v = n.verify('now');
  return v ? { text: v.text, applied: v.applied, total: v.total } : { error: 'Nothing to check: no batch has been sent from this page.' };
})()`

// Named widths for "/nudge at …". Heights are the browser's own for the presets.
const SIZES: Record<string, { preset?: 'mobile' | 'tablet' | 'desktop'; width?: number; height?: number }> = {
  mobile: { preset: 'mobile' }, phone: { preset: 'mobile' }, tablet: { preset: 'tablet' }, desktop: { preset: 'desktop' },
}

// The built-in browser's server, under the names the engine might list it by.
const SERVERS = ['Claude_Browser', 'Claude Browser', 'claude-browser', 'browser']

type Found = { server: string; result: Record<string, unknown> }

// Call one of the browser's tools under whichever server name answers.
async function browser($: any, tool: string, args: Record<string, unknown>): Promise<Found | { error: string }> {
  const tried: string[] = []
  for (const server of SERVERS) {
    try {
      const res = await $.mcp.call(server, tool, args)
      const raw = (res.content ?? []).map((c: any) => c.text ?? '').join('\n')
      if (res.isError) { tried.push(`${server}: ${raw.slice(0, 120)}`); continue }
      // The browser answers with the value as JSON, then a "Tab Context" footer.
      const text = raw.split(/\n\s*Tab Context:/)[0].trim()
      let value: unknown = text
      try { value = JSON.parse(text) } catch { /* plain text result */ }
      return { server, result: typeof value === 'object' && value ? (value as Record<string, unknown>) : { value } }
    } catch (err) {
      tried.push(`${server}: ${(err as Error).message.slice(0, 120)}`)
    }
  }
  return { error: `Could not reach the built-in browser. Tried:\n${tried.join('\n')}` }
}
const evaluate = ($: any, script: string) => browser($, 'javascript_tool', { action: 'javascript_exec', text: script })

// "390", "390x844", "mobile", "tablet", "desktop" → resize_window arguments, or null.
export function sizeArgs(want: string): { preset?: string; width?: number; height?: number } | null {
  if (SIZES[want]) return SIZES[want]
  const m = /^(\d{3,4})(?:\s*[x×]\s*(\d{3,4}))?(?:px)?$/.exec(want)
  if (!m) return null
  return { width: Number(m[1]), height: m[2] ? Number(m[2]) : 900 }
}

async function verifyNow($: any): Promise<string> {
  const found = await evaluate($, VERIFY_SCRIPT)
  if ('error' in found) return found.error
  if (found.result.error) return String(found.result.error)
  return String(found.result.text ?? '')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const register: Register = (on) => {
  // Set when a batch has gone into the prompt box; the next completed turn is the one that applied it.
  let awaiting = false
  // Set once /nudge has put nudge in the pane, so a navigation there brings it back.
  let opened = false

  // The pane navigated: a new page has no nudge, so load it again where it is missing.
  on('tool.call', { tool: 'mcp__Claude_Browser__navigate' }, async ($, e, next) => {
    const out = await next(e)
    if (opened && !('deny' in out && out.deny)) {
      await sleep(600)
      const found = await evaluate($, ENSURE_SCRIPT)
      if (!('error' in found) && found.result.value === 'loading') $.ui.toast('nudge: loaded on the new page.')
    }
    return out
  }).catch((_$, e, next) => next(e))   // a failure here must never block the navigation itself

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'nudge', description: 'Open nudge in the built-in browser. "/nudge batch" pulls the batch into the prompt ("batch send" sends it); "/nudge at 390" resizes the pane; "/nudge dark"; "/nudge verify"; "/nudge history"' })
    return next(e)
  })

  // After the turn that applied a batch, measure the page and show the verdict beneath the answer.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (!awaiting || e.reason !== 'answer') return out
    awaiting = false
    await sleep(1500)   // the dev server's hot reload lands shortly after the file write
    const verdict = await verifyNow($)
    $.ui.toast(`nudge: ${verdict.split('\n')[0]}`)
    return { text: `nudge · ${verdict}` }
  })

  on('command.run', { command: 'nudge' }, async ($, e) => {
    const want = e.args.trim().toLowerCase()
    if (want === 'batch' || want === 'send' || want === 'batch send') {
      const found = await evaluate($, BATCH_SCRIPT)
      if ('error' in found) return { text: found.error }
      if (found.result.error) return { text: String(found.result.error) }
      const text = String(found.result.text ?? '')
      if (want === 'batch send') {
        // A submit from inside the command would wait on the turn this hook holds, so it goes out a moment
        // later from the clock, once the command has answered.
        awaiting = true
        $.clock.after(50, () => $.prompt.submit({ text, asUser: true }))
        return { text: `nudge batch (${found.result.count} change(s)) is being sent.` }
      }
      const filled = await $.prompt.fill({ text, mode: 'replace' })
      if (!filled.isFilled) return { text: `Batch of ${found.result.count} change(s) ready but the prompt box could not be filled:\n\n${text}` }
      awaiting = true
      $.ui.toast(`nudge: ${found.result.count} change(s) in the prompt box. Press Enter to send.`)
      return { text: `nudge batch (${found.result.count} change(s)) is in the prompt box. Press Enter to send it.` }
    }
    if (want === 'verify' || want === 'check') {
      awaiting = false
      return { text: await verifyNow($) }
    }
    if (want === 'dark' || want === 'light') {
      const found = await browser($, 'resize_window', { colorScheme: want })
      if ('error' in found) return { text: found.error }
      return { text: `Browser pane set to prefers-color-scheme: ${want}.` }
    }
    if (want === 'history') {
      const found = await evaluate($, HISTORY_SCRIPT)
      if ('error' in found) return { text: found.error }
      if (found.result.error) return { text: String(found.result.error) }
      const items = (found.result.items as Array<{ batch: number; at: string; text: string }>) ?? []
      if (!items.length) return { text: 'No batch has been sent from this page yet.' }
      const lines = items.map((h) => { const n = (h.text.match(/^\d+\. /gm) || []).length; return `batch ${h.batch} · ${h.at.slice(0, 16).replace('T', ' ')} · ${n} change(s)` })
      return { text: `${lines.join('\n')}\n\nFull text of the last batch:\n\n${items[items.length - 1].text}` }
    }
    if (want.startsWith('at ') || want.startsWith('at')) {
      const size = sizeArgs(want.replace(/^at\s*/, '').trim())
      if (!size) return { text: 'Say a width: "/nudge at 390", "/nudge at 390x844", or "/nudge at mobile", "tablet", "desktop".' }
      const found = await browser($, 'resize_window', size)
      if ('error' in found) return { text: found.error }
      const label = size.preset ?? `${size.width}×${size.height}`
      return { text: `Browser pane set to ${label}. nudge's badge shows the width and the breakpoint range it falls in.` }
    }
    const found = await evaluate($, OPEN_SCRIPT)
    if ('error' in found) return { text: found.error }
    const what = String(found.result.value ?? '')
    opened = what !== 'closed'
    if (what === 'closed') return { text: `nudge closed in the browser pane (via ${found.server}).` }
    if (what === 'woken') return { text: `nudge is open again in the browser pane (via ${found.server}).` }
    return { text: `nudge is loading in the browser pane (via ${found.server}). Click an element to start; "/nudge batch" pulls your changes into the prompt box, "/nudge batch send" sends it straight away.` }
  })
}
