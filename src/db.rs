use std::path::Path;

use rusqlite::{Connection, functions::FunctionFlags};

/// Applied in order; `PRAGMA user_version` records how many have run.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_tab_kinds.sql"),
    include_str!("../migrations/0003_tag_aliases.sql"),
    include_str!("../migrations/0004_tab_names.sql"),
    include_str!("../migrations/0005_gallery_tabs.sql"),
    include_str!("../migrations/0006_collection_tabs.sql"),
    include_str!("../migrations/0007_trash.sql"),
];

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // shuffle(id, seed): a well-mixed number per ID, for `sort=random`.
    conn.create_scalar_function(
        "shuffle",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let (id, seed): (i64, i64) = (ctx.get(0)?, ctx.get(1)?);
            let mut x = (id as u64) ^ (seed as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
            x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            Ok((x ^ (x >> 31)) as i64)
        },
    )?;
    migrate(&mut conn)?;
    Ok(conn)
}

pub fn schema_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let applied = schema_version(conn)? as usize;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(applied) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}
