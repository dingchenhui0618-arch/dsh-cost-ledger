import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import Module from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)

test('the client half registers the 成本账 conversation view and tears it down', function () {
  const style = {
    dataset: {},
    textContent: '',
    removed: false,
    remove: function () { this.removed = true },
  }
  const document = {
    head: { appendChild: function () {} },
    createElement: function () { return style },
  }
  const previousDocument = globalThis.document
  globalThis.document = document
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'react') {
      return { createElement: function () { return null } }
    }
    if (request === './client-css.cjs') {
      return require('../src/client-css.cjs')
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    const client = require('../src/client.cjs')
    assert.equal(client.name, 'dsh-cost-ledger')
    assert.deepEqual(client.inject, ['slots'])
    const disposers = []
    let registered
    const ctx = {
      effect: function (fn) {
        const dispose = fn()
        disposers.push(dispose)
        return dispose
      },
      slots: {
        inject: function (name, factory) {
          assert.equal(name, 'conversation.view')
          assert.equal(typeof factory, 'function')
          const dispose = factory()
          disposers.push(dispose)
        },
        register: function (options, component) {
          registered = { options, component }
          return function () {}
        },
      },
    }
    assert.doesNotThrow(function () { client.apply(ctx) })
    assert.ok(registered)
    assert.equal(registered.options.name, 'conversation.view')
    assert.equal(registered.options.id, 'cost-ledger')
    assert.equal(registered.options.order, 35)
    assert.equal(registered.options.label, '成本账')
    assert.equal(typeof registered.component, 'function')
    assert.match(style.textContent, /\.cd-root/)
    assert.match(style.textContent, /\.cd-table/)
    assert.match(style.textContent, /\.cd-preview/)
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
    assert.equal(style.removed, true)
  } finally {
    Module._load = originalLoad
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('every CSS class referenced by the client source has a rule', function () {
  const css = require('../src/client-css.cjs')
  assert.equal(typeof css, 'string')
  for (const name of ['cd-root', 'cd-head', 'cd-stats', 'cd-scroll', 'cd-preview', 'cd-warn-box', 'cd-error']) {
    assert.match(css, new RegExp('\\.' + name))
  }
})
