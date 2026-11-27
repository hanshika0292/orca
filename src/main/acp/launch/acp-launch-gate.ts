// Fence chat starts during host account/runtime changes to prevent stale writes or deleted-file use.

import '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { abortSignalReason } from '../../../shared/concurrency/abort-signal-reason'
import type { ProviderAcquisitionConnection } from '../../provider-process/provider-acquisition-starts'

type GateEntry = { left: Promise<void>; chat: boolean }

export class AcpLaunchGate {
  private operating = false
  /** Settles when an operation that holds chat starts (rather than refusing them) ends. */
  private held: Promise<void> | null = null
  private readonly starts = new Map<AbortController, GateEntry>()
  private readonly retained = new Set<ProviderAcquisitionConnection>()
  private readonly chats = new Set<ProviderAcquisitionConnection>()
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

  /** Retain spawned children even after acquisition finishes, before their chats are loaded. */
  retain(connection: ProviderAcquisitionConnection, chat = false): void {
    this.retained.add(connection)
    if (chat) {
      this.chats.add(connection)
    }
    connection.onExit(() => {
      this.retained.delete(connection)
      this.chats.delete(connection)
    })
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
   *  it, chat starts under way finish, other starts are cancelled, and `drain` returns once it has
   *  seen both counts reach 0 (`chats`: chat processes and chat starts; `others`: cancelled starts
   *  not yet ended). Everything else started here is stopped before `work`. */
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
      await drain(() => {
        const chatStarts = [...this.starts.values()].filter((entry) => entry.chat).length
        return { chats: this.chats.size + chatStarts, others: this.starts.size - chatStarts }
      })
      await this.stopRetained()
      return await work()
    } finally {
      this.operating = false
      this.held = null
      released.resolve()
    }
  }

  private begin(): void {
    if (this.operating) {
      throw new Error(this.refusal)
    }
    this.operating = true
  }

  private async stopRetained(): Promise<void> {
    const owners = [...this.retained]
    const closes = await Promise.allSettled(owners.map((owner) => owner.close()))
    closes.forEach((close, index) => {
      const result = close.status === 'fulfilled' ? close.value : false
      if (typeof result === 'boolean' ? result : result.root === 'exited') {
        this.retained.delete(owners[index])
        this.chats.delete(owners[index])
      }
    })
    if (this.retained.size > 0) {
      throw new Error(`${this.label} could not be stopped on this host. Try again.`)
    }
  }
}
