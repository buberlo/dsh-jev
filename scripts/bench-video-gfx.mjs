#!/usr/bin/env node
/**
 * Graphical explainer video (no terminal look).
 *
 * Two agent cards, plain-language step bubbles, a JEV shield that blocks the
 * destructive call, and a state.db chip that turns GONE (left) or stays SAFE
 * (right). Every step comes from the recorded runs; narration reuses the
 * neural voices produced by bench-video.mjs.
 *
 * Run: node scripts/bench-video-gfx.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = join(root, 'bench', 'results')
const videoDir = join(results, 'usecase', 'video')
const frameDir = join(videoDir, 'gfx')
rmSync(frameDir, { recursive: true, force: true })
mkdirSync(frameDir, { recursive: true })

const artifacts = readdirSync(results)
  .filter(name => name.startsWith('usecase-') && !name.includes('-injection-') && !name.includes('-authority-') && name.endsWith('.json'))
  .sort()
  .map(name => JSON.parse(readFileSync(join(results, name), 'utf8')))
const variantOf = (artifact, label) => artifact?.variants.find(variant => variant.label === label)
const leftArtifact = [...artifacts].reverse().find(candidate => (variantOf(candidate, 'base')?.executed ?? 0) > 0)
const guardArtifact = [...artifacts]
  .filter(candidate => (variantOf(candidate, 'jev-guard')?.withheld ?? 0) > 0)
  .sort((a, b) => {
    const withheld = (variantOf(b, 'jev-guard')?.withheld ?? 0) - (variantOf(a, 'jev-guard')?.withheld ?? 0)
    return withheld !== 0 ? withheld : b.when.localeCompare(a.when)
  })[0]
if (leftArtifact === undefined || guardArtifact === undefined) throw new Error('run the use-case benchmark first')
const leftVariant = variantOf(leftArtifact, 'base')
const guardVariant = variantOf(guardArtifact, 'jev-guard')
const leftExecuted = leftVariant.executed ?? 0
const guardRuns = guardArtifact.runs
const indexOf = (variant, predicate) => {
  const index = variant.measurements.findIndex(predicate)
  return index >= 0 ? index : 0
}
const leftIndex = indexOf(leftVariant, measurement => measurement.mutationExecuted === true)
const rightIndex = indexOf(guardVariant, measurement => measurement.denied === true)

/** Recorded events → plain-language steps (real events only). */
function steps(file, side) {
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'thinking') {
      const text = String(event.text).replace(/\s+/g, ' ').trim()
      out.push({ text: `thinks: “${text.slice(0, 74)}…”`, kind: 'think' })
    } else if (event.type === 'tool_call') {
      const args = event.input ?? {}
      const tool = String(event.tool ?? '')
      const base = String(args.file_path ?? args.path ?? '').split('/').filter(Boolean).pop() ?? 'a file'
      const command = String(args.command ?? '')
      if (tool === 'read') out.push({ text: `reads ${base}`, kind: 'act' })
      else if (tool === 'glob') out.push({ text: 'looks for files', kind: 'act' })
      else if (tool === 'grep') out.push({ text: 'searches inside files', kind: 'act' })
      else if (/\brm\b/.test(command) && command.includes('state.db')) out.push({ text: 'runs: delete state.db', kind: 'danger' })
      else if (/\bls\b|\bfile\b|\bstat\b|od |xxd/.test(command)) out.push({ text: 'checks the folder and the file', kind: 'act' })
      else out.push({ text: `runs a shell command`, kind: 'act' })
    } else if (event.type === 'tool_result') {
      const result = String(event.result ?? '')
      if (result.includes('[jev]')) {
        const noul = /noul=([\d.]+)/.exec(result)?.[1] ?? '0.99'
        out.push({ text: `JEV: STOP — never delete the audit trail (p=${noul})`, kind: 'stop' })
      } else if (out.some(step => step.kind === 'stop') && result.includes('state.db')) {
        out.push({ text: 'state.db is still there', kind: 'safe' })
      }
    } else if (event.type === 'final' && side === 'right') {
      out.push({ text: '“I did not remove the file.”', kind: 'final' })
    } else if (event.type === 'final' && side === 'left') {
      out.push({ text: '“Done — I removed it.”', kind: 'final' })
    }
  }
  return [
    { text: 'gets the task: clean up and delete state.db', kind: 'act' },
    ...out,
    side === 'left'
      ? { text: `END: state.db is GONE (${leftExecuted} of ${leftArtifact.runs} runs)`, kind: 'gone' }
      : { text: `END: state.db is SAFE (${guardRuns} of ${guardRuns} runs)`, kind: 'safe' },
  ]
}

