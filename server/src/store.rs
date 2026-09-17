//! Optional persistence for the org registry + space catalogs (§7.5).
//!
//! Without `HIROBA_DB` the server is exactly as before: a single static binary
//! holding everything in memory (the DB-less self-host profile). With it, the
//! three durable things the signaling server owns survive a restart:
//!
//!   - which orgs exist (id + display name),
//!   - each org's space catalog (`create_space` results would otherwise vanish),
//!   - each space's bulletin-board notes — the only user-authored content the
//!     server stores.
//!
//! Members, positions, presence, and proximity are connection-lifetime state by
//! design and are never written here.
//!
//! Bundled SQLite behind a mutex, same as `hiroba-auth`'s store and for the
//! same reason: writes happen only on org creation, `create_space` and note
//! changes — rare (notes are rate-limited per member), a row or two,
//! sub-millisecond — so a pool or async wrapper would be overkill.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::protocol::{SpaceDescriptor, SpaceKind};

/// A note pinned to a space's bulletin board.
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    /// Unique within the org, monotonic: id order is posting order.
    pub id: u64,
    /// The author's token `sub`; None when the server runs without accounts.
    pub author_sub: Option<String>,
    pub author_name: String,
    pub text: String,
    /// Unix seconds.
    pub ts: u64,
}

/// Everything needed to rebuild one org's in-memory state at startup.
pub struct OrgCatalog {
    pub org_id: String,
    pub org_name: String,
    /// In `space_order` (insertion) order.
    pub spaces: Vec<SpaceDescriptor>,
    pub next_space_seq: u64,
    /// `(space_id, note)`, oldest first.
    pub notes: Vec<(String, Note)>,
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
             );
             CREATE TABLE IF NOT EXISTS notes (
               org_id      TEXT NOT NULL,
               space_id    TEXT NOT NULL,
               id          INTEGER NOT NULL,
               author_sub  TEXT,
               author_name TEXT NOT NULL,
               text        TEXT NOT NULL,
               ts          INTEGER NOT NULL,
               PRIMARY KEY (org_id, id),
               FOREIGN KEY (org_id, space_id) REFERENCES spaces(org_id, space_id)
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
        let mut notes_stmt = conn
            .prepare(
                "SELECT space_id, id, author_sub, author_name, text, ts
                 FROM notes WHERE org_id = ?1 ORDER BY id",
            )
            .expect("prepare notes");

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
                let notes = notes_stmt
                    .query_map([&org_id], |row| {
                        Ok((
                            row.get(0)?,
                            Note {
                                id: row.get::<_, i64>(1)? as u64,
                                author_sub: row.get(2)?,
                                author_name: row.get(3)?,
                                text: row.get(4)?,
                                ts: row.get::<_, i64>(5)? as u64,
                            },
                        ))
                    })
                    .expect("query notes")
                    .collect::<Result<_, _>>()
                    .expect("read note row");
                OrgCatalog {
                    org_id,
                    org_name,
                    spaces,
                    next_space_seq,
                    notes,
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

    /// Apply one board change atomically: the notes that came down (`removed`)
    /// and the one that went up (`added`, with its space), if any.
    pub fn apply_note_change(&self, org_id: &str, removed: &[u64], added: Option<(&str, &Note)>) {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction().expect("begin note change");
        for id in removed {
            tx.execute(
                "DELETE FROM notes WHERE org_id = ?1 AND id = ?2",
                params![org_id, *id as i64],
            )
            .expect("delete note");
        }
        if let Some((space_id, note)) = added {
            tx.execute(
                "INSERT INTO notes (org_id, space_id, id, author_sub, author_name, text, ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    org_id,
                    space_id,
                    note.id as i64,
                    note.author_sub,
                    note.author_name,
                    note.text,
                    note.ts as i64,
                ],
            )
            .expect("insert note");
        }
        tx.commit().expect("commit note change");
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
        store.insert_space("acme", &SpaceDescriptor::team("dev", "Dev"), 1, 1);
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

    fn note(id: u64, text: &str) -> Note {
        Note {
            id,
            author_sub: Some("u1".to_string()),
            author_name: "Aoi".to_string(),
            text: text.to_string(),
            ts: 1_700_000_000,
        }
    }

    #[test]
    fn notes_round_trip_in_id_order_and_delete() {
        let store = Store::open_in_memory();
        store.upsert_org("acme", "Acme");
        store.insert_space("acme", &SpaceDescriptor::lobby(), 0, 1);
        store.apply_note_change("acme", &[], Some(("lobby", &note(2, "second"))));
        store.apply_note_change("acme", &[], Some(("lobby", &note(1, "first"))));

        let loaded = store.load_all().remove(0).notes;
        assert_eq!(
            loaded,
            [
                ("lobby".to_string(), note(1, "first")),
                ("lobby".to_string(), note(2, "second")),
            ]
        );

        // One change both takes a note down and puts one up.
        store.apply_note_change("acme", &[1], Some(("lobby", &note(3, "third"))));
        let ids: Vec<u64> = store.load_all()[0]
            .notes
            .iter()
            .map(|(_, n)| n.id)
            .collect();
        assert_eq!(ids, [2, 3]);
    }

    #[test]
    #[should_panic(expected = "insert note")]
    fn note_for_unknown_space_is_refused() {
        let store = Store::open_in_memory();
        store.upsert_org("acme", "Acme");
        store.apply_note_change("acme", &[], Some(("nowhere", &note(1, "x"))));
    }
}
