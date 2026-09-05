import { config } from "../config";
import { sweepLoanLifecycle } from "../services/liquidation.service";

/**
 * Loan Lifecycle Job (§7.3)
 *
 * The §7.3 sequence is driven by a scheduled job rather than by a request:
 * nobody calls an endpoint when a payment fails to arrive, so overdue
 * installments, grace-period expiry and default have to be detected by the
 * backend on its own clock.
 *
 * V1 runs an in-process interval, which is adequate for a single instance.
 * Running more than one instance would run the sweep more than once per
 * tick, so a multi-instance deployment needs an external scheduler or a
 * lock — see the note in the README.
 */

let timer: NodeJS.Timeout | undefined;
let running = false;

async function tick(): Promise<void> {
  // Skip the tick rather than overlap: a sweep that is still writing loan
  // state must not be re-entered, or the same loan could be liquidated twice.
  if (running) {
    console.log("[Lifecycle]: previous sweep still running, skipping this tick");
    return;
  }

  running = true;
  try {
    const result = await sweepLoanLifecycle();

    if (result.enteredGrace.length > 0 || result.defaulted.length > 0) {
      console.log(
        `[Lifecycle]: swept ${result.loansEvaluated} open loan(s) — ` +
        `${result.enteredGrace.length} entered grace, ` +
        `${result.defaulted.length} defaulted, ` +
        `${result.totalForfeitedUsd} USDC forfeited`,
      );
    }
  } catch (err) {
    console.error(`[Lifecycle]: sweep failed — ${(err as Error).message}`);
  } finally {
    running = false;
  }
}

export function startLifecycleJob(): void {
  if (timer) return;

  const intervalMs = config.jobs.lifecycleIntervalMinutes * 60 * 1000;

  timer = setInterval(tick, intervalMs);

  // Do not hold the event loop open on account of the scheduler alone.
  timer.unref?.();

  console.log(
    `[Lifecycle]: loan lifecycle job started, sweeping every ` +
    `${config.jobs.lifecycleIntervalMinutes} minute(s)`,
  );

  // Sweep once at boot so a restart does not leave overdue loans unexamined
  // until the first interval elapses.
  void tick();
}

export function stopLifecycleJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
    console.log("[Lifecycle]: loan lifecycle job stopped");
  }
}
