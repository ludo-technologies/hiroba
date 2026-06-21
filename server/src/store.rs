//! Optional persistence for the org registry + space catalogs (§7.5).
//!
//! Without `HIROBA_DB` the server is exactly as before: a single static binary
//! holding everything in memory (the DB-less self-host profile). With it, the
//! two durable things the signaling server owns survive a restart:
//!
//!   - which orgs exist (id + display name), and
//!   - each org's space catalog (`create_space` results would otherwise vanish).
//!
//! Members, positions, presence, and proximity are connection-lifetime state by
//! design and are never written here.
//!
//! Bundled SQLite behind a mutex, same as `hiroba-auth`'s store and for the
//! same reason: writes happen only on org creation and `create_space` — rare,
//! single-row, sub-millisecond — so a pool or async wrapper would be overkill.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::protocol::{SpaceDescriptor, SpaceKind};

/// Everything needed to rebuild one org's in-memory state at startup.
pub struct OrgCatalog {
    pub org_id: String,
    pub org_name: String,
    /// In `space_order` (insertion) order.
    pub spaces: Vec<SpaceDescriptor>,
    pub next_space_seq: u64,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Open (creating if needed) the SQLite file and ensure the schema.
    /// Panics on failure — a misconfigured `HIROBA_DB` should abort startup,
    /// not silently fall back to amnesia.
    pub fn open(path: &Path) -> Self {
        let conn = Connection::open(path)
            .unwrap_or_else(|e| panic!("cannot open db {}: {e}", path.display()));
        Self::init(conn)
    }

