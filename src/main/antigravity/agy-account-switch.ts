// Selecting another saved account rewrites agy's one login. A running `agy acp` keeps the login it
// started with and writes it back when it refreshes its token, undoing the switch. So the switch
// waits: chat starts hold, running turns finish, every chat's agy exits, and only then is the new
// login written. A turn that never ends gives the switch up after SWITCH_WAIT_MS, changing nothing.

import type { AntigravityAccountState } from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import { releaseIdleChatsOnOtherAccount } from '../native-chat/agent-session-wire/host/structured-agent-session-account-switch'
import type { AcpLaunchGate } from '../acp/launch/acp-launch-gate'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { AGY_HOST_LOGIN, type AgyLoginRevision } from './agy-login-revision'
import { ANTIGRAVITY_LAUNCH_GATE } from './antigravity-chat-account'
import type { AntigravityAccountService } from './native-account-service'

const SWITCH_WAIT_MS = 5 * 60_000
const CHECK_MS = 2_000
// Under the account rows' 20 s call timeout; a longer wait answers with the switch's progress.
const REPLY_WAIT_MS = 5_000

type SwitchHost = Parameters<typeof releaseIdleChatsOnOtherAccount>[0]

export type AgyAccountSwitchDeps = {
  gate: Pick<AcpLaunchGate, 'runAfterChats'>
  login: Pick<AgyLoginRevision, 'beginSwitch'>
  host: () => SwitchHost
  now?: () => number
  waitMs?: number
  checkMs?: number
  replyMs?: number
}

function stillRunning(count: number): string {
  return count === 1
    ? '1 Antigravity chat is still running. Stop it or let it finish'
    : `${count} Antigravity chats are still running. Stop them or let them finish`
}

export class AgyAccountSwitch {
  private switching: { accountId: string; waitingForChats: number } | null = null
  private failed: { accountId: string; message: string } | null = null

  constructor(private readonly deps: AgyAccountSwitchDeps) {}

  /** The switch under way, or why the last one that answered early didn't happen. */
  withProgress(state: AntigravityAccountState): AntigravityAccountState {
    if (this.switching) {
      return { ...state, switching: { ...this.switching } }
    }
    return this.failed ? { ...state, switchFailed: { ...this.failed } } : state
  }

  /** `moved` runs, before any chat starts again, once agy holds the selected login. Answers with
   *  the switch's progress when it still waits after REPLY_WAIT_MS; it goes on in the background. */
  async select(
    service: Pick<AntigravityAccountService, 'listAccounts' | 'selectAccount'>,
    accountId: string,
    moved: () => void
  ): Promise<AntigravityAccountState> {
    const apply = async () => {
      let switched = false
      const state = await service.selectAccount(accountId, () => (switched = true))
      if (switched) {
        moved()
      }
      return state
    }
    const active = (await service.listAccounts()).activeAccountId
    if (this.switching) {
      throw new Error('Antigravity is already switching accounts. Try again after it finishes.')
    }
    // agy already holds it: no login changes, so no chat needs to stop.
    if (active === accountId) {
      return apply()
    }
    this.failed = null
    const progress = { accountId, waitingForChats: 0 }
    this.switching = progress
    let answered = false
    let marker: ReturnType<AgyLoginRevision['beginSwitch']> | null = null
    const done = this.deps.gate
      .runAfterChats(async (runningChats) => {
        marker = this.deps.login.beginSwitch()
        await this.drain(runningChats, marker.committed, (count) => {
          progress.waitingForChats = count
        })
      }, apply)
      .catch((error: unknown) => {
        if (answered) {
          this.failed = {
            accountId,
            message: error instanceof Error ? error.message : String(error)
          }
        }
        throw error
      })
      .finally(() => {
        marker?.end()
        if (this.switching === progress) {
          this.switching = null
        }
      })
    const replyMs = this.deps.replyMs ?? REPLY_WAIT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const early = await Promise.race([
      done,
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), replyMs)))
    ]).finally(() => clearTimeout(timer))
    if (early) {
      return early
    }
    answered = true
    done.catch(() => {})
    return this.withProgress(await service.listAccounts())
  }

  /** Stops each chat's agy as soon as its turn and owed work allow, until none runs. */
  private async drain(
    runningChats: () => number,
    committed: () => boolean,
    report: (count: number) => void
  ): Promise<void> {
    const now = this.deps.now ?? Date.now
    const deadline = now() + (this.deps.waitMs ?? SWITCH_WAIT_MS)
    for (;;) {
      // A chat busy past the deadline must not hold the check (and every start) beyond it.
      await withTimeout(
        releaseIdleChatsOnOtherAccount(this.deps.host(), 'antigravity', committed),
        Math.max(0, deadline - now()),
        undefined
      )
      const running = runningChats()
      report(running)
      if (running === 0) {
        return
      }
      if (now() >= deadline) {
        throw new Error(
          `Antigravity didn't switch accounts: ${stillRunning(running)}, then select the account again.`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, this.deps.checkMs ?? CHECK_MS))
    }
  }
}

/** This host's switch, over the chats that run agy here. */
export const AGY_HOST_ACCOUNT_SWITCH = new AgyAccountSwitch({
  gate: ANTIGRAVITY_LAUNCH_GATE,
  login: AGY_HOST_LOGIN,
  host: getStructuredAgentSessionHost
})
