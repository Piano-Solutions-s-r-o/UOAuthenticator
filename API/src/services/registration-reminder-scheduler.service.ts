import { REGISTRATION_REMINDER_TICK_MS } from '../config/constants.js';
import { sweepRegistrationReminders, type RegistrationReminderSweep } from './registration-reminder.service.js';

type SchedulerLog = {
  info: (details: object, message: string) => void;
  warn: (details: object, message: string) => void;
  error: (details: object, message: string) => void;
};

/**
 * HUGO-2424: sweeps for registrations due their one reminder every few minutes. Every instance runs
 * it; the claim in `sweepRegistrationReminders` makes sure one of them sends. Started only behind
 * UOA_REGISTRATION_REMINDER_ENABLED.
 */
export function startRegistrationReminderScheduler(params: {
  log: SchedulerLog;
  runSweep?: (log: SchedulerLog) => Promise<RegistrationReminderSweep>;
  intervalMs?: number;
}): { stop: () => void } {
  const runSweep = params.runSweep ?? ((log) => sweepRegistrationReminders({ log }));
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await runSweep(params.log);
      if (result.claimed > 0) params.log.info(result, 'registration reminder sweep completed');
    } catch (error) {
      params.log.error({ err: error }, 'registration reminder sweep failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), params.intervalMs ?? REGISTRATION_REMINDER_TICK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
