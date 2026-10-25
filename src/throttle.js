'use strict';

/**
 * Token bucket. consume(n) records n bytes and returns how many ms the caller
 * should pause its stream to stay under the rate. rate 0 = unlimited.
 */
class Throttle {
  constructor(rate = 0) { this.setRate(rate); }
  setRate(rate) {
    this.rate = Math.max(0, Number(rate) || 0);
    this.tokens = this.rate;
    this.last = Date.now();
  }
  consume(n) {
    if (!this.rate) return 0;
    const now = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    this.tokens -= n;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
  }
}

module.exports = { Throttle };
