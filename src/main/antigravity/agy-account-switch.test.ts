import { expect, it, vi } from 'vitest'
import { AcpLaunchGate } from '../acp/launch/acp-launch-gate'
import { AgyAccountSwitch } from './agy-account-switch'
import { AgyLoginRevision } from './agy-login-revision'
import { credential, harness } from './native-account-test-fixtures'

const HOME = { variable: 'GEMINI_HOME', path: '/home/dev/.gemini' }

/** agy holds account a; b is saved too. One chat's agy runs a turn on a. */
async function switchRig(options: { waitMs?: number } = {}) {
  const h = harness(credential('b'))
  await h.service.addCurrentAccount()
  h.setNative(credential('a'))
  const accounts = (await h.service.addCurrentAccount()).accounts
  const b = accounts.find((account) => account.subject === 'b')!.id
  const order: string[] = []
  const write = h.backend.write
  h.backend.write = vi.fn(async (contents, expected) => {
    order.push('login written')
    return write(contents, expected)
  })
  const gate = new AcpLaunchGate('Antigravity')
  const login = new AgyLoginRevision()
  const exits: (() => void)[] = []
  const chat = { alive: true, busy: true, passes: 0 }
  gate.retain(
    {
      close: async () => true,
      onExit: (listener) => exits.push(listener)
    },
    true
  )
  // The host's own retirement stops an agent only between turns, as an account switch asks it to.
  const host = {
    loadedSessionIds: () => {
      chat.passes += 1
      return chat.alive ? ['chat'] : []
    },
    sessionAgent: () => 'antigravity',
    childAccountHome: () => (chat.alive ? HOME : undefined),
    releaseOffAccount: async (_id: string, committed: () => boolean) => {
      if (chat.alive && !chat.busy && committed()) {
        chat.alive = false
        order.push('agy exited')
        exits.forEach((exit) => exit())
      }
    }
  }
  const accountSwitch = new AgyAccountSwitch({
    gate,
    login,
    host: () => host,
    checkMs: 5,
    replyMs: 20,
    waitMs: options.waitMs ?? 60_000
  })
  const select = () => accountSwitch.select(h.service, b, () => login.changed())
  return { h, b, gate, login, chat, order, accountSwitch, select }
}

it("writes the new login only after a busy chat's turn ends and its agy exits, holding new chats until then", async () => {
  const rig = await switchRig()
  const answered = await rig.select()
  expect(answered.switching).toEqual({ accountId: rig.b, waitingForChats: 1 })
  expect(answered.activeAccountId).not.toBe(rig.b)

  let launchedOn: string | null = null
  const start = rig.gate.admit(undefined).then((entered) => {
    launchedOn = rig.login.atLaunch()
    entered.leave()
  })
  // Several checks later the turn still runs: the start waits and nothing is written.
  const checked = rig.chat.passes
  await vi.waitFor(() => expect(rig.chat.passes).toBeGreaterThan(checked + 2))
  expect(launchedOn).toBeNull()
  expect(rig.order).toEqual([])
  expect(rig.h.getNative()).toBe(credential('a'))

  rig.chat.busy = false
  await start
  expect(rig.order).toEqual(['agy exited', 'login written'])
  expect(rig.h.getNative()).toBe(credential('b'))
  // The held start launched on the new login.
  expect(launchedOn).toBe('1')
  const after = rig.accountSwitch.withProgress(await rig.h.service.listAccounts())
  expect(after.activeAccountId).toBe(rig.b)
  expect(after.switching).toBeUndefined()
  expect(after.switchFailed).toBeUndefined()
})

it("gives the switch up without touching agy's login when a turn outlasts the wait", async () => {
  const rig = await switchRig({ waitMs: 40 })
  expect((await rig.select()).switching?.accountId).toBe(rig.b)

  const rows = await rig.h.service.listAccounts()
  await vi.waitFor(() =>
    expect(rig.accountSwitch.withProgress(rows).switchFailed?.message).toContain(
      '1 Antigravity chat is still running'
    )
  )
  expect(rig.order).toEqual([])
  expect(rig.h.getNative()).toBe(credential('a'))
  expect(rig.login.current()).toBe(rig.login.atLaunch())
  // Starts run again, on the login agy kept.
  const entered = await rig.gate.admit(undefined)
  entered.leave()
  expect(rig.login.atLaunch()).toBe('0')
})

it('cancels a model listing under way and writes once it has ended', async () => {
  const rig = await switchRig()
  const listing = rig.gate.enter(undefined)
  rig.chat.busy = false
  await rig.select()
  await vi.waitFor(() => expect(listing.signal.aborted).toBe(true))
  const checked = rig.chat.passes
  await vi.waitFor(() => expect(rig.chat.passes).toBeGreaterThan(checked + 2))
  expect(rig.h.getNative()).toBe(credential('a'))
  listing.leave()
  await vi.waitFor(() => expect(rig.h.getNative()).toBe(credential('b')))
})

it('keeps a login agy signed in to while the switch waited', async () => {
  const rig = await switchRig()
  expect((await rig.select()).switching?.accountId).toBe(rig.b)
  // An in-app sign-in finishes on another account before the busy turn ends.
  rig.login.changed()
  rig.chat.busy = false
  const rows = await rig.h.service.listAccounts()
  await vi.waitFor(() =>
    expect(rig.accountSwitch.withProgress(rows).switchFailed?.message).toContain(
      'agy signed in to another account'
    )
  )
  expect(rig.order).toEqual(['agy exited'])
  expect(rig.h.getNative()).toBe(credential('a'))
})
