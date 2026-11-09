const pragueClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Minutes since local midnight in Europe/Prague, daylight saving included (never a fixed offset). */
export function pragueMinuteOfDay(date: Date): number {
  const parts = pragueClock.formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return read('hour') * 60 + read('minute');
}

/** True while Prague local time is in [startHour:00, endHour:00). */
export function isPragueHourWindow(date: Date, startHour: number, endHour: number): boolean {
  const minute = pragueMinuteOfDay(date);
  return minute >= startHour * 60 && minute < endHour * 60;
}
