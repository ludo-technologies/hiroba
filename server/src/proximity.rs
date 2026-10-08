/// Proximity / hysteresis logic — pure functions with no I/O.
///
/// The server tracks a "connected" set per peer and applies hysteresis so that
/// a pair which hovers right at the boundary does not flap:
///   - Connect:    distance drops BELOW nearRadius (and neither side is DND)
///   - Disconnect: distance rises ABOVE farRadius, or either side turns DND on
///
/// A space may have a walled meeting room (`SpaceDescriptor::meeting_room`).
/// Its wall overrides distance: two peers both inside are near however far
/// apart they stand, and a peer inside is never near a peer outside. Crossing
/// the wall is a single discrete event, so it needs no hysteresis of its own.
///
/// `update_proximity` returns, for each peer, the delta (new connections and
/// dropped connections) since the last call.  The caller applies the delta by
/// emitting `proximity` messages only when non-empty.
///
/// Initiator tie-break (PROTOCOL.md §proximity): the peer with the numerically
/// *smaller* id is always the WebRTC offerer for any pair.
use std::collections::{HashMap, HashSet};

use crate::protocol::{ProximityConnect, Rect};

/// Euclidean distance between two points.
#[inline]
pub fn distance(x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
    let dx = x1 - x0;
    let dy = y1 - y0;
    (dx * dx + dy * dy).sqrt()
}

/// Per-peer position as seen by the proximity engine.
#[derive(Debug, Clone)]
pub struct PeerPos {
    /// Numeric peer id (used for initiator tie-break and lookup).
    pub num_id: u64,
    pub string_id: String,
    pub x: f64,
    pub y: f64,
    /// Do-not-disturb: a DND peer is unreachable — it never enters a new link,
    /// and any live link it holds is torn down (full isolation, FR-11).
    pub dnd: bool,
}

/// Delta for one peer: which peers just became near, which just became far.
#[derive(Debug, Default)]
pub struct ProximityDelta {
    pub connect: Vec<ProximityConnect>,
    pub disconnect: Vec<String>,
}

impl ProximityDelta {
    pub fn is_empty(&self) -> bool {
        self.connect.is_empty() && self.disconnect.is_empty()
    }
}

/// Compute proximity deltas for all peers.
///
/// `positions` — current positions of all peers.
/// `connected_sets` — mutable map from peer string_id → set of string_ids
///    currently considered near.  Updated in-place.
/// `meeting_room` — the space's walled room, if it has one.
///
/// Returns a map from peer string_id → delta (may be empty).
pub fn update_proximity(
    positions: &[PeerPos],
    connected_sets: &mut HashMap<String, HashSet<String>>,
    near_radius: f64,
    far_radius: f64,
    meeting_room: Option<&Rect>,
) -> HashMap<String, ProximityDelta> {
    // Ensure every peer has an entry (even if empty) so we can mutate below.
    for p in positions {
        connected_sets.entry(p.string_id.clone()).or_default();
    }

    let mut deltas: HashMap<String, ProximityDelta> = positions
        .iter()
        .map(|p| (p.string_id.clone(), ProximityDelta::default()))
        .collect();

    // Examine every unique pair (i < j).
    for i in 0..positions.len() {
        for j in (i + 1)..positions.len() {
            let a = &positions[i];
            let b = &positions[j];

            let dist = distance(a.x, a.y, b.x, b.y);
            let a_in = meeting_room.is_some_and(|r| r.contains(a.x, a.y));
            let b_in = meeting_room.is_some_and(|r| r.contains(b.x, b.y));
            // DND on either side makes the pair untouchable: no new link, and
            // an existing link is force-disconnected regardless of distance.
            // A wall between them does the same.
            let blocked = a.dnd || b.dnd || a_in != b_in;
            // Inside the room, distance stops mattering.
            let near = (a_in && b_in) || dist <= near_radius;
            let far = !(a_in && b_in) && dist > far_radius;

            let currently_connected = connected_sets[&a.string_id].contains(&b.string_id);

            if !currently_connected && !blocked && near {
                // New connection: register in both directions.
                connected_sets
                    .get_mut(&a.string_id)
                    .unwrap()
                    .insert(b.string_id.clone());
                connected_sets
                    .get_mut(&b.string_id)
                    .unwrap()
                    .insert(a.string_id.clone());

                // Initiator = peer with numerically smaller id.
                let a_initiates = a.num_id < b.num_id;

                deltas
                    .get_mut(&a.string_id)
                    .unwrap()
                    .connect
                    .push(ProximityConnect {
                        id: b.string_id.clone(),
                        initiator: a_initiates,
                    });
                deltas
                    .get_mut(&b.string_id)
                    .unwrap()
                    .connect
                    .push(ProximityConnect {
                        id: a.string_id.clone(),
                        initiator: !a_initiates,
                    });
            } else if currently_connected && (blocked || far) {
                // Disconnection.
                connected_sets
                    .get_mut(&a.string_id)
                    .unwrap()
                    .remove(&b.string_id);
                connected_sets
                    .get_mut(&b.string_id)
                    .unwrap()
                    .remove(&a.string_id);

                deltas
                    .get_mut(&a.string_id)
                    .unwrap()
                    .disconnect
                    .push(b.string_id.clone());
                deltas
                    .get_mut(&b.string_id)
                    .unwrap()
                    .disconnect
                    .push(a.string_id.clone());
            }
            // Otherwise: no change — hysteresis keeps the current state.
        }
    }

    deltas
}

