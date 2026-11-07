//! Refilling allowances (token buckets): how much of something a caller may
//! do in a burst, and how fast that comes back.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// One allowance: `burst` at most, `per_sec` back.
pub struct Allowance {
    left: f64,
    burst: f64,
    per_sec: f64,
    at: Instant,
}

impl Allowance {
    pub fn new(burst: f64, per_sec: f64) -> Self {
        Self {
            left: burst,
            burst,
            per_sec,
            at: Instant::now(),
        }
    }

    /// Spend `n`; false once the allowance is used up.
    pub fn take(&mut self, n: f64) -> bool {
        self.refill();
        if self.left < n {
            return false;
        }
        self.left -= n;
        true
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let back = now.duration_since(self.at).as_secs_f64() * self.per_sec;
        self.left = (self.left + back).min(self.burst);
        self.at = now;
    }

    /// Back to a full burst, i.e. no different from a fresh one.
    fn is_full(&mut self) -> bool {
        self.refill();
        self.left >= self.burst
    }
}

/// Above this many keys, the ones whose allowance has fully come back are
/// forgotten (a fresh one is the same thing).
const PRUNE_AT: usize = 4096;

/// One allowance per key (an account, an address), all of the same shape.
pub struct Allowances {
    burst: f64,
    per_sec: f64,
    by_key: Mutex<HashMap<String, Allowance>>,
}

impl Allowances {
    pub fn new(burst: f64, per_sec: f64) -> Self {
        Self {
            burst,
            per_sec,
            by_key: Mutex::new(HashMap::new()),
        }
    }

    /// Spend one of `key`'s; false once it is used up.
    pub fn take(&self, key: &str) -> bool {
        let mut by_key = self.by_key.lock().expect("allowances lock");
        if by_key.len() >= PRUNE_AT {
            by_key.retain(|_, a| !a.is_full());
        }
        by_key
            .entry(key.to_string())
            .or_insert_with(|| Allowance::new(self.burst, self.per_sec))
            .take(1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_key_has_its_own_burst() {
        let limits = Allowances::new(2.0, 0.0);
        assert!(limits.take("a"));
        assert!(limits.take("a"));
        assert!(!limits.take("a"), "a's burst is spent");
        assert!(limits.take("b"), "b's is untouched");
    }
}
