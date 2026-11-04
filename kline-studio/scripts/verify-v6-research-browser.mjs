import { chromium } from 'file:///C:/Users/zbx00/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const out = new URL('../outputs/v6-research-import/', import.meta.url)
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/zbx00/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe' })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '对象树', exact: true }).click()
  const base = page.getByTestId('research-signal-layer-v6-round2-baseline')
  const candidate = page.getByTestId('research-signal-layer-v6-round2-candidate')
  await base.waitFor()
  assert.match(await base.innerText(), /261 个原始信号/)
  assert.match(await candidate.innerText(), /348 个原始信号/)
  await base.getByRole('button', { name: '首条', exact: true }).click()
  await page.screenshot({ path: fileURLToPath(new URL('baseline.png', out)) })
  await candidate.getByRole('button', { name: '首条', exact: true }).click()
  assert.match(await candidate.getAttribute('class'), /is-active/)
  assert.doesNotMatch(await base.getAttribute('class'), /is-active/)
  await candidate.getByRole('button', { name: '下条', exact: true }).click()
  assert.match(await candidate.innerText(), /2 \/ 348/)
  await page.screenshot({ path: fileURLToPath(new URL('candidate.png', out)) })
  const detail = page.getByTestId('research-signal-marker-details')
  await detail.waitFor({ timeout: 10000 })
  assert.match(await detail.innerText(), /原始理由/)
  assert.match(await detail.innerText(), /复核说明/)
  assert.equal(errors.length, 0, errors.join('\n'))
  const registry = await page.evaluate(async () => {
    const m = await import('/src/lib/researchSignalRegistry.ts')
    return m.researchSignalDatasetInfos()
  })
  await fs.writeFile(new URL('browser-validation.json', out), JSON.stringify({ status: 'PASS', checkedAt: new Date().toISOString(), registry, checks: ['both object-tree layers', 'first-signal navigation', 'exclusive version switching', 'next signal', 'reason and audit detail', 'no page errors'] }, null, 2))
  console.log('PASS: two versions, navigation, detail and no page errors')
} catch (e) {
  await fs.writeFile(new URL('browser-validation.json', out), JSON.stringify({ status: 'FAIL', error: String(e), errors }, null, 2))
  throw e
} finally { await browser.close() }