    /// In-memory store for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Self {
        Self::init(Connection::open_in_memory().expect("in-memory sqlite"))
    }

    fn init(conn: Connection) -> Self {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS orgs (
               id             TEXT PRIMARY KEY,
               name           TEXT NOT NULL,
               -- team{seq} allocation counter, NOT the space count: restored
               -- verbatim so ids are never reissued after a restart.
               next_space_seq INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE IF NOT EXISTS spaces (
               org_id      TEXT NOT NULL REFERENCES orgs(id),
               space_id    TEXT NOT NULL,
               name        TEXT NOT NULL,
               kind        TEXT NOT NULL CHECK (kind IN ('lobby', 'team')),
               width       REAL NOT NULL,
               height      REAL NOT NULL,
               near_radius REAL NOT NULL,
               far_radius  REAL NOT NULL,
               tick_hz     INTEGER NOT NULL,
               capacity    INTEGER NOT NULL,
               ord         INTEGER NOT NULL,
               PRIMARY KEY (org_id, space_id)
             );",
        )
        .expect("apply schema");
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// Load every persisted org with its space catalog. Called once at startup.
    pub fn load_all(&self) -> Vec<OrgCatalog> {
        let conn = self.conn.lock().expect("db lock");
        let mut orgs_stmt = conn
            .prepare("SELECT id, name, next_space_seq FROM orgs ORDER BY id")
            .expect("prepare orgs");
        let mut spaces_stmt = conn
            .prepare(
                "SELECT space_id, name, kind, width, height, near_radius, far_radius,
                        tick_hz, capacity
                 FROM spaces WHERE org_id = ?1 ORDER BY ord",
            )
            .expect("prepare spaces");

        let orgs: Vec<(String, String, u64)> = orgs_stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? as u64))
            })
            .expect("query orgs")
            .collect::<Result<_, _>>()
            .expect("read org row");

        orgs.into_iter()
            .map(|(org_id, org_name, next_space_seq)| {
                let spaces = spaces_stmt
                    .query_map([&org_id], |row| {
                        let kind: String = row.get(2)?;
                        Ok(SpaceDescriptor {
                            id: row.get(0)?,
                            name: row.get(1)?,
                            kind: if kind == "lobby" {
                                SpaceKind::Lobby
                            } else {
                                SpaceKind::Team
                            },
                            width: row.get(3)?,
                            height: row.get(4)?,
                            near_radius: row.get(5)?,
                            far_radius: row.get(6)?,
                            tick_hz: row.get::<_, i64>(7)? as u32,
                            capacity: row.get::<_, i64>(8)? as u32,
                        })
                    })
                    .expect("query spaces")
                    .collect::<Result<_, _>>()
                    .expect("read space row");
                OrgCatalog {
                    org_id,
                    org_name,
                    spaces,
                    next_space_seq,
                }
            })
            .collect()
    }

    /// Record a newly created org. `INSERT OR IGNORE`: an existing row keeps
    /// its persisted name (matching `get_or_create`'s "an existing tenant
    /// keeps its name" contract).
    pub fn upsert_org(&self, id: &str, name: &str) {
        self.conn
            .lock()
            .expect("db lock")
            .execute(
                "INSERT OR IGNORE INTO orgs (id, name) VALUES (?1, ?2)",
                params![id, name],
            )
            .expect("upsert org");
    }

    /// Record a space added to `org_id`'s catalog at position `ord`, and
    /// persist the org's `team{seq}` counter in the same statement batch so a
    /// restart never reissues an id.
    pub fn insert_space(
        &self,
        org_id: &str,
        desc: &SpaceDescriptor,
        ord: u64,
        next_space_seq: u64,
    ) {
        let kind = match desc.kind {
            SpaceKind::Lobby => "lobby",
            SpaceKind::Team => "team",
        };
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT OR IGNORE INTO spaces
               (org_id, space_id, name, kind, width, height, near_radius,
                far_radius, tick_hz, capacity, ord)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                org_id,
                desc.id,
                desc.name,
                kind,
                desc.width,
                desc.height,
                desc.near_radius,
                desc.far_radius,
                desc.tick_hz as i64,
                desc.capacity as i64,
                ord as i64,
            ],
        )
        .expect("insert space");
        conn.execute(
            "UPDATE orgs SET next_space_seq = ?2 WHERE id = ?1",
            params![org_id, next_space_seq as i64],
        )
        .expect("update next_space_seq");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_all_on_empty_db_is_empty() {
        let store = Store::open_in_memory();
        assert!(store.load_all().is_empty());
    }

    #[test]
    fn org_and_spaces_round_trip() {
        let store = Store::open_in_memory();
        store.upsert_org("acme", "Acme");
        store.insert_space("acme", &SpaceDescriptor::lobby(), 0, 1);
        store.insert_space("acme", &SpaceDescriptor::team("dev", "開発"), 1, 1);
        store.insert_space("acme", &SpaceDescriptor::team("team1", "Design"), 2, 2);

        let catalogs = store.load_all();
        assert_eq!(catalogs.len(), 1);
        let cat = &catalogs[0];
        assert_eq!(cat.org_id, "acme");
        assert_eq!(cat.org_name, "Acme");
        assert_eq!(cat.next_space_seq, 2);

        let ids: Vec<&str> = cat.spaces.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["lobby", "dev", "team1"]);

        let lobby = &cat.spaces[0];
        let reference = SpaceDescriptor::lobby();
        assert_eq!(lobby.kind, SpaceKind::Lobby);
        assert_eq!(lobby.name, reference.name);
        assert_eq!(lobby.width, reference.width);
        assert_eq!(lobby.near_radius, reference.near_radius);
        assert_eq!(lobby.far_radius, reference.far_radius);
        assert_eq!(lobby.tick_hz, reference.tick_hz);
        assert_eq!(lobby.capacity, reference.capacity);
        assert_eq!(cat.spaces[2].kind, SpaceKind::Team);
        assert_eq!(cat.spaces[2].name, "Design");
    }

    #[test]
    fn upsert_org_keeps_first_name() {
        let store = Store::open_in_memory();
        store.upsert_org("acme", "Acme");
        store.upsert_org("acme", "Renamed");
        let catalogs = store.load_all();
        assert_eq!(catalogs[0].org_name, "Acme");
    }

    #[test]
    fn space_order_is_ord_not_insert_sequence() {
        let store = Store::open_in_memory();
        store.upsert_org("acme", "Acme");
        // Insert out of ord order; load must come back sorted by ord.
        store.insert_space("acme", &SpaceDescriptor::team("team2", "B"), 2, 3);
        store.insert_space("acme", &SpaceDescriptor::lobby(), 0, 3);
        store.insert_space("acme", &SpaceDescriptor::team("team1", "A"), 1, 3);

        let cat = &store.load_all()[0];
        let ids: Vec<&str> = cat.spaces.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["lobby", "team1", "team2"]);
        assert_eq!(cat.next_space_seq, 3);
    }

    #[test]
    fn orgs_are_isolated() {
        let store = Store::open_in_memory();
        store.upsert_org("acme", "Acme");
        store.upsert_org("globex", "Globex");
        store.insert_space("acme", &SpaceDescriptor::lobby(), 0, 1);

        let catalogs = store.load_all();
        let acme = catalogs.iter().find(|c| c.org_id == "acme").unwrap();
        let globex = catalogs.iter().find(|c| c.org_id == "globex").unwrap();
        assert_eq!(acme.spaces.len(), 1);
        assert!(globex.spaces.is_empty());
    }
}
