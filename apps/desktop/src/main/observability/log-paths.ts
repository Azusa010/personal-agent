import { join, parse } from "path"
import { file } from "zod"

export const LOG_DIR_NAME = 'logs'

export const resolveLogDir = (appDataPath: string) => {
    return join(appDataPath, LOG_DIR_NAME)
}

export const dayKey = (date: Date): string => {
    const d = new Date(date)
    const yy = d.getFullYear()
    const mm = d.getMonth() + 1
    const dd = d.getDate()
    return `${yy}-${mm.toString().padStart(2, '0')}-${dd.toString().padStart(2, '0')}`
}

export const logFileName = (day: string) => {
    return `error-${day}.jsonl`
}

export const rotatedFileName = (day: string, rot: number) => {
    return `error-${day}.${rot}.jsonl`
}

export const parseLogDay = (fileName: string) => {
    const re = /^error-([0-9]{4})-([0-9]{2})-([0-9]{2})(?:\.([0-9]+))?\.jsonl$/
    const parsed = re.exec(fileName)
    if (parsed) {
        const [, year, month, day, shard] = parsed;
        const y = Number(year)
        const m = Number(month) - 1
        const d = Number(day)
        const probe = new Date(y, m, d)
        if (probe.getFullYear() !== y || probe.getMonth() !== m || probe.getDate() !== d) {
            return null
        }
        return `${year}-${month}-${day}` 
    }
    return null
}