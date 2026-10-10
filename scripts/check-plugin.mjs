/**
 * Harness verification probe for dsh-camofox.
 *
 * Loaded only into a scratch profile. It waits until the browser runtime, the
 * tools and the prompt section are all mounted, writes a machine-readable
 * report, then shuts the harness down — so the report can be read after a real
 * boot without a model call.
 */
import { writeFileSync } from 'node:fs'

export const name = 'camofox-check-probe'
export const inject = ['tools', 'systemPrompt', 'camofox']

/** Tool names this bundle is expected to publish. */
const EXPECTED = [
  'camofox_open',
  'camofox_read',
  'camofox_act',
  'camofox_capture',
  'camofox_eval',
  'camofox_search',
  'camofox_scrape',
  'camofox_mirror',
  'camofox_tabs',
  'camofox_status',
  'camofox_transcript',
]

export async function apply(ctx) {
  // The runtime is published before the engine finishes booting, so sibling
  // plugins that inject it activate in the same tick. Give them that tick.
  await new Promise((resolve) => setTimeout(resolve, 500))

  const runtime = ctx.get('camofox')
  const report = { serviceFound: Boolean(runtime), engine: null, tools: [], promptSection: null, errors: [] }

  try {
    report.engine = runtime?.engine?.status?.() ?? null
  } catch (error) {
    report.errors.push(`status: ${error.message}`)
  }

  for (const toolName of EXPECTED) {
    try {
      const definition = ctx.tools.get(toolName)
      if (!definition) {
        report.tools.push({ name: toolName, registered: false })
        continue
      }
      report.tools.push({
        name: toolName,
        registered: true,
        parameters: definition.parameters ?? null,
        hasOutput: Boolean(definition.output?.schema),
        descriptionLength: String(definition.description ?? '').length,
      })
    } catch (error) {
      report.errors.push(`get(${toolName}): ${error.message}`)
    }
  }

  try {
    const visible = ctx.tools.schemas()
    report.visibleToolCount = Array.isArray(visible) ? visible.length : undefined
    report.visibleSample = (Array.isArray(visible) ? visible : []).slice(0, 8).map((schema) => schema?.name ?? schema?.function?.name)
  } catch (error) {
    report.errors.push(`schemas: ${error.message}`)
  }

  try {
    const assembly = await ctx.systemPrompt.assemble({})
    report.sectionNames = (assembly?.sections ?? []).map((item) => `${item.name}@${item.order}`)
    const section = (assembly?.sections ?? []).find((item) => item.name === 'camofox:browser')
    report.promptSection = section
      ? {
          order: section.order,
          interpolate: section.interpolate,
          length: String(section.text).length,
          head: String(section.text).slice(0, 90),
        }
      : null
  } catch (error) {
    report.errors.push(`assemble: ${error.message}`)
  }

  try {
    const tool = ctx.tools.get('camofox_status')
    if (tool) {
      const value = await tool.execute({}, { signal: new AbortController().signal })
      report.liveCall = { healthy: value?.healthy === true, content: value?.content }
    }
  } catch (error) {
    report.errors.push(`live call: ${error.message}`)
  }

  try {
    const open = ctx.tools.get('camofox_open')
    if (open) {
      const value = await open.execute(
        { url: 'https://example.com', readPage: true, maxChars: 1200 },
        { signal: new AbortController().signal },
      )
      report.liveOpen = { url: value?.url, refs: value?.refs, content: String(value?.content ?? '').slice(0, 160) }
    }
  } catch (error) {
    report.errors.push(`live open: ${error.message}`)
  }

  const target = process.env.DSH_CAMOFOX_CHECK_REPORT ?? 'C:\\Users\\mirel\\.dsh\\camofox-check-report.json'
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  setTimeout(() => process.exit(0), 1500)
}