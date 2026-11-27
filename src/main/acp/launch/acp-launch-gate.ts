// Fence chat starts during host account/runtime changes to prevent stale writes or deleted-file use.

import '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { abortSignalReason } from '../../../shared/concurrency/abort-signal-reason'
import type { ProviderAcquisitionConnection } from '../../provider-process/provider-acquisition-starts'

export class AcpLaunchGate {
  private operating = false
  /** Settles when an operation that holds chat starts (rather than refusing them) ends. */
  private held: Promise<void> | null = null
  private readonly starts = new Map<AbortController, Promise<void>>()
  private readonly retained = new Set<ProviderAcquisitionConnection>()
  private readonly chats = new Set<ProviderAcquisitionConnection>()
  private readonly refusal: string

  constructor(private readonly label: string) {
    this.refusal = `${label}'s setup is changing on this host. Try again after it finishes.`
  }

  /** Refuses starts during an operation and aborts existing starts when one begins. */
  enter(signal: AbortSignal | undefined): { signal: AbortSignal; leave: () => void } {
    if (this.operating) {
      throw new AgentSessionPreSpawnError(new Error(this.refusal), {
        reason: 'accountSwitchInProgress'
      })
    }
    const controller = new AbortController()
    const left = Promise.withResolvers<void>()
    this.starts.set(controller, left.promise)
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
    return this.enter(signal)
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
    return this.operate(true, stopLive, work)
  }

  /** Like `run` for a change that waits for chats instead of stopping them: chat starts wait for
   *  it, starts under way finish, and `drain` returns once it has seen `runningChats()` reach 0.
   *  Every other process started here is stopped before `work`. */
  async runAfterChats<T>(
    drain: (runningChats: () => number) => Promise<void>,
    work: () => Promise<T>
  ): Promise<T> {
    return this.operate(false, () => drain(() => this.chats.size), work, Promise.withResolvers())
  }

  private async operate<T>(
    abortStarts: boolean,
    stopLive: () => Promise<void>,
    work: () => Promise<T>,
    holdStarts?: PromiseWithResolvers<void>
  ): Promise<T> {
    if (this.operating) {
      throw new Error(this.refusal)
    }
    this.operating = true
    this.held = holdStarts?.promise ?? null
    try {
      const starts = [...this.starts]
      if (abortStarts) {
        starts.forEach(([controller]) => controller.abort())
      }
      await Promise.all(starts.map(([, left]) => left))
      await stopLive()
      await this.stopRetained()
      return await work()
    } finally {
      this.operating = false
      this.held = null
      holdStarts?.resolve()
    }
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