/// Undo `peer_id`'s `delta` — the exact inverse of what `update_proximity`
/// just recorded for that peer.
///
/// Called when the `proximity` message carrying the delta could not be queued
/// (the peer's outbound channel is full). The connected sets are the tick
/// loop's only memory: a delta it believes was delivered is never recomputed,
/// so a dropped *disconnect* would leave a live P2P link that nothing ever
/// tears down (turning DND on would not silence it), and a dropped *connect*
/// would leave a peer permanently unlinked to someone standing next to them.
/// Rolling back makes the next tick recompute — and therefore resend — the
/// same delta.
///
/// The pair is restored on both sides, so the peer that *did* receive the
/// delta gets it again next tick; `connect` and `disconnect` are both
/// idempotent on the client (PROTOCOL.md §proximity).
pub fn rollback_delta(
    peer_id: &str,
    delta: &ProximityDelta,
    connected_sets: &mut HashMap<String, HashSet<String>>,
) {
    for c in &delta.connect {
        if let Some(set) = connected_sets.get_mut(peer_id) {
            set.remove(&c.id);
        }
        if let Some(set) = connected_sets.get_mut(&c.id) {
            set.remove(peer_id);
        }
    }
    for other in &delta.disconnect {
        // Only restore pairs whose peers are both still tracked — a peer that
        // left the space in the meantime must stay gone.
        if !connected_sets.contains_key(peer_id) || !connected_sets.contains_key(other) {
            continue;
        }
        connected_sets
            .get_mut(peer_id)
            .unwrap()
            .insert(other.clone());
        connected_sets
            .get_mut(other)
            .unwrap()
            .insert(peer_id.to_string());
    }
}

