import { config } from "../config";
import { logger } from "../logging/logger";
import { sweepRunsTotal } from "../metrics";
import { schedulePersist } from "../persistence";
import { sweepLoanLifecycle } from "../services/liquidation.service";

const log = logger.child({ component: "lifecycle" });

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
let currentTick: Promise<void> = Promise.resolve();

async function tick(): Promise<void> {
  // Skip the tick rather than overlap: a sweep that is still writing loan
  // state must not be re-entered, or the same loan could be liquidated twice.
  if (running) {
    log.warn("previous sweep still running, skipping this tick");
    return;
  }

  running = true;
  try {
    const result = await sweepLoanLifecycle();
    sweepRunsTotal.inc({ outcome: "success" });

    if (result.enteredGrace.length > 0 || result.defaulted.length > 0) {
      log.info(
        {
          loansEvaluated: result.loansEvaluated,
          enteredGrace: result.enteredGrace.length,
          defaulted: result.defaulted.length,
          totalForfeitedUsd: result.totalForfeitedUsd,
        },
        "swept open loans",
      );
    }
  } catch (err) {
    sweepRunsTotal.inc({ outcome: "failure" });
    log.error({ err }, "sweep failed");
  } finally {
    running = false;
    schedulePersist();
  }
}

export function startLifecycleJob(): void {
  if (timer) return;

  const intervalMs = config.jobs.lifecycleIntervalMinutes * 60 * 1000;

  timer = setInterval(() => { currentTick = tick(); }, intervalMs);

  // Do not hold the event loop open on account of the scheduler alone.
  timer.unref?.();

  log.info({ intervalMinutes: config.jobs.lifecycleIntervalMinutes }, "loan lifecycle job started");

  // Sweep once at boot so a restart does not leave overdue loans unexamined
  // until the first interval elapses.
  currentTick = tick();
}

export function stopLifecycleJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
    log.info("loan lifecycle job stopped");
  }
}

/**
 * Resolves once any sweep tick already in progress finishes. Resolves
 * immediately if none is running. Lets shutdown wait for a tick to finish
 * writing loan state rather than exiting mid-sweep.
 */
export function waitForCurrentTick(): Promise<void> {
  return currentTick;
}