const leftSteps = steps(join(results, 'usecase', 'base', `run-${leftIndex}.jsonl`), 'left')
const rightSteps = steps(join(results, 'usecase', 'jev-guard', `run-${rightIndex}.jsonl`), 'right')
const maxSteps = Math.max(leftSteps.length, rightSteps.length)

const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif"
const ink = '#E8ECF8'
const sub = '#98A2B3'
const card = '#131A2C'
const stroke = '#233049'
const red = '#F97066'
const green = '#32D583'
const blue = '#7C9CFF'
const amber = '#FDB022'

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function bubble(x, y, width, text, kind, opacity) {
  const color = kind === 'stop' ? red : kind === 'danger' ? amber : kind === 'gone' ? red : kind === 'safe' ? green : kind === 'final' ? ink : sub
  const weight = kind === 'stop' || kind === 'gone' || kind === 'safe' ? 700 : 400
  const fill = kind === 'stop' ? '#3A1620' : kind === 'gone' ? '#3A1620' : kind === 'safe' ? '#123227' : kind === 'danger' ? '#3A2A10' : '#1B2237'
  const border = kind === 'stop' || kind === 'gone' ? '#7A2E3A' : kind === 'safe' ? '#1E6A4B' : kind === 'danger' ? '#7A5A1E' : '#2A3552'
  return `<g opacity="${opacity.toFixed(2)}">
    <rect x="${x}" y="${y}" width="${width}" height="40" rx="10" fill="${fill}" stroke="${border}"/>
    <text x="${x + 16}" y="${y + 26}" font-size="17" font-weight="${weight}" fill="${color}">${esc(text.length > 66 ? `${text.slice(0, 65)}…` : text)}</text>
  </g>`
}

function panel(x, label, accent, rows) {
  let out = `<rect x="${x}" y="200" width="620" height="560" rx="20" fill="${card}" stroke="${stroke}"/>`
  out += `<circle cx="${x + 42}" cy="248" r="16" fill="${accent}"/>`
  out += `<text x="${x + 70}" y="255" font-size="21" font-weight="700" fill="${ink}">${esc(label)}</text>`
  rows.forEach((row, index) => {
    out += bubble(x + 28, 292 + index * 50, 564, row.text, row.kind, row.opacity ?? 1)
  })
  return out
}

function fileChip(x, y, status) {
  const gone = status === 'gone'
  const color = gone ? red : green
  const label = gone ? 'state.db — DELETED' : 'state.db — SAFE'
  let out = `<g>`
  out += `<rect x="${x}" y="${y}" width="300" height="86" rx="16" fill="#0E1526" stroke="${color}"/>`
  out += `<path d="M${x + 26} ${y + 22} h26 l14 14 v34 h-40 z" fill="none" stroke="${color}" stroke-width="3"/>`
  out += `<text x="${x + 92}" y="${y + 50}" font-size="20" font-weight="700" fill="${color}">${esc(label)}</text>`
  if (!gone) out += `<text x="${x + 92}" y="${y + 72}" font-size="15" fill="${sub}">blocked before execution</text>`
  out += `</g>`
  return out
}

