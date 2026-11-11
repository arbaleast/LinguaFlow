/**
 * 时钟抽象（浏览器优先架构的可测试性基础）。
 *
 * 领域层不得直接调用 `Date.now()` / `new Date()`，否则单元测试无法稳定断言。
 * 所有需要当前时间的纯函数都接受一个 `Clock` 依赖，由调用方注入。
 */

/** 时钟接口：只暴露「现在」这一个能力。 */
export interface Clock {
  /** 返回当前时刻（UTC 语义的绝对时刻）。 */
  now(): Date
}

/** 系统时钟：读取宿主环境的当前时间。 */
export const systemClock: Clock = {
  now: () => new Date(),
}

/**
 * 固定时钟：始终返回同一时刻，用于确定性测试。
 *
 * @param instant 固定时刻（ISO 8601 字符串或毫秒时间戳）
 */
export function fixedClock(instant: string | number | Date): Clock {
  const at = instant instanceof Date ? new Date(instant.getTime()) : new Date(instant)
  return { now: () => new Date(at.getTime()) }
}

/** 可手动推进的时钟，用于测试超时/退避等时间相关逻辑。 */
export function mutableClock(
  start: string | number | Date = 0,
): Clock & { advance(ms: number): void; set(instant: string | number | Date): void } {
  let current =
    start instanceof Date
      ? start.getTime()
      : typeof start === 'number'
        ? start
        : new Date(start).getTime()
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms
    },
    set: (instant: string | number | Date) => {
      current =
        instant instanceof Date
          ? instant.getTime()
          : typeof instant === 'number'
            ? instant
            : new Date(instant).getTime()
    },
  }
}
