//! Multi-tenant org registry (§7.6, NFR-12).
//!
//! v1/early-v2 ran a single shared [`Org`]. The hosted profile needs many: a
//! connection's resolved [`crate::auth::Identity::org_id`] selects (or lazily
//! creates) the tenant it joins, and tenants are **fully independent** `Org`
//! instances — separate member maps, space catalogs, rosters, id counters, and
//! broadcast scopes. Because no code path ever reaches across two `Org`s, there
//! is no shared mutable surface through which one tenant's roster, positions,
//! or signaling could leak into another (NFR-12: zero cross-tenant visibility).
//!
//! Tenants **persist** for the server's lifetime once created. A tenant is a
//! durable business entity (a paying org), not a room that disappears when the
//! last person logs off; an empty `Org` is a few empty maps plus two seeded
//! space descriptors, so idle tenants are nearly free and we never risk the
//! reap-vs-join race that auto-eviction would introduce.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::state::Org;
use crate::store::{OrgCatalog, Store};

/// Thread-safe map of org id → [`Org`]. Clone cheaply (shared `Arc`).
#[derive(Clone)]
pub struct OrgRegistry {
    inner: Arc<Mutex<HashMap<String, Org>>>,
    /// Handed to every `Org` so org creation and `create_space` write through.
    /// `None` is the DB-less profile (§7.5) — identical to pre-store behaviour.
    store: Option<Arc<Store>>,
}

impl OrgRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            store: None,
        }
    }

    /// Build a registry whose tenants were loaded from the store. Loaded orgs
    /// keep their persisted name and space catalog; `seed`/`get_or_create`
    /// leave them untouched (their `or_insert_with` closures never fire).
    pub fn with_store(store: Arc<Store>, catalogs: Vec<OrgCatalog>) -> Self {
        let mut map = HashMap::new();
        for catalog in catalogs {
            let org = Org::from_catalog(catalog, Some(store.clone()));
            map.insert(org.id().to_string(), org);
        }
        Self {
            inner: Arc::new(Mutex::new(map)),
            store: Some(store),
        }
    }

    /// Pre-create a known tenant (the self-host single-org path). Idempotent.
    pub async fn seed(&self, id: impl Into<String>, name: impl Into<String>) -> Org {
        let id = id.into();
        let mut guard = self.inner.lock().await;
        guard
            .entry(id.clone())
            .or_insert_with(|| Org::new(id, name, self.store.clone()))
            .clone()
    }

    /// Resolve a tenant by id, creating it on first use. `name` is only applied
    /// when the org is newly created (an existing tenant keeps its name).
    pub async fn get_or_create(&self, id: &str, name: &str) -> Org {
        let mut guard = self.inner.lock().await;
        guard
            .entry(id.to_string())
            .or_insert_with(|| Org::new(id.to_string(), name.to_string(), self.store.clone()))
            .clone()
    }

    /// Snapshot of all live tenant handles — used by the tick loop to broadcast
    /// positions/proximity across every org. Cheap: clones `Arc` handles only.
    pub async fn all(&self) -> Vec<Org> {
        self.inner.lock().await.values().cloned().collect()
    }
}

impl Default for OrgRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ServerMsg;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn get_or_create_is_stable_per_id() {
        let reg = OrgRegistry::new();
        let a1 = reg.get_or_create("acme", "Acme").await;
        let a2 = reg.get_or_create("acme", "Ignored").await;
        // Same underlying org: a member joined via one handle is visible via the
        // other (they share state).
        let (tx, _rx) = mpsc::channel::<ServerMsg>(8);
        a1.join("Aoi".into(), "#fff".into(), None, tx).await;
        // The second handle sees the member in its tick snapshot.
        let ticks = a2.tick_snapshot().await;
        let total: usize = ticks.iter().map(|t| t.members.len()).sum();
        assert_eq!(total, 1, "both handles point at the same org");
    }

    #[tokio::test]
    async fn distinct_orgs_are_isolated() {
        let reg = OrgRegistry::new();
        let acme = reg.get_or_create("acme", "Acme").await;
        let globex = reg.get_or_create("globex", "Globex").await;

        let (tx, _rx) = mpsc::channel::<ServerMsg>(8);
        acme.join("Aoi".into(), "#fff".into(), None, tx).await;

        // Globex must not observe Acme's member anywhere (NFR-12).
        let ticks = globex.tick_snapshot().await;
        let total: usize = ticks.iter().map(|t| t.members.len()).sum();
        assert_eq!(total, 0, "tenants share no state");

        assert_eq!(reg.all().await.len(), 2);
    }

    #[tokio::test]
    async fn new_orgs_write_through_to_store() {
        let store = Arc::new(Store::open_in_memory());
        let reg = OrgRegistry::with_store(store.clone(), store.load_all());
        reg.seed("ludo", "Ludo").await;
        reg.get_or_create("acme", "Acme").await;

        let catalogs = store.load_all();
        assert_eq!(catalogs.len(), 2);
        for cat in &catalogs {
            let ids: Vec<&str> = cat.spaces.iter().map(|s| s.id.as_str()).collect();
            assert_eq!(ids, ["lobby", "dev"], "default catalog persisted");
        }
    }

    #[tokio::test]
    async fn created_spaces_survive_a_reload() {
        let store = Arc::new(Store::open_in_memory());

        // "First boot": seed the org, create a space.
        let reg = OrgRegistry::with_store(store.clone(), store.load_all());
        let org = reg.seed("ludo", "Ludo").await;
        org.create_space("Design".into()).await;

        // "Restart": a fresh registry built from the same store.
        let reg2 = OrgRegistry::with_store(store.clone(), store.load_all());
        let org2 = reg2.get_or_create("ludo", "IgnoredName").await;
        let (tx, _rx) = mpsc::channel::<ServerMsg>(8);
        let welcome = org2.join("Aoi".into(), "#ffffff".into(), None, tx).await;
        match welcome {
            ServerMsg::Welcome { org, spaces, .. } => {
                assert_eq!(org.name, "Ludo", "persisted name wins over env/claim");
                let ids: Vec<&str> = spaces.iter().map(|s| s.id.as_str()).collect();
                assert_eq!(ids, ["lobby", "dev", "team1"], "catalog restored in order");
            }
            other => panic!("expected welcome, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn space_ids_are_not_reissued_after_reload() {
        let store = Arc::new(Store::open_in_memory());
        let reg = OrgRegistry::with_store(store.clone(), store.load_all());
        let org = reg.seed("ludo", "Ludo").await;
        org.create_space("A".into()).await; // team1

        let reg2 = OrgRegistry::with_store(store.clone(), store.load_all());
        let org2 = reg2.get_or_create("ludo", "Ludo").await;
        org2.create_space("B".into()).await; // must be team2, not a clash

        let cat = &store.load_all()[0];
        let ids: Vec<&str> = cat.spaces.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["lobby", "dev", "team1", "team2"]);
    }
}
