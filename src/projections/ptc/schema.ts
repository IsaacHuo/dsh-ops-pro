/** Discriminated PTC envelopes feed the pinned host's validation and SDK generator. */
import type { JsonSchemaNode } from '../../adapter/dsh/types.js'
const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer' }
const object = (properties: Record<string, JsonSchemaNode>, required: string[]): JsonSchemaNode =>
  ({ type: 'object', properties, required, additionalProperties: false })
/** Coverage of a scan; isComplete is false exactly when the outcome is partial. */
const coverage: JsonSchemaNode = { ...object({ scannedFiles: integer, matchedCount: integer,
  isComplete: { type: 'boolean' },
  truncatedBy: { type: 'string', enum: ['scan-budget', 'output-budget', 'time-limit', 'row-limit'] },
}, ['scannedFiles', 'matchedCount', 'isComplete']), description: "isComplete is false exactly when status is 'partial'." }
export const ERROR_SCHEMA = object({ code: string, message: string, nextAction: string,
  effectState: { type: 'string', enum: ['none', 'applied', 'partial', 'unknown'] },
  retry: { type: 'string', enum: ['never', 'after-input-change', 'after-state-change', 'bounded-transient'] },
}, ['code', 'message', 'effectState', 'retry'])
/**
 * The envelope renders the tool's data schema exactly once: the generated SDK has no
 * shared type aliases, so every repeated copy is paid on every request that carries
 * the declaration. Completed and partial share one branch; the producer
 * (`toOutcome`) guarantees that a partial outcome carries coverage and a continuation.
 * Failure data holds those success fields known before the failure.
 */
export function outcomeSchema(data: JsonSchemaNode): JsonSchemaNode {
  return { oneOf: [
    object({ status: { type: 'string', enum: ['completed', 'partial'] }, data, coverage,
      continuation: { type: 'string', description: "Present when status is 'partial': pass it back to continue." },
      nextAction: string }, ['status', 'data']),
    object({ status: { type: 'string', enum: ['rejected', 'conflict', 'error', 'unknown'] }, error: ERROR_SCHEMA,
      data: { type: 'object', description: 'Facts known before the failure: some of the success data fields.' } }, ['status', 'error']),
  ] }
}

const exactCoverage = (complete: boolean): JsonSchemaNode => object({ scannedFiles: integer, matchedCount: integer,
  isComplete: { type: 'boolean', const: complete },
  truncatedBy: { type: 'string', enum: ['scan-budget', 'output-budget', 'time-limit', 'row-limit'] },
}, ['scannedFiles', 'matchedCount', 'isComplete'])
/**
 * The fully discriminated envelope for the published `ptc-sdk` typings, where type
 * aliases make the repeated data copies free and integrators narrow on `status`.
 */
export function typedOutcomeSchema(data: JsonSchemaNode): JsonSchemaNode {
  const failureData: JsonSchemaNode = { ...data, required: [], properties: { ...data.properties, error: { type: 'object' } } }
  return { oneOf: [
    object({ status: { type: 'string', const: 'completed' }, data, coverage: exactCoverage(true) }, ['status', 'data']),
    object({ status: { type: 'string', const: 'partial' }, data, coverage: exactCoverage(false), continuation: string, nextAction: string }, ['status', 'data', 'coverage', 'continuation']),
    object({ status: { type: 'string', enum: ['rejected', 'conflict', 'error', 'unknown'] }, error: ERROR_SCHEMA, data: failureData }, ['status', 'error']),
  ] }
}
