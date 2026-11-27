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
  const chat = { alive: true, busy: true }
  gate.retain(
    {
      close: async () => true,
      onExit: (listener) => exits.push(listener)
    },
    true
  )
  // The host's own retirement stops an agent only between turns, as an account switch asks it to.
  const host = {
    loadedSessionIds: () => (chat.alive ? ['chat'] : []),
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
  await new Promise((resolve) => setTimeout(resolve, 30))
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

  await vi.waitFor(() =>
    expect(rig.accountSwitch.withProgress({} as never).switchFailed?.message).toContain(
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