/// Remove a leaving peer from all connected sets and return which other peers
/// need a disconnect delta for it.  Called when a peer leaves the room.
pub fn remove_peer(
    leaving_id: &str,
    connected_sets: &mut HashMap<String, HashSet<String>>,
) -> Vec<String> {
    let was_connected_to: Vec<String> = connected_sets
        .get(leaving_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();

    // Remove the leaving peer's own set.
    connected_sets.remove(leaving_id);

    // Remove the leaving peer from all other sets.
    for other_id in &was_connected_to {
        if let Some(set) = connected_sets.get_mut(other_id.as_str()) {
            set.remove(leaving_id);
        }
    }

    was_connected_to
}

// ---------------------------------------------------------------------------
// Unit tests — pure math, no async required.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(num_id: u64, x: f64, y: f64) -> PeerPos {
        PeerPos {
            num_id,
            string_id: num_id.to_string(),
            x,
            y,
            dnd: false,
        }
    }

    fn dnd_peer(num_id: u64, x: f64, y: f64) -> PeerPos {
        PeerPos {
            dnd: true,
            ..peer(num_id, x, y)
        }
    }

    /// Two peers starting far apart come close → connect delta emitted.
    #[test]
    fn test_near_triggers_connect() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        // Both peers at exactly nearRadius - 1 apart.
        let positions = vec![peer(1, 0.0, 0.0), peer(2, near - 1.0, 0.0)];
        let deltas = update_proximity(&positions, &mut sets, near, far, None);

        // Both should have a connect entry for the other.
        let d1 = &deltas["1"];
        let d2 = &deltas["2"];
        assert_eq!(d1.connect.len(), 1, "peer 1 should connect to peer 2");
        assert_eq!(d2.connect.len(), 1, "peer 2 should connect to peer 1");

        // Peer 1 has smaller id → initiator for peer 1.
        assert!(
            d1.connect[0].initiator,
            "peer 1 (lower id) should be initiator"
        );
        assert!(
            !d2.connect[0].initiator,
            "peer 2 (higher id) should NOT be initiator"
        );

        // Sets should now be populated.
        assert!(sets["1"].contains("2"));
        assert!(sets["2"].contains("1"));
    }

    /// Same frame: no change expected — hysteresis holds.
    #[test]
    fn test_no_change_when_already_connected() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let positions = vec![peer(1, 0.0, 0.0), peer(2, near - 1.0, 0.0)];

        // First tick: connect.
        update_proximity(&positions, &mut sets, near, far, None);

        // Second tick with identical positions: no delta.
        let deltas = update_proximity(&positions, &mut sets, near, far, None);
        let d1 = &deltas["1"];
        assert!(d1.connect.is_empty(), "no new connect on second tick");
        assert!(d1.disconnect.is_empty(), "no disconnect on second tick");
    }

    /// Hysteresis: distance between nearRadius and farRadius → no disconnect.
    #[test]
    fn test_hysteresis_no_disconnect_in_gap() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        // Connect first.
        let positions_close = vec![peer(1, 0.0, 0.0), peer(2, near - 1.0, 0.0)];
        update_proximity(&positions_close, &mut sets, near, far, None);

        // Move peer 2 into the hysteresis gap (> nearRadius, < farRadius).
        let gap = (near + far) / 2.0; // 330.0
        let positions_gap = vec![peer(1, 0.0, 0.0), peer(2, gap, 0.0)];
        let deltas = update_proximity(&positions_gap, &mut sets, near, far, None);

        assert!(
            deltas["1"].disconnect.is_empty(),
            "should NOT disconnect in hysteresis gap"
        );
        assert!(sets["1"].contains("2"), "still connected in hysteresis gap");
    }

    /// Move beyond farRadius → disconnect.
    #[test]
    fn test_disconnect_beyond_far_radius() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        // Connect first.
        let positions_close = vec![peer(1, 0.0, 0.0), peer(2, near - 1.0, 0.0)];
        update_proximity(&positions_close, &mut sets, near, far, None);

        // Move peer 2 well beyond farRadius.
        let positions_far = vec![peer(1, 0.0, 0.0), peer(2, far + 1.0, 0.0)];
        let deltas = update_proximity(&positions_far, &mut sets, near, far, None);

        assert_eq!(
            deltas["1"].disconnect.len(),
            1,
            "peer 1 should get disconnect"
        );
        assert_eq!(deltas["1"].disconnect[0], "2");

        assert!(
            !sets["1"].contains("2"),
            "sets should be cleared after disconnect"
        );
    }

    /// Peers exactly at nearRadius: not near (boundary is strictly <).
    /// Peers exactly at nearRadius - epsilon: near.
    #[test]
    fn test_boundary_conditions() {
        let near = 300.0_f64;
        let far = 360.0_f64;

        // Exactly at nearRadius → distance == near → NOT connected (dist <= near IS included per protocol).
        // Protocol says "distance ≤ nearRadius ⇒ near", so exactly equal IS a connect.
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();
        let at_boundary = vec![peer(1, 0.0, 0.0), peer(2, near, 0.0)];
        let deltas = update_proximity(&at_boundary, &mut sets, near, far, None);
        assert_eq!(
            deltas["1"].connect.len(),
            1,
            "exactly at nearRadius should connect (dist <= nearRadius)"
        );
    }

    /// Three peers: A-B close, B-C far, A-C far.  Only A-B should connect.
    #[test]
    fn test_three_peers_selective_connect() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let positions = vec![
            peer(1, 0.0, 0.0),
            peer(2, 100.0, 0.0),  // close to 1
            peer(3, 1000.0, 0.0), // far from both
        ];
        let deltas = update_proximity(&positions, &mut sets, near, far, None);

        // Only 1↔2 should connect.
        assert_eq!(deltas["1"].connect.len(), 1);
        assert_eq!(deltas["2"].connect.len(), 1);
        assert!(deltas["3"].connect.is_empty());
        assert!(deltas["1"].connect[0].id == "2");
    }

    /// Team spaces set near/far ≥ the space diagonal, so every member is always
    /// "near" everyone else → the space behaves as a single group call
    /// (PROTOCOL.md §"Space configuration"). Verify a far-flung trio all
    /// connect when the radii are large.
    #[test]
    fn test_team_radius_connects_everyone() {
        // 800×600 space → diagonal = 1000; team radii are ≥ that.
        let near = 1100.0_f64;
        let far = 1100.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        // Three members in opposite corners/centre — far apart in lobby terms.
        let positions = vec![
            peer(1, 0.0, 0.0),
            peer(2, 800.0, 600.0),
            peer(3, 400.0, 300.0),
        ];
        let deltas = update_proximity(&positions, &mut sets, near, far, None);

        // Each member should connect to both of the others (group call).
        for id in ["1", "2", "3"] {
            assert_eq!(
                deltas[id].connect.len(),
                2,
                "member {id} should be near both others under team radii"
            );
        }
        assert!(sets["1"].contains("2") && sets["1"].contains("3"));
        assert!(sets["2"].contains("1") && sets["2"].contains("3"));
    }

    /// A DND peer never enters a new link, in either direction (FR-11 full
    /// isolation: walking up to a DND member must not open a mic link).
    #[test]
    fn test_dnd_blocks_new_connect() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let positions = vec![peer(1, 0.0, 0.0), dnd_peer(2, 10.0, 0.0)];
        let deltas = update_proximity(&positions, &mut sets, near, far, None);

        assert!(
            deltas["1"].connect.is_empty() && deltas["2"].connect.is_empty(),
            "no connect on either side when one peer is DND"
        );
        assert!(!sets["1"].contains("2") && !sets["2"].contains("1"));
    }

    /// Turning DND on while linked tears the link down even though the pair is
    /// still well inside farRadius; turning it off re-links on the next tick.
    #[test]
    fn test_dnd_tears_down_and_reconnects() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        // Connect while both available.
        let close = vec![peer(1, 0.0, 0.0), peer(2, 10.0, 0.0)];
        update_proximity(&close, &mut sets, near, far, None);
        assert!(sets["1"].contains("2"));

        // Peer 2 turns DND on without moving → both sides get a disconnect.
        let dnd_on = vec![peer(1, 0.0, 0.0), dnd_peer(2, 10.0, 0.0)];
        let deltas = update_proximity(&dnd_on, &mut sets, near, far, None);
        assert_eq!(deltas["1"].disconnect, vec!["2".to_string()]);
        assert_eq!(deltas["2"].disconnect, vec!["1".to_string()]);
        assert!(!sets["1"].contains("2") && !sets["2"].contains("1"));

        // Still DND: no reconnect flapping.
        let deltas = update_proximity(&dnd_on, &mut sets, near, far, None);
        assert!(deltas["1"].is_empty() && deltas["2"].is_empty());

        // DND off while still in range → normal connect resumes.
        let deltas = update_proximity(&close, &mut sets, near, far, None);
        assert_eq!(deltas["1"].connect.len(), 1);
        assert_eq!(deltas["2"].connect.len(), 1);
    }

    /// A `proximity` message that could not be queued must not leave the server
    /// believing the client acted on it: rolling the delta back makes the next
    /// tick emit the same disconnect again. Without this, a DND toggle whose
    /// disconnect was dropped would leave live P2P voice up forever.
    #[test]
    fn test_rollback_replays_a_dropped_disconnect() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let close = vec![peer(1, 0.0, 0.0), peer(2, 10.0, 0.0)];
        update_proximity(&close, &mut sets, near, far, None);

        // Peer 2 turns DND on → both sides get a disconnect…
        let dnd_on = vec![peer(1, 0.0, 0.0), dnd_peer(2, 10.0, 0.0)];
        let deltas = update_proximity(&dnd_on, &mut sets, near, far, None);
        assert_eq!(deltas["1"].disconnect, vec!["2".to_string()]);

        // …but peer 1's channel is full, so its message is dropped.
        rollback_delta("1", &deltas["1"], &mut sets);
        assert!(
            sets["1"].contains("2") && sets["2"].contains("1"),
            "the pair is restored so the next tick sees it as still linked"
        );

        // Next tick: the disconnect is regenerated for both sides. Peer 2 gets a
        // duplicate (it received the first one), which is idempotent client-side.
        let deltas = update_proximity(&dnd_on, &mut sets, near, far, None);
        assert_eq!(
            deltas["1"].disconnect,
            vec!["2".to_string()],
            "the dropped disconnect is resent"
        );
        assert_eq!(deltas["2"].disconnect, vec!["1".to_string()]);
    }

    /// The same guarantee in the other direction: a dropped `connect` must be
    /// re-emitted, or the peer stays silent next to someone standing beside them.
    #[test]
    fn test_rollback_replays_a_dropped_connect() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let close = vec![peer(1, 0.0, 0.0), peer(2, 10.0, 0.0)];
        let deltas = update_proximity(&close, &mut sets, near, far, None);
        assert_eq!(deltas["1"].connect.len(), 1);

        rollback_delta("1", &deltas["1"], &mut sets);
        assert!(!sets["1"].contains("2") && !sets["2"].contains("1"));

        let deltas = update_proximity(&close, &mut sets, near, far, None);
        assert_eq!(
            deltas["1"].connect.len(),
            1,
            "the dropped connect is retried on the next tick"
        );
    }

    /// Rolling back a disconnect for a peer that has since left the space must
    /// not resurrect it — `remove_peer` dropped its set on purpose.
    #[test]
    fn test_rollback_does_not_resurrect_a_departed_peer() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let close = vec![peer(1, 0.0, 0.0), peer(2, 10.0, 0.0)];
        update_proximity(&close, &mut sets, near, far, None);

        let apart = vec![peer(1, 0.0, 0.0), peer(2, far + 1.0, 0.0)];
        let deltas = update_proximity(&apart, &mut sets, near, far, None);
        remove_peer("2", &mut sets); // peer 2 leaves the space this tick

        rollback_delta("1", &deltas["1"], &mut sets);
        assert!(!sets.contains_key("2"), "the departed peer stays gone");
        assert!(!sets["1"].contains("2"), "and is not re-linked to peer 1");
    }

    /// remove_peer correctly cleans up connected sets.
    #[test]
    fn test_remove_peer() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let positions = vec![peer(1, 0.0, 0.0), peer(2, 100.0, 0.0)];
        update_proximity(&positions, &mut sets, near, far, None);

        // Peer 2 leaves.
        let affected = remove_peer("2", &mut sets);
        assert!(affected.contains(&"1".to_string()));
        assert!(!sets.contains_key("2"), "peer 2 set should be removed");
        assert!(
            !sets["1"].contains("2"),
            "peer 1 should no longer list peer 2"
        );
    }

    /// Walls beat distance: two peers at opposite ends of the meeting room are
    /// far apart in lobby terms yet connect, while the peer just outside the
    /// wall, within arm's reach of one of them, does not.
    #[test]
    fn test_meeting_room_connects_inside_and_walls_off_outside() {
        let near = 150.0_f64;
        let far = 180.0_f64;
        let room = Rect {
            x: 480.0,
            y: 36.0,
            w: 280.0,
            h: 228.0,
        };
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let positions = vec![
            peer(1, 490.0, 50.0),  // inside, top-left corner
            peer(2, 750.0, 250.0), // inside, bottom-right corner (~330 away)
            peer(3, 470.0, 50.0),  // outside, 20 from peer 1 through the wall
        ];
        let deltas = update_proximity(&positions, &mut sets, near, far, Some(&room));

        assert_eq!(deltas["1"].connect.len(), 1, "peer 1 links only to peer 2");
        assert_eq!(deltas["1"].connect[0].id, "2");
        assert_eq!(deltas["2"].connect.len(), 1);
        assert!(deltas["3"].connect.is_empty(), "the wall blocks peer 3");
    }

    /// Walking through the wall tears the link down on that tick, and walking
    /// back in restores it: the same positions without a room would have
    /// stayed linked throughout.
    #[test]
    fn test_crossing_the_wall_toggles_the_link() {
        let near = 150.0_f64;
        let far = 180.0_f64;
        let room = Rect {
            x: 480.0,
            y: 36.0,
            w: 280.0,
            h: 228.0,
        };
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let both_in = vec![peer(1, 500.0, 100.0), peer(2, 520.0, 100.0)];
        update_proximity(&both_in, &mut sets, near, far, Some(&room));
        assert!(sets["1"].contains("2"));

        let one_out = vec![peer(1, 500.0, 100.0), peer(2, 470.0, 100.0)];
        let deltas = update_proximity(&one_out, &mut sets, near, far, Some(&room));
        assert_eq!(deltas["1"].disconnect, vec!["2".to_string()]);
        assert_eq!(deltas["2"].disconnect, vec!["1".to_string()]);

        let deltas = update_proximity(&both_in, &mut sets, near, far, Some(&room));
        assert_eq!(deltas["1"].connect.len(), 1, "re-linked on re-entry");
    }

    /// Outside the room the distance rule is untouched by the room's presence.
    #[test]
    fn test_room_does_not_affect_pairs_outside_it() {
        let near = 150.0_f64;
        let far = 180.0_f64;
        let room = Rect {
            x: 480.0,
            y: 36.0,
            w: 280.0,
            h: 228.0,
        };
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let positions = vec![
            peer(1, 100.0, 400.0),
            peer(2, 200.0, 400.0),
            peer(3, 100.0, 100.0),
        ];
        let deltas = update_proximity(&positions, &mut sets, near, far, Some(&room));
        assert_eq!(deltas["1"].connect.len(), 1);
        assert_eq!(deltas["1"].connect[0].id, "2");
        assert!(deltas["3"].connect.is_empty());
    }
}
