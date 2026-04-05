/**
 * rate_limiter.js
 * 滑动窗口频率控制器
 * 确保每分钟发送消息不超过 maxCount 条
 */

export class RateLimiter {
  /**
   * @param {number} maxCount  - 窗口内最大发送数，默认 5
   * @param {number} windowMs  - 窗口时长（ms），默认 60000（1分钟）
   */
  constructor(maxCount = 5, windowMs = 60000) {
    this.maxCount = maxCount;
    this.windowMs = windowMs;
    this.timestamps = []; // 记录每次发送的时间戳
  }

  /**
   * 检查并申请一个发送配额
   * 如果当前窗口已满，自动等待至窗口刷新
   */
  async check() {
    const now = Date.now();
    // 清理窗口外的旧记录
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxCount) {
      // 计算需要等待的时间：等到最早的记录滑出窗口
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 100; // +100ms buffer
      console.log(`[RateLimiter] 频率超限，等待 ${waitMs}ms 后继续`);
      await sleep(waitMs);
      // 递归重新检查（等待后窗口可能还有其他记录）
      return this.check();
    }

    // 记录本次发送时间
    this.timestamps.push(Date.now());
  }

  /** 重置计数器 */
  reset() {
    this.timestamps = [];
  }

  /** 获取当前窗口内已使用配额 */
  getUsed() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    return this.timestamps.length;
  }

  /** 获取距离下次可发送的等待时间（ms），0 表示立即可发 */
  getWaitTime() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length < this.maxCount) return 0;
    return this.windowMs - (now - this.timestamps[0]) + 100;
  }
}

/**
 * 随机延迟
 * @param {number} minMs - 最小延迟（ms）
 * @param {number} maxMs - 最大延迟（ms）
 */
export function randomDelay(minMs = 1000, maxMs = 5000) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(delay);
}

/**
 * Promise 形式的 sleep
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
