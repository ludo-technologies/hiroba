/// Proximity / hysteresis logic — pure functions with no I/O.
///
/// The server tracks a "connected" set per peer and applies hysteresis so that
/// a pair which hovers right at the boundary does not flap:
///   - Connect:    distance drops BELOW nearRadius
///   - Disconnect: distance rises ABOVE farRadius
///
/// `update_proximity` returns, for each peer, the delta (new connections and
/// dropped connections) since the last call.  The caller applies the delta by
/// emitting `proximity` messages only when non-empty.
///
/// Initiator tie-break (PROTOCOL.md §proximity): the peer with the numerically
/// *smaller* id is always the WebRTC offerer for any pair.
use std::collections::{HashMap, HashSet};

use crate::protocol::ProximityConnect;

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
///
/// Returns a map from peer string_id → delta (may be empty).
pub fn update_proximity(
    positions: &[PeerPos],
    connected_sets: &mut HashMap<String, HashSet<String>>,
    near_radius: f64,
    far_radius: f64,
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

            let currently_connected = connected_sets[&a.string_id].contains(&b.string_id);

            if !currently_connected && dist <= near_radius {
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
            } else if currently_connected && dist > far_radius {
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
        let deltas = update_proximity(&positions, &mut sets, near, far);

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
        update_proximity(&positions, &mut sets, near, far);

        // Second tick with identical positions: no delta.
        let deltas = update_proximity(&positions, &mut sets, near, far);
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
        update_proximity(&positions_close, &mut sets, near, far);

        // Move peer 2 into the hysteresis gap (> nearRadius, < farRadius).
        let gap = (near + far) / 2.0; // 330.0
        let positions_gap = vec![peer(1, 0.0, 0.0), peer(2, gap, 0.0)];
        let deltas = update_proximity(&positions_gap, &mut sets, near, far);

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
        update_proximity(&positions_close, &mut sets, near, far);

        // Move peer 2 well beyond farRadius.
        let positions_far = vec![peer(1, 0.0, 0.0), peer(2, far + 1.0, 0.0)];
        let deltas = update_proximity(&positions_far, &mut sets, near, far);

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
        let deltas = update_proximity(&at_boundary, &mut sets, near, far);
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
        let deltas = update_proximity(&positions, &mut sets, near, far);

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
        let deltas = update_proximity(&positions, &mut sets, near, far);

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

    /// remove_peer correctly cleans up connected sets.
    #[test]
    fn test_remove_peer() {
        let near = 300.0_f64;
        let far = 360.0_f64;
        let mut sets: HashMap<String, HashSet<String>> = HashMap::new();

        let positions = vec![peer(1, 0.0, 0.0), peer(2, 100.0, 0.0)];
        update_proximity(&positions, &mut sets, near, far);

        // Peer 2 leaves.
        let affected = remove_peer("2", &mut sets);
        assert!(affected.contains(&"1".to_string()));
        assert!(!sets.contains_key("2"), "peer 2 set should be removed");
        assert!(
            !sets["1"].contains("2"),
            "peer 1 should no longer list peer 2"
        );
    }
}
