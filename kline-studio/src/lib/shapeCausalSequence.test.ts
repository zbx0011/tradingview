import { describe, it, expect } from 'vitest'
import { validateShapeSequence, type ShapeObservation, type ShapePhase } from './shapeCausalSequence'
const record = (phases: ShapePhase[]): ShapeObservation[] => phases.map((phase, index) => ({index, visibleThroughIndex:index, phase, evidence:'当根可见图形证据'}))
describe('causal shape confirmation then first cross', () => {
 it('does not promote legacy samples without observations', () => {
  expect(validateShapeSequence([1], [1], [], 'long').status).toBe('unconfirmed')
 })
 it('locks the first subsequent cross, not an earlier cross or a later recross', () => {
  const r=validateShapeSequence([9,11,9,9,11,9,11], Array(7).fill(10), record(['narrow','wide','range','range','range','range','range']), 'long')
  expect(r).toMatchObject({status:'signal',rangeConfirmedIndex:2,signalIndex:4})
 })
 it('uses the same sequence for short signals and ignores future prices', () => {
  const obs=record(['narrow','wide','range','range'])
  expect(validateShapeSequence([11,9,11,9,999], [10,10,10,10,-999],obs,'short')).toMatchObject({signalIndex:3,rangeConfirmedIndex:2})
 })
 it('rejects missing stages, missing bars, invalidation and future observation', () => {
  expect(validateShapeSequence([9,9],[10,10],record(['narrow','range']),'long').status).toBe('invalid')
  const missing=record(['narrow','wide']);missing[1].index=2
  expect(validateShapeSequence([9,9],[10,10],missing,'long').status).toBe('invalid')
  const future=record(['narrow']);future[0].visibleThroughIndex=1
  expect(validateShapeSequence([9],[10],future,'long').status).toBe('invalid')
  expect(validateShapeSequence([9,9,9,11],Array(4).fill(10),record(['narrow','wide','range','invalid']),'long').status).toBe('invalid')
 })
})
