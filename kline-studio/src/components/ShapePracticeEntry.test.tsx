import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DecisionReplayCenter } from './DecisionReplay'

it('offers the curated pattern exercises even when there are no old trading candidates', () => {
  const html = renderToStaticMarkup(<DecisionReplayCenter open availableCount={0} totalCount={0}
    symbolStats={[]} sessions={[]} activeSessionId={null} onClose={() => {}} onStart={() => {}}
    onContinue={() => {}} onResults={() => {}} onShapePractice={() => {}} />)
  expect(html).toContain('按K线形态')
  expect(html).toContain('13个形态案例，按自定义题量练习')
})