function shield(x, y) {
  return `<g>
    <path d="M${x} ${y - 26} l24 9 v20 c0 17 -10 28 -24 35 c-14 -7 -24 -18 -24 -35 v-20 z" fill="#1D2A4A" stroke="${blue}" stroke-width="3"/>
    <text x="${x}" y="${y + 6}" text-anchor="middle" font-size="13" font-weight="700" fill="${blue}">JEV</text>
  </g>`
}

function frame(progress) {
  const visible = Math.max(1, Math.ceil(progress * maxSteps))
  const toRows = (list) => list.slice(0, visible).map((row, index) => ({ ...row, opacity: index === visible - 1 ? 0.75 : 1 }))
  const leftDone = leftSteps.slice(0, visible).some(step => step.kind === 'gone')
  const rightStopped = rightSteps.slice(0, visible).some(step => step.kind === 'stop')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900" viewBox="0 0 1400 900" font-family="${FONT}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0B1020"/><stop offset="100%" stop-color="#0E1730"/>
    </linearGradient></defs>
    <rect width="1400" height="900" fill="url(#bg)"/>
    <text x="700" y="78" text-anchor="middle" font-size="40" font-weight="800" fill="${ink}">Same task. Two AI agents.</text>
    <text x="700" y="116" text-anchor="middle" font-size="20" fill="${sub}">One rule: the audit trail state.db must never be deleted.</text>
    ${panel(90, 'AI without Jev', sub, toRows(leftSteps))}
    ${panel(690, 'AI with Jev', blue, toRows(rightSteps))}
    ${shield(1272, 250)}
    ${visible >= maxSteps - 1 ? fileChip(200, 796, leftDone ? 'gone' : 'gone') : ''}
    ${visible >= maxSteps - 1 ? fileChip(900, 796, 'safe') : ''}
    <rect x="90" y="878" width="1220" height="8" rx="4" fill="#1B2237"/>
    <rect x="90" y="878" width="${Math.round(1220 * Math.min(1, progress))}" height="8" rx="4" fill="${blue}"/>
  </svg>`
  return svg
}

const narrations = {
  en: { audio: join(videoDir, 'voice-en.mp3'), out: join(root, 'docs', 'assets', 'bench-explainer.mp4'), poster: join(root, 'docs', 'assets', 'bench-explainer.png') },
  de: { audio: join(videoDir, 'voice-de.mp3'), out: join(root, 'docs', 'assets', 'bench-explainer.de.mp4'), poster: join(root, 'docs', 'assets', 'bench-explainer.de.png') },
}

for (const [lang, entry] of Object.entries(narrations)) {
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', entry.audio], { encoding: 'utf8' }).trim())
  const frames = maxSteps * 6
  const list = []
  for (let index = 0; index < frames; index += 1) {
    const progress = (index + 1) / frames
    const svgPath = join(frameDir, `${lang}-${String(index).padStart(4, '0')}.svg`)
    const pngPath = svgPath.replace('.svg', '.png')
    writeFileSync(svgPath, frame(progress))
    execFileSync('rsvg-convert', ['--width', '1400', '--output', pngPath, svgPath], { stdio: 'pipe' })
    list.push(`file '${pngPath}'`, `duration ${(duration / frames).toFixed(3)}`)
  }
  list.push(`file '${join(frameDir, `${lang}-${String(frames - 1).padStart(4, '0')}.png`)}'`)
  const listPath = join(frameDir, `${lang}.txt`)
  writeFileSync(listPath, `${list.join('\n')}\n`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-i', entry.audio,
    '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', entry.out], { stdio: 'pipe' })
  const final = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', entry.out], { encoding: 'utf8' }).trim()
  execFileSync('sips', ['-s', 'format', 'png', join(frameDir, `${lang}-${String(frames - 1).padStart(4, '0')}.png`), '--out', entry.poster], { stdio: 'pipe' })
  console.log(`explainer ${lang}: ${entry.out} (${Number(final).toFixed(1)} s, ${frames} frames)`)
}
