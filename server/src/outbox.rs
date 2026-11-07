//! A member's outbound queue: the handle every task uses to message a client.
//!
//! The queue is bounded, and what happens when it fills depends on the message:
//!
//! - **Lossy** traffic — `state` positions (the next tick supersedes them) and
//!   relayed `signal`s (bulk a peer controls) — is queued only while the tail
//!   reserved for control messages is free, so no amount of it can crowd one
//!   out.
//! - **Control** messages — presence, proximity, space, page, chat — are never
//!   replayed: one that cannot be queued would leave the client's view wrong
//!   for good (a peer it still believes is near, a link it never tears down).
//!   A client that far behind is disconnected instead, and starts over from a
//!   fresh `welcome`.

use std::sync::Arc;

use tokio::sync::mpsc::{self, error::TrySendError};
use tokio::sync::Notify;

use crate::protocol::ServerMsg;

/// Slots kept free in each peer's outbound channel for control messages: lossy
/// traffic stops once a client is this close to full (out of `CHANNEL_CAP` in
/// `ws.rs`), so a backed-up client queues control behind at most a few seconds
/// of stale positions.
pub const CONTROL_RESERVE: usize = 192;

#[derive(Clone, Debug)]
pub struct Outbox {
    tx: mpsc::Sender<ServerMsg>,
    kick: Arc<Notify>,
}

impl From<mpsc::Sender<ServerMsg>> for Outbox {
    fn from(tx: mpsc::Sender<ServerMsg>) -> Self {
        Self {
            tx,
            kick: Arc::new(Notify::new()),
        }
    }
}

impl Outbox {
    /// Queue a control message. A full queue disconnects the client.
    pub fn send(&self, msg: ServerMsg) {
        if let Err(TrySendError::Full(_)) = self.tx.try_send(msg) {
            self.kick();
        }
    }

    /// Queue a message that may be lost, unless that would eat into the control
    /// reserve.
    pub fn send_lossy(&self, msg: ServerMsg) {
        if self.tx.capacity() > CONTROL_RESERVE {
            let _ = self.tx.try_send(msg);
        }
    }

    /// Have the connection behind this outbox closed.
    pub fn kick(&self) {
        // `notify_one` keeps a permit when nobody is waiting yet, so a kick
        // between two reads is not lost.
        self.kick.notify_one();
    }

    /// Resolves once the connection has been kicked.
    pub async fn kicked(&self) {
        self.kick.notified().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lossy_traffic_leaves_the_control_reserve_free() {
        let (tx, mut rx) = mpsc::channel(CONTROL_RESERVE + 2);
        let out = Outbox::from(tx);
        for _ in 0..10 {
            out.send_lossy(ServerMsg::Pong);
        }
        // Only the slots above the reserve took lossy traffic.
        for _ in 0..CONTROL_RESERVE {
            out.send(ServerMsg::Pong);
        }
        let mut queued = 0;
        while rx.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, CONTROL_RESERVE + 2);
        // …and no control message was refused, so nobody was kicked.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), out.kicked())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_control_message_that_finds_the_queue_full_kicks_the_client() {
        let (tx, _rx) = mpsc::channel(1);
        let out = Outbox::from(tx);
        out.send(ServerMsg::Pong);
        out.send(ServerMsg::Pong); // no room
        tokio::time::timeout(std::time::Duration::from_millis(10), out.kicked())
            .await
            .expect("kicked");
    }
}
