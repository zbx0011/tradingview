import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManualCandleBiasEditor } from './ManualCandleBiasEditor'
import { DecisionRiskOverlay } from './DecisionReplay'
import type { ManualBarNote } from '../lib/manualPractice'

// This repository has no DOM test runtime. Exercise the editor's real callbacks,
// draft-storage hook and window listeners with a small state/effect driver;
// child cards/overlays are inspected as elements rather than pretending to mount a DOM.
const hooks = vi.hoisted(() => {
  const slots: unknown[] = []
  const effects = new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>()
  let cursor = 0
  let pending: (() => void)[] = []
  return {
    begin() { cursor = 0 },
    state(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [slots[index], (next: unknown) => {
        slots[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(slots[index]) : next
      }]
    },
    ref(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    effect(run: () => void | (() => void), deps?: readonly unknown[]) {
      const index = cursor++
      const previous = effects.get(index)
      if (!previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps![i]))) {
        pending.push(() => {
          previous?.cleanup?.()
          const cleanup = run()
          effects.set(index, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
        })
      }
    },
    commit() { const tasks = pending; pending = []; tasks.forEach(task => task()) },
    reset() {
      effects.forEach(effect => effect.cleanup?.())
      effects.clear(); slots.length = 0; pending = []; cursor = 0
    },
  }
})

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: hooks.state as typeof actual.useState,
    useRef: hooks.ref as typeof actual.useRef,
    useEffect: hooks.effect as typeof actual.useEffect,
    useLayoutEffect: hooks.effect as typeof actual.useLayoutEffect,
    useMemo: ((create: () => unknown) => create()) as typeof actual.useMemo,
    useCallback: ((callback: unknown) => callback) as typeof actual.useCallback,
  }
})

type Element = ReactElement<Record<string, unknown>>
const elements = (node: ReactNode): Element[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
const textOf = (node: ReactNode): string => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return isValidElement<Record<string, unknown>>(node) ? textOf(node.props.children as ReactNode) : ''
}
const button = (tree: ReactNode, label: string) => {
  const found = elements(tree).find(element => element.type === 'button' && textOf(element) === label)
  expect(found, `button ${label}`).toBeDefined()
  return found!
}
const click = (element: Element) => (element.props.onClick as () => void)()
const card = (tree: ReactNode) => elements(tree).find(element => element.props.testId === 'candle-bias-editor')!
const note: ManualBarNote = {
  barTime: 300, interval: '5m', kind: 'should-trade', side: 'long', background: '原背景',
  reasons: ['原理由'], updatedAt: 1,
}
const storageKey = 'kline-panel-state-v1:bias:delete-test'
let storage: Map<string, string>
let actions: string[]

beforeEach(() => {
  storage = new Map()
  actions = []
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => { actions.push(`remove:${key}`); storage.delete(key) },
  })
  const testWindow = new EventTarget()
  const remove = testWindow.removeEventListener.bind(testWindow)
  // Node 24 leaves capture listeners behind when removal receives boolean true;
  // its equivalent options-object form matches browser listener cleanup.
  testWindow.removeEventListener = (type, listener, options) => remove(type, listener,
    typeof options === 'boolean' ? { capture: options } : options)
  vi.stubGlobal('window', testWindow)
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('HTMLInputElement', class {})
})
afterEach(() => { hooks.reset(); vi.unstubAllGlobals() })

const editor = (overrides: Partial<ComponentProps<typeof ManualCandleBiasEditor>> = {}) => {
  const onSave = vi.fn(() => actions.push('save'))
  const onCancel = vi.fn(() => actions.push('cancel'))
  const onDelete = vi.fn(() => actions.push('delete'))
  const props: ComponentProps<typeof ManualCandleBiasEditor> = {
    subtitle: '2026-10-30 06:10', notes: [note], initialBias: 'long', initialBackground: '',
    defaultRiskPlans: {
      long: { entryPrice: 100, stopLoss: 95, takeProfit: 110 },
      short: { entryPrice: 100, stopLoss: 105, takeProfit: 90 },
    },
    toPrice: y => y, toY: price => price, persistenceId: 'delete-test',
    onSave, onCancel, onDelete, ...overrides,
  }
  const render = () => { hooks.begin(); const tree = ManualCandleBiasEditor(props); hooks.commit(); return tree }
  return { render, onSave, onCancel, onDelete }
}
const editBackground = (tree: ReactNode, value: string) => {
  const input = elements(tree).find(element => element.type === 'input' && element.props['aria-label'] === '背景（必填）')!
  ;(input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } })
}
class KeyEvent extends Event {
  readonly keyCode = 13
  readonly isComposing = false
  readonly repeat = false
  readonly altKey = false
  readonly shiftKey = false
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  constructor(readonly key: string, modifier?: 'ctrl' | 'meta') {
    super('keydown', { cancelable: true })
    this.ctrlKey = modifier === 'ctrl'; this.metaKey = modifier === 'meta'
  }
}

