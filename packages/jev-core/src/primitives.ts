/**
 * Typed question builders re-exported from the official TypeSafe SDK, plus the
 * answer types the core validates and returns.
 *
 * The SDK already ships the canonical builders (`choice`, `score`, `noul`), so
 * the core re-exports them instead of wrapping them. Answers returned by
 * {@link import('./core.js').JevCore} are validated against the exact
 * question that produced them; values are never normalized onto a shared
 * "risk percentage" (ordinal score, probability and confidence stay distinct).
 *
 * @module jev-core/primitives
 */

export { choice, noul, score } from '@typesafe-ai/sdk'
export type {
  ChoiceCriteria,
  ChoiceQuestion,
  ChoiceResponse,
  Description,
  EntryType,
  NoulQuestion,
  NoulResponse,
  Question,
  Questions,
  ResultFor,
  ScoreCriteria,
  ScoreLegend,
  ScoreQuestion,
  ScoreResponse,
  SystemOneResult,
  Usage,
} from '@typesafe-ai/sdk'
