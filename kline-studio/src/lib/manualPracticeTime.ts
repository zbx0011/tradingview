/** Saved practice/review events use epoch milliseconds; market candles use seconds. */
const beijingEventFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

function eventDate(value: number | null | undefined): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function manualPracticeTimeIso(value: number | null | undefined): string | undefined {
  return eventDate(value)?.toISOString()
}

export function formatManualPracticeTime(value: number | null | undefined): string {
  const date = eventDate(value)
  if (!date) return '未记录'
  const parts = Object.fromEntries(beijingEventFormatter.formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}