describe('deleting one candle reason group', () => {
  it.each([
    { name: 'existing notes with deletion available', notes: [note], enabled: true, visible: true },
    { name: 'a new unsaved candle', notes: [], enabled: true, visible: false },
    { name: 'a caller without deletion support', notes: [note], enabled: false, visible: false },
  ])('shows the group-delete action only for $name', ({ notes, enabled, visible }) => {
    const { render } = editor({ notes, ...(enabled ? {} : { onDelete: undefined }) })
    const tree = render()
    const found = elements(tree).filter(element => element.type === 'button' && textOf(element) === '删除本根K线理由')
    expect(found).toHaveLength(visible ? 1 : 0)
    expect(elements(tree).some(element => element.props.role === 'alertdialog')).toBe(false)
  })

  it('asks for explicit confirmation, suspends price editing and leaves the saved draft intact', () => {
    const instance = editor()
    let tree = instance.render()
    editBackground(tree, '尚未保存的新背景')
    tree = instance.render()
    expect(elements(tree).some(element => element.type === DecisionRiskOverlay)).toBe(true)
    click(button(tree, '删除本根K线理由'))
    tree = instance.render()
    const confirmation = elements(tree).find(element => element.props.role === 'alertdialog')!
    expect(confirmation.props['aria-label']).toBe('删除本根K线理由确认')
    expect(textOf(confirmation)).toContain('删除本根K线的做多、做空、不开单理由及初始交易计划？不会删除实际交易。')
    button(tree, '确认删除'); button(tree, '取消删除')
    expect(elements(tree).some(element => element.type === DecisionRiskOverlay)).toBe(false)
    expect(elements(tree).find(element => element.props.className === 'mp-bias-form')?.props.inert).toBe(true)
    expect(storage.get(storageKey)).toContain('尚未保存的新背景')
    expect(instance.onDelete).not.toHaveBeenCalled()
    expect(instance.onSave).not.toHaveBeenCalled()
    expect(instance.onCancel).not.toHaveBeenCalled()
    expect(actions).toEqual([])
  })

  it('discards the persistent draft before deleting and never routes deletion through save or cancel', () => {
    const instance = editor()
    let tree = instance.render()
    click(button(tree, '删除本根K线理由'))
    tree = instance.render()
    click(button(tree, '确认删除'))
    expect(actions).toEqual([`remove:${storageKey}`, 'delete'])
    expect(instance.onDelete).toHaveBeenCalledOnce()
    expect(instance.onSave).not.toHaveBeenCalled()
    expect(instance.onCancel).not.toHaveBeenCalled()
    expect(storage.has(storageKey)).toBe(false)
    window.dispatchEvent(new Event('pagehide'))
    expect(storage.has(storageKey)).toBe(false)
  })

  it('cancels only deletion, retaining the draft and price overlay so the normal save still works', () => {
    const instance = editor()
    let tree = instance.render()
    editBackground(tree, '保留的新背景')
    tree = instance.render()
    click(button(tree, '删除本根K线理由'))
    tree = instance.render()
    click(button(tree, '取消删除'))
    tree = instance.render()
    expect(elements(tree).some(element => element.props.role === 'alertdialog')).toBe(false)
    expect(elements(tree).some(element => element.type === DecisionRiskOverlay)).toBe(true)
    expect(storage.get(storageKey)).toContain('保留的新背景')
    expect(actions).toEqual([])
    click(button(tree, '保存'))
    expect(instance.onSave).toHaveBeenCalledWith('保留的新背景', expect.arrayContaining([
      expect.objectContaining({ bias: 'long', reasons: ['原理由'] }),
    ]))
    expect(instance.onDelete).not.toHaveBeenCalled()
    expect(instance.onCancel).not.toHaveBeenCalled()
  })

  it.each(['Escape', 'close'] as const)('%s dismisses confirmation while keeping the editor and its draft open', action => {
    const instance = editor()
    let tree = instance.render()
    click(button(tree, '删除本根K线理由'))
    tree = instance.render()
    if (action === 'Escape') {
      const event = new KeyEvent('Escape')
      window.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    } else (card(tree).props.onClose as () => void)()
    tree = instance.render()
    expect(elements(tree).some(element => element.props.role === 'alertdialog')).toBe(false)
    button(tree, '保存')
    expect(storage.has(storageKey)).toBe(true)
    expect(actions).toEqual([])
  })

  it.each([undefined, 'ctrl', 'meta'] as const)('blocks %s Enter from saving, deleting, confirming prices or reaching later global handlers', modifier => {
    const instance = editor()
    let tree = instance.render()
    click(button(tree, '删除本根K线理由'))
    instance.render()
    const laterGlobalHandler = vi.fn()
    window.addEventListener('keydown', laterGlobalHandler)
    const event = new KeyEvent('Enter', modifier)
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(laterGlobalHandler).not.toHaveBeenCalled()
    tree = instance.render()
    button(tree, '确认删除')
    expect(instance.onDelete).not.toHaveBeenCalled()
    expect(instance.onSave).not.toHaveBeenCalled()
    expect(storage.has(storageKey)).toBe(true)
    click(button(tree, '取消删除'))
    tree = instance.render()
    // A blocked Enter did not silently confirm the active price plan.
    button(tree, '确认价格线 · Enter')
  })
})
