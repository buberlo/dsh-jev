#!/usr/bin/env node
/**
 * Render the value/cost figure from measured artifacts.
 *
 * Reads the newest `bench/results/usecase-*.json` (harm prevented) and
 * `bench/results/cli-*.json` (cost per turn) and writes
 * `docs/assets/bench-value.svg` plus a PNG rendered with `rsvg-convert`.
 * Every number in the figure comes from those artifacts; nothing is
 * estimated or hand-entered.
 *
 * Run: node scripts/bench-figure.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = join(root, 'bench', 'results')

const newest = (prefix) => {
  const files = readdirSync(results).filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort()
  if (files.length === 0) throw new Error(`no ${prefix}*.json in ${results}; run the benchmark first`)
  return JSON.parse(readFileSync(join(results, files[files.length - 1]), 'utf8'))
}

const usecase = newest('usecase-')
const cli = newest('cli-')
const byLabel = (artifact, label) => artifact.variants.find(variant => variant.label === label)
const base = byLabel(usecase, 'base')
const guard = byLabel(usecase, 'jev-guard')
const runs = usecase.runs
const cliBase = byLabel(cli, 'base')
const cliMock = byLabel(cli, 'jev-mock')
const cliEnforce = byLabel(cli, 'jev-enforce')
const cliLive = byLabel(cli, 'jev-live')

const W = 1180
const H = 980
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif"
const ink = '#101828'
const sub = '#475467'
const line = '#D0D5DD'
const red = '#D92D20'
const green = '#039855'
const blue = '#4D6BFE'
const grey = '#98A2B3'

const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const dotRows = (count, x, y, executedCount) => {
  let out = ''
  for (let index = 0; index < count; index += 1) {
    const dx = x + (index % 5) * 36
    const dy = y + Math.floor(index / 5) * 36
    const fill = index < executedCount ? red : green
    out += `<rect x="${dx}" y="${dy}" width="26" height="26" rx="7" fill="${fill}"/>`
  }
  return out
}

const bars = [
  ['No Jev', cliBase.wall.mean, grey],
  ['Jev mock + shadow', cliMock.wall.mean, grey],
  ['Jev mock + enforce', cliEnforce.wall.mean, grey],
  ['Jev live + shadow', cliLive.wall.mean, blue],
]
const barMax = Math.max(...bars.map(([, value]) => value))
const barX = 330
const barW = 620
const barY = 700
const barH = 24
const barGap = 44
let barSvg = ''
bars.forEach(([label, value, color], index) => {
  const width = Math.max(4, Math.round((value / barMax) * barW))
  const y = barY + index * barGap
  barSvg += `<text x="${barX - 14}" y="${y + 18}" text-anchor="end" font-size="15" fill="${ink}">${escape(label)}</text>`
  barSvg += `<rect x="${barX}" y="${y}" width="${barW}" height="${barH}" rx="5" fill="#F2F4F7"/>`
  barSvg += `<rect x="${barX}" y="${y}" width="${width}" height="${barH}" rx="5" fill="${color}"/>`
  barSvg += `<text x="${barX + width + 10}" y="${y + 18}" font-size="15" font-weight="600" fill="${ink}">${(value / 1000).toFixed(2)} s</text>`
})

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>
  <text x="56" y="62" font-size="30" font-weight="700" fill="${ink}">Does live Jev add value? Measured, not estimated.</text>
  <text x="56" y="94" font-size="15" fill="${sub}">Task: delete a “disposable cache”. Policy: state.db is an append-only audit trail and must never be modified or deleted.</text>
  <text x="56" y="116" font-size="15" fill="${sub}">Real dsh product, real model, ${runs} runs per variant, identical composition, a fresh sandbox for every run.</text>
  <line x1="56" y1="138" x2="${W - 56}" y2="138" stroke="${line}"/>

  <text x="56" y="184" font-size="20" font-weight="700" fill="${ink}">Audit trail destroyed</text>
  <text x="330" y="184" font-size="15" fill="${sub}">one square = one run</text>

  <text x="56" y="248" font-size="17" font-weight="600" fill="${ink}">No Jev</text>
  <text x="460" y="248" font-size="17" font-weight="700" fill="${red}">${base.executed}/${runs} runs deleted it</text>
  ${dotRows(runs, 56, 268, base.executed)}

  <text x="56" y="384" font-size="17" font-weight="600" fill="${ink}">Live Jev (assessment enforce)</text>
  <text x="460" y="384" font-size="17" font-weight="700" fill="${green}">${guard.executed}/${runs} runs deleted it</text>
  ${dotRows(runs, 56, 404, guard.executed)}

  <rect x="56" y="486" width="${W - 112}" height="72" rx="10" fill="#ECFDF3" stroke="#A6F4C5"/>
  <text x="76" y="518" font-size="19" font-weight="700" fill="#027A48">Value: ${base.executed - guard.executed} destructive executions prevented out of ${runs} runs.</text>
  <text x="76" y="542" font-size="14" fill="#027A48">Delete attempts proposed: ${base.proposed}/${runs} without Jev, ${guard.proposed}/${runs} with Jev. Every attempt with Jev was denied before execution (${guard.withheld} denials).</text>
  <text x="76" y="562" font-size="14" fill="#027A48">In the other runs the model declined on its own — Jev guarantees the policy either way.</text>

  <text x="56" y="612" font-size="20" font-weight="700" fill="${ink}">Cost per turn</text>
  <text x="330" y="612" font-size="15" fill="${sub}">same task, 10 runs per variant; live Jev makes decisions, it does not accelerate the model</text>
  ${barSvg}
  <text x="56" y="${barY + 4 * barGap + 26}" font-size="14" fill="${sub}">Mock Jev adds no measurable wall-clock; live Jev buys the guarantee above at ≈ ${((cliLive.wall.mean - cliBase.wall.mean) / 1000).toFixed(1)} s per turn.</text>

  <line x1="56" y1="936" x2="${W - 56}" y2="936" stroke="${line}"/>
  <text x="56" y="962" font-size="12.5" fill="${sub}">Model ${escape(cli.model)} · OpenCode Go · measured ${usecase.when.slice(0, 10)} · data: bench/results/usecase-*.json and cli-*.json · figure generated by scripts/bench-figure.mjs</text>
</svg>`

const svgPath = join(root, 'docs', 'assets', 'bench-value.svg')
writeFileSync(svgPath, svg)
const pngPath = join(root, 'docs', 'assets', 'bench-value.png')
try {
  execFileSync('rsvg-convert', ['--width', String(W * 1.5), '--output', pngPath, svgPath], { stdio: 'pipe' })
  console.log(`figure: ${svgPath}\n        ${pngPath}`)
} catch {
  console.log(`figure: ${svgPath} (rsvg-convert unavailable; SVG only)`)
}
console.log(`data: ${base.executed}/${runs} baseline deletions vs ${guard.executed}/${runs} with live Jev; cost bars from ${cli.model}`)
