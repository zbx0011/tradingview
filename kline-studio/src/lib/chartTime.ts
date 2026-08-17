import { TickMarkType, type BusinessDay, type Time } from 'lightweight-charts'

interface TimeParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

const beijingDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function businessDay(time: Exclude<Time, number>): BusinessDay | null {
  if (typeof time === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(time)
    if (!match) return null
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  }
  return time
}

function timeParts(time: Time): TimeParts | null {
  if (typeof time !== 'number') {
    const day = businessDay(time)
    if (!day) return null
    return {
      year: String(day.year).padStart(4, '0'),
      month: String(day.month).padStart(2, '0'),
      day: String(day.day).padStart(2, '0'),
      hour: '00',
      minute: '00',
      second: '00',
    }
  }
  const parts = beijingDateTimeFormatter.formatToParts(new Date(time * 1000))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

export function formatBeijingChartTime(time: Time): string {
  const parts = timeParts(time)
  if (!parts) return ''
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

export function formatBeijingTickMark(time: Time, tickMarkType: TickMarkType): string | null {
  const parts = timeParts(time)
  if (!parts) return null
  if (tickMarkType === TickMarkType.Year) return parts.year
  if (tickMarkType === TickMarkType.Month) return `${parts.month}月`
  if (tickMarkType === TickMarkType.DayOfMonth) return `${parts.month}/${parts.day}`
  if (tickMarkType === TickMarkType.TimeWithSeconds) return `${parts.hour}:${parts.minute}:${parts.second}`
  return `${parts.hour}:${parts.minute}`
}
