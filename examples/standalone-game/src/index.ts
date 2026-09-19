/**
 * Standalone game example (offline, synthetic).
 *
 * Imports ONLY `@buberlo/jev-core`: no DeepSeek Harness, no network. Free text
 * input is mapped onto a bounded set of valid actions; world state and
 * consequences are deterministic application code. The mock provider plays the
 * role of the semantic classifier and is unmissably synthetic.
 *
 * Run: pnpm example:game   (build the workspace first: pnpm build)
 */

import {
  createJevCore,
  MockJevProvider,
  type MockAnswerSpec,
  type MockScenario,
} from '@buberlo/jev-core'

type ActionId = 'look' | 'go_north' | 'go_south' | 'take_lamp' | 'use_lamp' | 'wait'

interface World {
  room: 'entrance' | 'cellar' | 'hall'
  lampTaken: boolean
  lampOn: boolean
  lampUses: number
}

const ACTIONS: Array<{ id: ActionId; label: string; description: string }> = [
  { id: 'look', label: 'look', description: 'Look around the current room' },
  { id: 'go_north', label: 'go north', description: 'Walk north if a passage exists' },
  { id: 'go_south', label: 'go south', description: 'Walk south if a passage exists' },
  { id: 'take_lamp', label: 'take lamp', description: 'Pick up the lamp if it is here' },
  { id: 'use_lamp', label: 'use lamp', description: 'Switch the carried lamp on or off' },
  { id: 'wait', label: 'wait', description: 'Do nothing for one moment' },
]

const EXITS: Record<World['room'], Partial<Record<'north' | 'south', World['room']>>> = {
  entrance: { north: 'hall' },
  hall: { south: 'entrance', north: 'cellar' },
  cellar: { south: 'hall' },
}

function describeRoom(world: World): string {
  switch (world.room) {
    case 'entrance':
      return 'A dusty entrance. There is a lamp on the floor.'
    case 'hall':
      return 'A long hall. Passages lead south and north.'
    case 'cellar':
      return world.lampOn
        ? 'A cellar. By the lamp light you see a locked chest.'
        : 'A cellar. It is pitch dark; you can barely see anything.'
  }
}

function applyAction(world: World, action: ActionId): string {
  switch (action) {
    case 'look':
      return describeRoom(world)
    case 'go_north': {
      const destination = EXITS[world.room].north
      if (destination === undefined) return 'You cannot go north from here.'
      world.room = destination
      return `You go north. ${describeRoom(world)}`
    }
    case 'go_south': {
      const destination = EXITS[world.room].south
      if (destination === undefined) return 'You cannot go south from here.'
      world.room = destination
      return `You go south. ${describeRoom(world)}`
    }
    case 'take_lamp':
      if (world.room !== 'entrance' || world.lampTaken) return 'There is no lamp to take here.'
      world.lampTaken = true
      return 'You pick up the lamp.'
    case 'use_lamp':
      if (!world.lampTaken) return 'You are not carrying a lamp.'
      world.lampOn = !world.lampOn
      world.lampUses += 1
      return world.lampOn ? 'The lamp flickers on.' : 'You switch the lamp off.'
    case 'wait':
      return 'You wait. Nothing happens.'
  }
}

/** Synthetic keyword stand-in for a semantic classifier. */
function syntheticChoice(input: string, available: readonly string[]): string {
  const text = input.toLowerCase()
  if (/lamp|light|leuchte/.test(text) && /take|pick|grab|nimm/.test(text)) return 'take_lamp'
  if (/lamp|light|leuchte/.test(text) && /use|on|off|turn|switch|an|aus/.test(text)) return 'use_lamp'
  if (/north|norden/.test(text)) return 'go_north'
  if (/south|süden|sueden/.test(text)) return 'go_south'
  if (/look|see|inspect|schau|umsehen/.test(text)) return 'look'
  if (/wait|wart/.test(text)) return 'wait'
  void available
  return '__none__'
}

function provider(): MockJevProvider {
  return new MockJevProvider({
    scenarioFor: (request): MockScenario => {
      const answers: Record<string, MockAnswerSpec> = {}
      for (const [questionId, question] of Object.entries(request.questions)) {
        if (questionId === 'action' && question.type === 'choice') {
          const labels = Object.keys(question.criteria).filter(label => label !== '__none__')
          const state = request.state as { text?: string }
          const choice = syntheticChoice(state.text ?? '', labels)
          answers[questionId] = { choice: { choice, confidence: 0.8 } }
        } else if (questionId === 'is_impossible') {
          answers[questionId] = { noul: 0.1 }
        } else {
          answers[questionId] = { noul: 0.5 }
        }
      }
      return { answers }
    },
  })
}

const INPUTS = [
  'schau dich mal um',
  'nimm die Lampe',
  'geh nach Norden',
  'mach die Lampe an',
  'geh weiter nach Norden',
  'umsehen',
  'warte kurz',
  'tanze auf dem Tisch',
]

async function main(): Promise<void> {
  const core = createJevCore({ provider: provider(), mode: 'enforce' })
  const world: World = { room: 'entrance', lampTaken: false, lampOn: false, lampUses: 0 }

  console.log('=== standalone game with jev-core (SYNTHETIC classifier) ===')
  console.log(`valid actions: ${ACTIONS.map(action => action.id).join(', ')}\n`)

  for (const input of INPUTS) {
    const state = {
      text: input,
      room: world.room,
      inventory: world.lampTaken ? ['lamp'] : [],
      lampOn: world.lampOn,
    }
    const result = await core.evaluate({
      state,
      questions: {
        action: {
          type: 'choice',
          instructions: 'Which action does the player want to perform?',
          criteria: Object.fromEntries([
            ...ACTIONS.map(action => [action.id, action.description]),
            ['__none__', 'No valid action matches the input'],
          ]),
        },
        is_impossible: {
          type: 'noul',
          instructions: 'Is the requested action impossible in the current world state?',
        },
      },
    })
    if (!result.ok) {
      console.log(`"${input}" → evaluation failed (${result.failure.code}); world unchanged`)
      continue
    }
    const action = result.answers.action
    const impossible = result.answers.is_impossible
    if (action.type !== 'choice' || impossible.type !== 'noul') continue
    const chosen = action.choice === '__none__' || impossible.noul >= 0.5 ? undefined : action.choice as ActionId
    if (chosen === undefined) {
      console.log(`"${input}" → no valid action (provider=${result.diagnostics.provider}, synthetic p(none)=${(action.probabilities.__none__ ?? 0).toFixed(2)}); world unchanged`)
      continue
    }
    const outcome = applyAction(world, chosen)
    console.log(`"${input}" → ${chosen} (p=${(action.probabilities[chosen] ?? 0).toFixed(2)}, confidence=${action.confidence.toFixed(2)})`)
    console.log(`    ${outcome}`)
  }

  console.log(`\nfinal world: ${JSON.stringify(world)}`)
  console.log('Note: "tanze auf dem Tisch" maps to no valid action because this synthetic stand-in is keyword-based.')
  console.log('With the live provider, Jev performs the same mapping semantically; the world logic stays unchanged.')
}

await main()
