// Fence chat starts during host account/runtime changes to prevent stale writes or deleted-file use.

import '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { abortSignalReason } from '../../../shared/concurrency/abort-signal-reason'
import type { ProviderAcquisitionConnection } from '../../provider-process/provider-acquisition-starts'

type GateEntry = { left: Promise<void>; chat: boolean }
/** A process started here: `starting` for a chat start under way (its start is what counts),
 *  `chat` once that chat owns it (it stops only when the chat lets it), `other` for the rest (a
 *  listing, a check, a chat start that failed), which may be stopped. */
type Retained = { kind: 'starting' | 'chat' | 'other'; closing: boolean }

export class AcpLaunchGate {
  private operating = false
  /** Settles when an operation that holds chat starts (rather than refusing them) ends. */
  private held: Promise<void> | null = null
  private readonly starts = new Map<AbortController, GateEntry>()
  private readonly retained = new Map<ProviderAcquisitionConnection, Retained>()
  private readonly refusal: string

  constructor(private readonly label: string) {
    this.refusal = `${label}'s setup is changing on this host. Try again after it finishes.`
  }

  /** Refuses starts during an operation and aborts existing starts when one begins. */
  enter(signal: AbortSignal | undefined, chat = false): { signal: AbortSignal; leave: () => void } {
    if (this.operating) {
      throw new AgentSessionPreSpawnError(new Error(this.refusal), {
        reason: 'accountSwitchInProgress'
      })
    }
    const controller = new AbortController()
    const left = Promise.withResolvers<void>()
    this.starts.set(controller, { left: left.promise, chat })
    return {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      leave: () => {
        this.starts.delete(controller)
        left.resolve()
      }
    }
  }

  /** A chat start: waits out an operation that holds starts, then enters. */
  async admit(signal: AbortSignal | undefined): Promise<ReturnType<AcpLaunchGate['enter']>> {
    const abandoned = (): void => {
      if (signal?.aborted) {
        throw new AgentSessionPreSpawnError(abortSignalReason(signal))
      }
    }
    while (this.held) {
      abandoned()
      const aborted = Promise.withResolvers<void>()
      const onAbort = (): void => aborted.resolve()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await Promise.race([this.held, aborted.promise])
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    }
    abandoned()
    return this.enter(signal, true)
  }

  /** Retain spawned children even after acquisition finishes, before their chats are loaded.
   *  A chat start's process settles as `chat` or `other` through `settle` when the start ends. */
  retain(connection: ProviderAcquisitionConnection, chatStart = false): void {
    this.retained.set(connection, { kind: chatStart ? 'starting' : 'other', closing: false })
    connection.onExit(() => this.retained.delete(connection))
  }

  /** A chat start ended: `owned` when its chat now runs this process. */
  settle(connection: ProviderAcquisitionConnection, owned: boolean): void {
    const retained = this.retained.get(connection)
    if (retained) {
      retained.kind = owned ? 'chat' : 'other'
    }
  }

  /** Stop starts, live chats and retained root processes before running setup changes. */
  async run<T>(stopLive: () => Promise<void>, work: () => Promise<T>): Promise<T> {
    this.begin()
    try {
      const starts = [...this.starts]
      starts.forEach(([controller]) => controller.abort())
      await Promise.all(starts.map(([, entry]) => entry.left))
      await stopLive()
      await this.stopRetained()
      return await work()
    } finally {
      this.operating = false
    }
  }

  /** Like `run` for a change that waits for chats instead of stopping them: chat starts wait for
   *  it, chat starts under way finish, other starts are cancelled and every process no chat owns
   *  is stopped. `drain` returns once `running()` reads 0 and 0: every process started here has
   *  been seen to exit, and no start is under way. */
  async runAfterChats<T>(
    drain: (running: () => { chats: number; others: number }) => Promise<void>,
    work: () => Promise<T>
  ): Promise<T> {
    this.begin()
    const released = Promise.withResolvers<void>()
    this.held = released.promise
    try {
      for (const [controller, entry] of this.starts) {
        if (!entry.chat) {
          controller.abort()
        }
      }
      await drain(() => this.reckon())
      return await work()
    } finally {
      this.operating = false
      this.held = null
      released.resolve()
    }
  }

  /** Chats: processes chats own and chat starts under way (each start once, its process with it).
   *  Others: the rest, each asked to stop again until its exit is seen. */
  private reckon(): { chats: number; others: number } {
    let chats = 0
    let others = 0
    for (const [connection, retained] of this.retained) {
      if (retained.kind !== 'other') {
        chats += retained.kind === 'chat' ? 1 : 0
        continue
      }
      others += 1
      if (!retained.closing) {
        retained.closing = true
        void connection
          .close()
          .catch(() => false)
          .finally(() => (retained.closing = false))
      }
    }
    for (const entry of this.starts.values()) {
      if (entry.chat) {
        chats += 1
      } else {
        others += 1
      }
    }
    return { chats, others }
  }

  private begin(): void {
    if (this.operating) {
      throw new Error(this.refusal)
    }
    this.operating = true
  }

  private async stopRetained(): Promise<void> {
    const owners = [...this.retained.keys()]
    const closes = await Promise.allSettled(owners.map((owner) => owner.close()))
    closes.forEach((close, index) => {
      const result = close.status === 'fulfilled' ? close.value : false
      if (typeof result === 'boolean' ? result : result.root === 'exited') {
        this.retained.delete(owners[index])
      }
    })
    if (this.retained.size > 0) {
      throw new Error(`${this.label} could not be stopped on this host. Try again.`)
    }
  }
}
