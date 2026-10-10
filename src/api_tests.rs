//! Tests of the API as a client sees it: requests through the router,
//! against an empty library in memory.

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header::CONTENT_TYPE},
};
use rusqlite::params;
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::{AppState, api, db, files::stored_name};

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

/// A server with nothing in it, and a directory of its own for files.
struct Api {
    app: Router,
    state: AppState,
    dir: PathBuf,
}

impl Drop for Api {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Api {
    fn new() -> Self {
        Self::with(false)
    }

    /// A server that is, or is not, where there is no browser.
    fn with(headless: bool) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "opalarchive-test-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        let state = AppState {
            db: Arc::new(Mutex::new(db::open(":memory:".as_ref()).unwrap())),
            storage: dir.join("storage"),
            thumbnails: dir.join("thumbnails"),
            tmp: dir.join("tmp"),
            downloaders: dir.join("downloaders"),
            cookies: dir.join("cookies"),
            downloads: Default::default(),
            inbox_busy: Default::default(),
            headless,
        };
        for path in [&state.storage, &state.thumbnails, &state.tmp] {
            std::fs::create_dir_all(path).unwrap();
        }
        Api {
            app: api().with_state(state.clone()),
            state,
            dir,
        }
    }

    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let request = Request::builder().method(method).uri(path);
        let request = match body {
            Some(body) => request
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        };
        let response = self.app.clone().oneshot(request.unwrap()).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// The answer to a request that has to succeed.
    async fn ok(&self, method: &str, path: &str, body: Option<Value>) -> Value {
        let (status, answer) = self.call(method, path, body).await;
        assert!(status.is_success(), "{method} {path}: {status} {answer}");
        answer
    }

    async fn get(&self, path: &str) -> Value {
        self.ok("GET", path, None).await
    }

    async fn post(&self, path: &str, body: Value) -> Value {
        self.ok("POST", path, Some(body)).await
    }

    /// The status of a request, by any method, that has to be refused.
    async fn refused_with(&self, method: &str, path: &str, body: Value) -> StatusCode {
        let (status, _) = self.call(method, path, Some(body)).await;
        assert!(!status.is_success(), "{method} {path} was not refused");
        status
    }

    /// The status of a request that has to be refused.
    async fn refused(&self, path: &str, body: Value) -> StatusCode {
        let (status, _) = self.call("POST", path, Some(body)).await;
        assert!(status.is_client_error(), "POST {path}: {status}");
        status
    }

    /// Puts a file in the library as an upload would, and returns its ID.
    fn file(&self, name: &str) -> i64 {
        let conn = self.state.db.lock().unwrap();
        conn.execute("INSERT INTO entity (kind) VALUES ('file')", [])
            .unwrap();
        let id = conn.last_insert_rowid();
        let hash = format!("{id:064x}");
        conn.execute(
            "INSERT INTO file (entity_id, hash, extension, media_type, size, original_name)
             VALUES (?1, ?2, 'png', 'image', 4, ?3)",
            params![id, hash, name],
        )
        .unwrap();
        std::fs::write(self.stored(id), b"data").unwrap();
        id
    }

    /// Where the file made by `file` is kept.
    fn stored(&self, id: i64) -> PathBuf {
        self.state
            .storage
            .join(stored_name(&format!("{id:064x}"), "png"))
    }

    async fn edit(&self, ids: &[i64], changes: Value) -> Value {
        let mut body = changes;
        body["ids"] = json!(ids);
        self.post("/entities/edit", body).await
    }

    async fn metadata(&self, ids: &[i64]) -> Value {
        self.post("/entities/metadata", json!({ "ids": ids })).await
    }

    /// IDs found by a query, lowest first.
    async fn found(&self, query: &str) -> Vec<i64> {
        let q: String = query.bytes().map(|b| format!("%{b:02X}")).collect();
        let answer = self.get(&format!("/search/ids?q={q}")).await;
        let mut ids: Vec<i64> = serde_json::from_value(answer["ids"].clone()).unwrap();
        ids.sort();
        ids
    }

    /// The tags of a field as the tag editor lists them: value and count.
    async fn tags(&self, field: &str) -> Vec<(String, i64)> {
        let answer = self.get(&format!("/tags/all?field={field}")).await;
        answer["tags"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tag| {
                (
                    tag["value"].as_str().unwrap().to_string(),
                    tag["count"].as_i64().unwrap(),
                )
            })
            .collect()
    }

    /// Member IDs of a collection by position.
    fn members(&self, collection: i64) -> Vec<(i64, Option<i64>)> {
        let conn = self.state.db.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT member_id, position FROM membership WHERE collection_id = ?1
                 ORDER BY position IS NULL, position, member_id",
            )
            .unwrap();
        stmt.query_map([collection], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
}

fn tag(value: &str, count: i64) -> (String, i64) {
    (value.to_string(), count)
}

/// The values of one field in a metadata answer, with their counts.
fn carried(metadata: &Value, field: &str) -> Vec<(String, i64)> {
    let list = match field {
        "source_url" | "identifier" | "reference" => &metadata[field],
        _ => &metadata["tags"][field],
    };
    list.as_array()
        .map(|values| {
            values
                .iter()
                .map(|v| tag(v["value"].as_str().unwrap(), v["count"].as_i64().unwrap()))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn scalars_are_set_checked_and_cleared() {
    let api = Api::new();
    let (a, b) = (api.file("a.png"), api.file("b.png"));

    let answer = api
        .edit(
            &[a, b],
            json!({ "set": { "title": "Both", "score": 5, "date": "2020-05" } }),
        )
        .await;
    assert_eq!(answer["updated"], 2);
    api.edit(
        &[a],
        json!({ "set": { "title": "Only a", "original_name": "renamed.png" } }),
    )
    .await;

    let both = api.metadata(&[a, b]).await;
    assert_eq!(both["count"], 2);
    assert_eq!(both["files"], 2);
    assert_eq!(
        both["scalars"]["score"],
        json!({ "value": 5, "mixed": false })
    );
    assert_eq!(
        both["scalars"]["title"],
        json!({ "value": null, "mixed": true })
    );
    assert_eq!(both["scalars"]["original_name"]["mixed"], true);
    let one = api.get(&format!("/entities/{a}")).await;
    assert_eq!(one["title"], "Only a");
    assert_eq!(one["date"], "2020-05");
    assert_eq!(one["file"]["original_name"], "renamed.png");

    // Set on one and empty on the other is mixed too.
    api.edit(&[b], json!({ "set": { "score": null, "title": "" } }))
        .await;
    let both = api.metadata(&[a, b]).await;
    assert_eq!(both["scalars"]["score"]["mixed"], true);
    assert_eq!(
        api.get(&format!("/entities/{b}")).await["title"],
        Value::Null
    );

    for bad in [
        json!({ "score": 9 }),
        json!({ "score": "high" }),
        json!({ "date": "May 2020" }),
        json!({ "content_rating": "spicy" }),
        json!({ "kind": "collection" }),
        json!({ "collection_type": null }),
    ] {
        api.refused("/entities/edit", json!({ "ids": [a], "set": bad }))
            .await;
    }
    assert_eq!(
        api.call("GET", "/entities/999", None).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn an_edit_is_all_or_nothing() {
    let api = Api::new();
    let a = api.file("a.png");
    api.refused(
        "/entities/edit",
        json!({ "ids": [a], "set": { "title": "Kept out" }, "add": { "tags": ["fine", "@bad"] } }),
    )
    .await;
    api.refused(
        "/entities/edit",
        json!({ "ids": [a], "add": { "tags": ["fine"] }, "add_source_url": ["javascript:alert(1)"] }),
    )
    .await;
    api.refused(
        "/entities/edit",
        json!({ "ids": [a], "add": { "nonsense": ["x"] } }),
    )
    .await;
    let after = api.metadata(&[a]).await;
    assert_eq!(after["scalars"]["title"]["value"], Value::Null);
    assert_eq!(after["tags"], json!({}));
}

#[tokio::test]
async fn tags_are_added_counted_and_removed() {
    let api = Api::new();
    let (a, b) = (api.file("a.png"), api.file("b.png"));
    api.edit(
        &[a, b],
        json!({ "add": { "tags": ["cat", " art : line art "], "creator": ["Abba"] } }),
    )
    .await;
    api.edit(&[a], json!({ "add": { "tags": ["CAT", "solo"] } }))
        .await;

    let both = api.metadata(&[a, b]).await;
    assert_eq!(
        carried(&both, "tags"),
        [tag("art:line art", 2), tag("cat", 2), tag("solo", 1)]
    );
    assert_eq!(carried(&both, "creator"), [tag("Abba", 2)]);
    assert_eq!(api.found("cat").await, [a, b]);
    assert_eq!(api.found("art:*").await, [a, b]);
    assert_eq!(api.found("@cr:abba solo").await, [a]);

    // A tag nothing carries any more is gone.
    api.edit(&[a, b], json!({ "remove": { "tags": ["solo", "cat"] } }))
        .await;
    assert_eq!(api.tags("tags").await, [tag("art:line art", 2)]);
    assert_eq!(
        carried(&api.metadata(&[a]).await, "tags"),
        [tag("art:line art", 1)]
    );
}

#[tokio::test]
async fn links_identifiers_and_references_are_plain_lists() {
    let api = Api::new();
    let (a, b) = (api.file("a.png"), api.file("b.png"));
    api.edit(
        &[a, b],
        json!({
            "add_source_url": ["example.com/a"],
            "add_identifier": [" isbn-1 "],
            "add_reference": [" ref-1 "],
        }),
    )
    .await;
    api.edit(&[a], json!({ "add_source_url": ["http://other.example/"] }))
        .await;

    let both = api.metadata(&[a, b]).await;
    assert_eq!(
        carried(&both, "source_url"),
        [
            tag("http://other.example/", 1),
            tag("https://example.com/a", 2)
        ]
    );
    assert_eq!(carried(&both, "identifier"), [tag("isbn-1", 2)]);
    assert_eq!(carried(&both, "reference"), [tag("ref-1", 2)]);
    // Neither is a tag.
    assert_eq!(both["tags"], json!({}));
    assert_eq!(api.found("identifier=isbn-1").await, [a, b]);
    assert_eq!(api.found("reference=ref-1").await, [a, b]);

    api.edit(
        &[a, b],
        json!({
            "remove_source_url": ["https://example.com/a"],
            "remove_identifier": ["isbn-1"],
            "remove_reference": ["ref-1"],
        }),
    )
    .await;
    let both = api.metadata(&[a, b]).await;
    assert_eq!(
        carried(&both, "source_url"),
        [tag("http://other.example/", 1)]
    );
    assert_eq!(carried(&both, "identifier"), []);
    assert_eq!(carried(&both, "reference"), []);
    api.refused(
        "/entities/edit",
        json!({ "ids": [a], "add_identifier": ["  "] }),
    )
    .await;
    api.refused(
        "/entities/edit",
        json!({ "ids": [a], "add_reference": ["  "] }),
    )
    .await;
}

#[tokio::test]
async fn deleting_takes_two_steps() {
    let api = Api::new();
    let (a, b) = (api.file("a.png"), api.file("b.png"));
    api.edit(&[a], json!({ "add": { "tags": ["doomed"] } }))
        .await;
    api.edit(&[a, b], json!({ "add": { "tags": ["shared"] } }))
        .await;

    // Nothing is deleted that is not in the trash.
    assert_eq!(
        api.post("/entities/delete", json!({ "ids": [a, b] })).await["deleted"],
        0
    );
    assert!(api.stored(a).exists());

    assert_eq!(
        api.post("/entities/trash", json!({ "ids": [a] })).await["changed"],
        1
    );
    assert_eq!(
        api.post("/entities/trash", json!({ "ids": [a] })).await["changed"],
        0
    );
    assert_eq!(api.found("").await, [b]);
    assert_eq!(api.found("@trashed").await, [a]);
    assert_eq!(api.found("-@trashed").await, [b]);
    assert_eq!(api.metadata(&[a, b]).await["trashed"], 1);
    assert_eq!(
        api.get("/stats").await,
        json!({ "files": 1, "collections": 0, "trashed": 1 })
    );
    // Trashed, it keeps its file and tags.
    assert!(api.stored(a).exists());
    assert_eq!(api.tags("tags").await, [tag("doomed", 1), tag("shared", 2)]);

    assert_eq!(
        api.post("/entities/restore", json!({ "ids": [a] })).await["changed"],
        1
    );
    assert_eq!(api.found("").await, [a, b]);

    api.post("/entities/trash", json!({ "ids": [a] })).await;
    assert_eq!(
        api.post("/entities/delete", json!({ "ids": [a, b] })).await["deleted"],
        1
    );
    assert!(!api.stored(a).exists());
    assert!(api.stored(b).exists());
    assert_eq!(api.found("@trashed").await, [] as [i64; 0]);
    assert_eq!(api.tags("tags").await, [tag("shared", 1)]);
}

#[tokio::test]
async fn collections_hold_members() {
    let api = Api::new();
    let (a, b, c) = (api.file("a.png"), api.file("b.png"), api.file("c.png"));

    let set = api
        .post(
            "/collections",
            json!({ "collection_type": "set", "members": [a, b] }),
        )
        .await["id"]
        .as_i64()
        .unwrap();
    let made = api.get(&format!("/entities/{set}")).await;
    assert_eq!(made["title"], "Set");
    assert_eq!(
        made["collection"],
        json!({ "collection_type": "set", "member_count": 2, "ordered": false, "collection_id": null })
    );
    assert_eq!(api.members(set), [(a, None), (b, None)]);
    assert_eq!(api.found(&format!("in={set}")).await, [a, b]);

    let shared = api.metadata(&[a, c]).await;
    assert_eq!(
        shared["memberships"],
        json!([{ "id": set, "title": "Set", "collection_type": "set", "count": 1, "collection_id": null }])
    );

    let answer = api
        .post(
            &format!("/collections/{set}/members"),
            json!({ "add": [c, a], "remove": [b] }),
        )
        .await;
    assert_eq!(answer["member_count"], 2);
    assert_eq!(api.members(set), [(a, None), (c, None)]);

    // A title, when given, is kept; a blank one is not one.
    for (title, stored) in [("  Mine ", "Mine"), ("  ", "User Collection")] {
        let id = api
            .post(
                "/collections",
                json!({ "collection_type": "usercollection", "title": title }),
            )
            .await["id"]
            .as_i64()
            .unwrap();
        assert_eq!(api.get(&format!("/entities/{id}")).await["title"], stored);
    }

    api.refused("/collections", json!({ "collection_type": "pile" }))
        .await;
    assert_eq!(
        api.refused("/collections/999/members", json!({ "add": [a] }))
            .await,
        StatusCode::NOT_FOUND
    );
    api.refused(
        &format!("/collections/{set}/members"),
        json!({ "add": [999] }),
    )
    .await;
}

#[tokio::test]
async fn collections_nest_but_never_in_themselves() {
    let api = Api::new();
    let a = api.file("a.png");
    let new = async |body: Value| api.post("/collections", body).await["id"].as_i64().unwrap();
    let outer = new(json!({ "collection_type": "set" })).await;
    let inner = new(json!({ "collection_type": "variant", "members": [a], "parent": outer })).await;
    assert_eq!(api.members(outer), [(inner, None)]);
    assert_eq!(api.found(&format!("contains={inner}")).await, [outer]);

    for (collection, member) in [(outer, outer), (inner, outer)] {
        api.refused(
            &format!("/collections/{collection}/members"),
            json!({ "add": [member] }),
        )
        .await;
    }
    assert_eq!(api.members(inner), [(a, None)]);

    // Deleting a collection leaves its members.
    api.post("/entities/trash", json!({ "ids": [inner] })).await;
    api.post("/entities/delete", json!({ "ids": [inner] }))
        .await;
    assert_eq!(api.found("").await, [a, outer]);
    assert_eq!(api.members(outer), []);
}

#[tokio::test]
async fn ordered_collections_keep_positions() {
    let api = Api::new();
    let (a, b, c, d) = (
        api.file("a.png"),
        api.file("b.png"),
        api.file("c.png"),
        api.file("d.png"),
    );
    // A sequence is ordered unless told otherwise.
    let sequence = api
        .post(
            "/collections",
            json!({ "collection_type": "sequence", "members": [c, a, b] }),
        )
        .await["id"]
        .as_i64()
        .unwrap();
    assert_eq!(
        api.members(sequence),
        [(c, Some(0)), (a, Some(1)), (b, Some(2))]
    );

    // New members go on the end; ones already in keep their place.
    api.post(
        &format!("/collections/{sequence}/members"),
        json!({ "add": [a, d] }),
    )
    .await;
    assert_eq!(api.members(sequence).last(), Some(&(d, Some(3))));

    // A search can be kept to a collection's members without a tab of its
    // own: in the collection's order, filtered by the query, and whatever
    // another tab would have held. One that is gone has no members.
    let within = async |query: &str, collection: i64| -> Vec<i64> {
        let path = format!("/search/ids?q={query}&collection={collection}");
        serde_json::from_value(api.get(&path).await["ids"].clone()).unwrap()
    };
    assert_eq!(within("", sequence).await, [c, a, b, d]);
    assert_eq!(within("sort%3Did", sequence).await, [a, b, c, d]);
    assert_eq!(within(&format!("id%3D{a},{d}"), sequence).await, [a, d]);
    assert!(within("", 999).await.is_empty());
    let upload = api.post("/tabs", json!({ "kind": "upload" })).await["id"]
        .as_i64()
        .unwrap();
    let both = format!("/search/ids?q=&collection={sequence}&tab={upload}");
    assert_eq!(api.get(&both).await["ids"], json!([c, a, b, d]));

    // Members left out of a new order follow it, as they were.
    let (status, _) = api
        .call(
            "PUT",
            &format!("/collections/{sequence}/order"),
            Some(json!({ "ids": [b, d] })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        api.members(sequence),
        [(b, Some(0)), (d, Some(1)), (c, Some(2)), (a, Some(3))]
    );

    // A collection that becomes ordered gives its members positions.
    let set = api
        .post(
            "/collections",
            json!({ "collection_type": "set", "members": [b, a] }),
        )
        .await["id"]
        .as_i64()
        .unwrap();
    assert_eq!(api.members(set), [(a, None), (b, None)]);
    api.edit(&[set], json!({ "set": { "ordered": true } }))
        .await;
    assert_eq!(api.members(set), [(a, Some(0)), (b, Some(1))]);
    assert_eq!(
        api.metadata(&[set, sequence]).await["ordered"],
        json!({ "value": true, "mixed": false })
    );
    api.edit(&[set], json!({ "set": { "collection_type": "variant" } }))
        .await;
    assert_eq!(
        api.metadata(&[set, sequence]).await["collection_type"]["mixed"],
        true
    );
}

#[tokio::test]
async fn tags_are_defined_described_and_deleted() {
    let api = Api::new();
    let a = api.file("a.png");
    let named = |value: &str| json!({ "field": "tags", "value": value });

    // A tag made by hand stays though nothing carries it.
    api.post(
        "/tags",
        json!({ "field": "tags", "value": " art : ink ", "description": "Pen work" }),
    )
    .await;
    api.edit(&[a], json!({ "add": { "tags": ["art:ink", "passing"] } }))
        .await;
    api.edit(
        &[a],
        json!({ "remove": { "tags": ["art:ink", "passing"] } }),
    )
    .await;
    assert_eq!(api.tags("tags").await, [tag("art:ink", 0)]);
    let listed = api.get("/tags/all?field=tags").await;
    assert_eq!(listed["tags"][0]["description"], "Pen work");

    // The description shows on the files that carry it.
    api.edit(&[a], json!({ "add": { "tags": ["art:ink"] } }))
        .await;
    assert_eq!(
        api.metadata(&[a]).await["tags"]["tags"][0]["description"],
        "Pen work"
    );
    let mut described = named("art:ink");
    described["description"] = json!("  ");
    api.post("/tags/describe", described).await;
    assert_eq!(
        api.metadata(&[a]).await["tags"]["tags"][0]["description"],
        Value::Null
    );

    api.refused("/tags/delete", named("art:ink")).await;
    assert_eq!(
        api.refused("/tags/delete", named("nothing")).await,
        StatusCode::NOT_FOUND
    );
    api.edit(&[a], json!({ "remove": { "tags": ["art:ink"] } }))
        .await;
    api.post("/tags/delete", named("art:ink")).await;
    assert_eq!(api.tags("tags").await, []);

    api.refused("/tags", named("@at")).await;
    api.refused("/tags", json!({ "field": "source_url", "value": "x" }))
        .await;
}

#[tokio::test]
async fn renaming_a_tag_merges_into_one_of_that_name() {
    let api = Api::new();
    let (a, b) = (api.file("a.png"), api.file("b.png"));
    let rename = |from: &str, to: &str| json!({ "field": "tags", "from": from, "to": to });
    api.edit(&[a, b], json!({ "add": { "tags": ["kitten"] } }))
        .await;
    api.edit(
        &[a],
        json!({ "add": { "tags": ["cat"], "creator": ["kitten"] } }),
    )
    .await;
    api.post(
        "/tags/describe",
        json!({ "field": "tags", "value": "kitten", "description": "Young" }),
    )
    .await;

    api.post("/tags/rename", rename("kitten", "kitty")).await;
    assert_eq!(api.tags("tags").await, [tag("cat", 1), tag("kitty", 2)]);

    api.post("/tags/rename", rename("kitty", "Cat")).await;
    assert_eq!(api.tags("tags").await, [tag("cat", 2)]);
    assert_eq!(
        carried(&api.metadata(&[a, b]).await, "tags"),
        [tag("cat", 2)]
    );
    // The merged tag takes the description it lacked.
    assert_eq!(
        api.get("/tags/all?field=tags").await["tags"][0]["description"],
        "Young"
    );
    // Another type's tag of the same name is its own.
    assert_eq!(api.tags("creator").await, [tag("kitten", 1)]);

    assert_eq!(
        api.refused("/tags/rename", rename("nothing", "something"))
            .await,
        StatusCode::NOT_FOUND
    );
    api.refused("/tags/rename", rename("cat", "a::b")).await;
}

#[tokio::test]
async fn aliases_wait_to_be_applied() {
    let api = Api::new();
    let (a, b) = (api.file("a.png"), api.file("b.png"));
    let alias =
        |alias: &str, target: &str| json!({ "field": "tags", "alias": alias, "target": target });
    api.edit(&[a], json!({ "add": { "tags": ["kitty"] } }))
        .await;
    api.edit(&[b], json!({ "add": { "tags": ["cat"] } })).await;

    // Files already carrying the alias keep it for now.
    api.post("/tags/alias", alias("kitty", "cat")).await;
    let listed = api.get("/tags/all?field=tags").await;
    assert_eq!(listed["pending"], 1);
    assert_eq!(
        listed["tags"],
        json!([{
            "value": "cat", "count": 1, "description": null,
            "aliases": [{ "value": "kitty", "count": 1 }],
        }])
    );
    assert_eq!(
        carried(&api.metadata(&[a]).await, "tags"),
        [tag("kitty", 1)]
    );
    // A search for the alias is a search for its tag.
    assert_eq!(api.found("kitty").await, [b]);

    // Added from now on, the alias is its tag.
    api.edit(&[b], json!({ "add": { "tags": ["Kitty"] } }))
        .await;
    assert_eq!(carried(&api.metadata(&[b]).await, "tags"), [tag("cat", 1)]);

    assert_eq!(
        api.post("/tags/aliases/apply", json!({})).await["updated"],
        1
    );
    assert_eq!(api.tags("tags").await, [tag("cat", 2)]);
    assert_eq!(api.get("/tags/all?field=tags").await["pending"], 0);
    assert_eq!(api.found("kitty").await, [a, b]);

    // Aliases never chain, and follow a renamed tag.
    api.post("/tags/alias", alias("puss", "kitty")).await;
    api.post(
        "/tags/rename",
        json!({ "field": "tags", "from": "cat", "to": "feline" }),
    )
    .await;
    let listed = api.get("/tags/all?field=tags").await;
    assert_eq!(listed["tags"][0]["value"], "feline");
    assert_eq!(listed["tags"][0]["aliases"].as_array().unwrap().len(), 2);

    api.refused("/tags/alias", alias("feline", "feline")).await;
    api.refused(
        "/tags/rename",
        json!({ "field": "tags", "from": "kitty", "to": "x" }),
    )
    .await;
    api.refused("/tags", json!({ "field": "tags", "value": "puss" }))
        .await;
    api.post("/tags/alias", alias("puss", "")).await;
    assert_eq!(
        api.refused("/tags/alias", alias("puss", "")).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn suggestions_go_a_namespace_at_a_time() {
    let api = Api::new();
    let (a, b) = (api.file("a.png"), api.file("b.png"));
    api.edit(&[a, b], json!({ "add": { "tags": ["art:ink", "cart"] } }))
        .await;
    api.edit(
        &[a],
        json!({ "add": { "tags": ["art:pen:fine", "artist", "style:inked"] } }),
    )
    .await;
    api.post(
        "/tags/alias",
        json!({ "field": "tags", "alias": "arty", "target": "artist" }),
    )
    .await;
    let suggested = async |typed: &str| {
        let answer = api.get(&format!("/tags?field=tags&q={typed}")).await;
        answer
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                let value = s["value"].as_str().unwrap();
                match s["alias"].as_str() {
                    Some(alias) => format!("{alias}>{value} {}", s["count"]),
                    None => format!("{value} {}", s["count"]),
                }
            })
            .collect::<Vec<_>>()
    };

    // Starting with what was typed, then containing it; the most used first.
    assert_eq!(
        suggested("ar").await,
        ["art: 3", "artist 1", "arty>artist 1", "cart 2"]
    );
    // Inside a namespace: its tags, and the namespaces under it.
    assert_eq!(suggested("art:").await, ["art:ink 2", "art:pen: 1"]);
    assert_eq!(suggested("art:pen:f").await, ["art:pen:fine 1"]);
    // A bare name is found inside namespaces too.
    assert_eq!(suggested("ink").await, ["art:ink 2", "style:inked 1"]);
    assert_eq!(suggested("zzz").await, [] as [&str; 0]);
    assert_eq!(
        api.call("GET", "/tags?field=nope&q=a", None).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn a_bad_query_says_where() {
    let api = Api::new();
    let (status, answer) = api.call("GET", "/search?q=score%3Emany", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(answer["error"].is_string());
    assert!(answer["position"].is_number());

    let a = api.file("a.png");
    let page = api.get("/search?q=").await;
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["id"], a);
    assert_eq!(page["items"][0]["trashed"], false);
}

/// A downloader that fetches from nowhere: two things, the first with a
/// reference to its board and the second, of two files, in a set of its
/// own that is in a collection for the board, and a complaint.
const FAKE_DOWNLOADER: &str = r#"
[ "$1" = download ] || exit 2
input=$(cat)
out=$(printf '%s' "$input" | sed 's/.*"out":"\([^"]*\)".*/\1/')
echo '{"event":"log","message":"Looking"}'
echo '{"event":"found","total":2}'
echo 'not an event'
for n in 1 2; do
  key="https://example.test/item/$n"
  case "$input" in
    *"\"$key\""*) echo "{\"event\":\"skipped\",\"key\":\"$key\"}"; continue ;;
  esac
  files="\"$out/$n-a.txt\""
  printf 'file %s a' "$n" > "$out/$n-a.txt"
  if [ "$n" = 2 ]; then
    printf 'file %s b' "$n" > "$out/$n-b.txt"
    files="$files,\"$out/$n-b.txt\""
  fi
  whole='"id":"fake:board","type":"sourceset","url":"https://example.test/board","title":"Board"'
  if [ "$n" = 2 ]; then
    part='"collection":{"id":"fake#2","url":"'$key'","description":" A pair ","reference":"fake:board:part","tags":{"genre":["Twos"],"nonsense":["x"]},"collection":{'$whole'}}'
  else
    part='"reference":" fake:board "'
  fi
  more='"title":" Thing '$n' ","description":"","tags":{"creator":["Its Maker"],"tags":["@bad"," from : site "],"nonsense":["x"]},'$part
  echo "{\"event\":\"item\",\"key\":\"$key\",\"source_url\":\"$key\",\"files\":[$files],$more}"
done
echo '{"event":"error","message":"one thing could not be had"}'
"#;

impl Api {
    fn fake_downloader(&self) {
        self.downloader("fake", FAKE_DOWNLOADER);
    }

    /// Makes a downloader of a shell script.
    fn downloader(&self, name: &str, script: &str) {
        let folder = self.state.downloaders.join(name);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("fake.sh"), script).unwrap();
        let manifest = json!({
            "title": "Fake",
            // Each gives a source of its own, too.
            "source": if name == "fake" { "fakesite" } else { name },
            "command": ["sh", "fake.sh"],
            // Each is found by a site of its own: the fake one's, or one
            // named for it.
            "sites": [if name == "fake" { "example.test".to_string() } else { format!("{name}.test") }],
            "options": [{ "key": "deep", "label": "Go deep", "default": true }],
        });
        std::fs::write(folder.join("manifest.json"), manifest.to_string()).unwrap();
    }

    /// Runs a download in the tab to its end, and returns how it went.
    async fn download(&self, tab: i64, url: &str) -> Value {
        let path = format!("/tabs/{tab}/download");
        self.post(&format!("{path}/start"), json!({ "url": url }))
            .await;
        for _ in 0..200 {
            let job = self.get(&path).await["job"].clone();
            if job["running"] == false {
                return job;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("the download never ended");
    }

    /// What a tab lists of one kind, lowest ID first.
    async fn in_tab(&self, tab: i64, kind: &str) -> Vec<i64> {
        let answer = self
            .get(&format!("/search/ids?q=kind%3D{kind}+sort%3Did&tab={tab}"))
            .await;
        serde_json::from_value(answer["ids"].clone()).unwrap()
    }
}

#[tokio::test]
async fn a_download_tab_fetches_tags_and_remembers() {
    let api = Api::new();
    api.fake_downloader();
    assert_eq!(api.get("/downloaders").await[0]["name"], "fake");
    // A downloader has no tab of its own: an upload tab takes its addresses.
    api.refused(
        "/tabs",
        json!({ "kind": "download", "downloader": "fake" }),
    )
    .await;
    let tab = api.post("/tabs", json!({ "kind": "upload" })).await["id"]
        .as_i64()
        .unwrap();
    let path = format!("/tabs/{tab}/download");

    // What is downloaded gets the tags the tab gives what is uploaded.
    let (status, _) = api
        .call(
            "PATCH",
            &format!("/tabs/{tab}/upload"),
            Some(json!({ "tags": { "tags": [" wall : paper ", "wall:paper"], "creator": ["Someone"] } })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let before = api.get(&path).await;
    assert_eq!(before, json!({ "seen": 0, "job": null }));

    // A downloader's options are set once, for every tab.
    assert_eq!(
        api.get("/downloaders").await[0]["settings"],
        json!({ "deep": true })
    );
    let shallow = json!({ "options": { "deep": false } });
    api.ok("PATCH", "/downloaders/fake", Some(shallow)).await;
    assert_eq!(
        api.get("/downloaders").await[0]["settings"],
        json!({ "deep": false })
    );
    for bad in [
        json!({ "options": { "shallow": true } }),
        json!({ "tags": { "tags": ["@x"] } }),
    ] {
        assert_eq!(
            api.call("PATCH", "/downloaders/fake", Some(bad)).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    api.refused(&format!("{path}/start"), json!({ "url": "not an address" }))
        .await;
    // An address that is of no downloader's site starts nothing, and says
    // so: it may be a file's, to be fetched as one.
    let other = json!({ "url": "https://elsewhere.test/picture.png" });
    assert_eq!(
        api.post(&format!("{path}/start"), other).await,
        json!({ "downloader": null })
    );
    assert_eq!(api.get(&path).await["job"], Value::Null);
    // Nothing is downloaded into a tab that takes no uploads.
    let gallery = api.post("/tabs", json!({ "kind": "gallery" })).await["id"]
        .as_i64()
        .unwrap();
    let board = json!({ "url": "https://example.test/board" });
    api.refused(&format!("/tabs/{gallery}/download/start"), board)
        .await;

    let stale = json!({ "query": "", "ids": [], "custom": false });
    api.ok("PUT", &format!("/tabs/{tab}/view"), Some(stale))
        .await;

    // Everything comes in, with where it is from and the tab's tags.
    let job = api.download(tab, "https://example.test/board").await;
    assert_eq!(job["outcome"], "done");
    assert_eq!(job["message"], "Looking");
    let counts = |job: &Value| {
        [
            "found",
            "downloaded",
            "added",
            "existing",
            "skipped",
            "failed",
        ]
        .map(|key| job[key].as_u64().unwrap())
    };
    assert_eq!(counts(&job), [2, 2, 3, 0, 0, 1]);
    assert_eq!(job["errors"], json!(["one thing could not be had"]));
    let files = api.found("kind=file sort=id").await;
    assert_eq!(files.len(), 3);
    // The tab lists them all: the two that are in a set too, beside it.
    assert_eq!(api.in_tab(tab, "file").await, files);
    // A view saved before the files came does not outlast them.
    assert_eq!(api.get(&format!("/tabs/{tab}/view")).await, Value::Null);
    let all = api.metadata(&files).await;
    assert_eq!(carried(&all, "source"), [tag("fakesite", 3)]);
    // With the tags the downloader made of each thing itself; what is not
    // a tag is passed over.
    assert_eq!(
        carried(&all, "tags"),
        [tag("from:site", 3), tag("wall:paper", 3)]
    );
    assert_eq!(
        carried(&all, "creator"),
        [tag("Its Maker", 3), tag("Someone", 3)]
    );
    // And the title it has on the site; an empty description is none.
    assert_eq!(
        api.get(&format!("/entities/{}", files[0])).await["title"],
        "Thing 1"
    );
    assert_eq!(
        api.metadata(&files[1..]).await["scalars"]["title"]["value"],
        "Thing 2"
    );
    assert_eq!(
        all["scalars"]["description"],
        json!({ "value": null, "mixed": false })
    );
    assert_eq!(
        carried(&all, "source_url"),
        [
            tag("https://example.test/item/1", 1),
            tag("https://example.test/item/2", 2)
        ]
    );

    // The first said what it is part of, which is kept as a reference.
    assert_eq!(carried(&all, "reference"), [tag("fake:board", 1)]);
    assert_eq!(api.found("reference=fake:board").await, files[..1]);

    // The second thing asked for a set of its own: it holds its files in
    // order, under the ID, description and tags given for it, with the
    // tab's tags but not those of the thing. Given no title, it has none:
    // its ID is not its title.
    let sets = api.found("type=set").await;
    assert_eq!(sets.len(), 1);
    assert_eq!(
        api.members(sets[0]),
        [(files[1], Some(0)), (files[2], Some(1))]
    );
    let set = api.metadata(&sets).await;
    assert_eq!(set["scalars"]["title"]["value"], Value::Null);
    assert_eq!(set["collection_id"]["value"], "fake#2");
    assert_eq!(api.found("collection_id=fake#2").await, sets);
    assert_eq!(set["scalars"]["description"]["value"], "A pair");
    assert_eq!(carried(&set, "source"), [tag("fakesite", 1)]);
    assert_eq!(carried(&set, "creator"), [tag("Someone", 1)]);
    assert_eq!(carried(&set, "genre"), [tag("Twos", 1)]);
    // What it is part of is its own reference, and not its files'.
    assert_eq!(carried(&set, "reference"), [tag("fake:board:part", 1)]);
    assert_eq!(api.found("reference=fake:board:*").await, sets);
    assert_eq!(
        carried(&set, "source_url"),
        [tag("https://example.test/item/2", 1)]
    );

    // It asked for its set to be put in a collection of another type and
    // address, which holds the set and not its files.
    let wholes = api.found("type=sourceset").await;
    assert_eq!(wholes.len(), 1);
    assert_eq!(api.members(wholes[0]), [(sets[0], Some(0))]);
    let whole = api.metadata(&wholes).await;
    assert_eq!(whole["scalars"]["title"]["value"], "Board");
    assert_eq!(carried(&whole, "source"), [tag("fakesite", 1)]);
    assert_eq!(carried(&whole, "creator"), [tag("Someone", 1)]);
    assert_eq!(
        carried(&whole, "source_url"),
        [tag("https://example.test/board", 1)]
    );

    // Both collections are listed in the tab, beside the files.
    let mut made = [sets[0], wholes[0]];
    made.sort();
    assert_eq!(api.in_tab(tab, "collection").await, made);

    // What was seen is passed over the next time.
    let seen = api.get(&format!("{path}/seen")).await;
    assert_eq!(seen.as_array().unwrap().len(), 2);
    let again = api.download(tab, "https://example.test/board").await;
    assert_eq!(counts(&again), [2, 0, 0, 0, 2, 1]);

    // Forgotten, a thing is fetched again; the library already has its
    // files, and makes no second set of them.
    let forgotten = api
        .post(
            &format!("{path}/seen/forget"),
            json!({ "keys": ["https://example.test/item/2"] }),
        )
        .await;
    assert_eq!(forgotten["forgotten"], 1);
    // A title the user wrote stays when the thing is fetched again. The
    // set is found by its ID, whatever else about it has changed, even
    // from the trash.
    api.edit(&files[1..2], json!({ "set": { "title": "Mine" } }))
        .await;
    api.edit(&sets, json!({ "set": { "title": "A pair of mine" } }))
        .await;
    api.edit(
        &sets,
        json!({ "remove_source_url": ["https://example.test/item/2"] }),
    )
    .await;
    api.post("/entities/trash", json!({ "ids": sets })).await;
    let third = api.download(tab, "https://example.test/board").await;
    assert_eq!(
        api.get(&format!("/entities/{}", files[1])).await["title"],
        "Mine"
    );
    assert_eq!(counts(&third), [2, 1, 0, 2, 1, 1]);
    assert_eq!(api.in_tab(tab, "file").await, files);
    assert_eq!(api.in_tab(tab, "collection").await.len(), 2);
    assert_eq!(api.found("type=set").await, sets);
    assert_eq!(api.found("type=sourceset").await, wholes);
    assert_eq!(api.members(sets[0]).len(), 2);
    assert_eq!(api.members(wholes[0]).len(), 1);
    assert_eq!(
        api.metadata(&sets).await["scalars"]["title"]["value"],
        "A pair of mine"
    );

    // No two collections share an ID, and one is one collection's alone.
    let taken = json!({ "ids": wholes, "set": { "collection_id": "fake#2" } });
    api.refused("/entities/edit", taken).await;
    let both = json!({ "ids": [sets[0], wholes[0]], "set": { "collection_id": "new" } });
    api.refused("/entities/edit", both).await;
    let made = json!({ "collection_type": "set", "collection_id": "fake:board" });
    api.refused("/collections", made).await;
    api.edit(&wholes, json!({ "set": { "collection_id": " board " } }))
        .await;
    assert_eq!(
        api.get(&format!("/entities/{}", wholes[0])).await["collection"]["collection_id"],
        "board"
    );
    api.edit(&wholes, json!({ "set": { "collection_id": null } }))
        .await;
    assert_eq!(api.found("has=collection_id").await, sets);
    assert_eq!(api.get(&path).await["seen"], 2);
    assert_eq!(
        api.post(&format!("{path}/seen/forget"), json!({})).await["forgotten"],
        2
    );

    // Nothing is left behind in the temporary directory.
    assert_eq!(std::fs::read_dir(&api.state.tmp).unwrap().count(), 0);

    // The files outlive the tab.
    api.ok("DELETE", &format!("/tabs/{tab}"), None).await;
    assert_eq!(api.call("GET", &path, None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(api.found("kind=file").await, files);
}

#[tokio::test]
async fn a_download_can_be_cancelled_and_can_fail() {
    let api = Api::new();
    api.downloader(
        "slow",
        "cat > /dev/null; echo '{\"event\":\"found\",\"total\":9}'; sleep 30",
    );
    api.downloader(
        "broken",
        "cat > /dev/null; echo 'the site said no' >&2; exit 3",
    );
    let new = async || {
        let tab = json!({ "kind": "upload" });
        api.post("/tabs", tab).await["id"].as_i64().unwrap()
    };
    let job = async |tab: i64| api.get(&format!("/tabs/{tab}/download")).await["job"].clone();
    let ended = async |tab: i64| {
        for _ in 0..200 {
            let job = job(tab).await;
            if job["running"] == false {
                return job;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("the download never ended");
    };
    // Each address finds its downloader by its site.
    let start = json!({ "url": "https://slow.test/" });

    let slow = new().await;
    let started = api
        .post(&format!("/tabs/{slow}/download/start"), start.clone())
        .await;
    assert_eq!(started, json!({ "downloader": "slow" }));
    // One at a time per tab.
    api.refused(&format!("/tabs/{slow}/download/start"), start.clone())
        .await;
    while job(slow).await["found"] != 9 {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    api.post(&format!("/tabs/{slow}/download/cancel"), json!({}))
        .await;
    assert_eq!(ended(slow).await["outcome"], "cancelled");

    // A script that fails says why on its last line.
    let broken = new().await;
    let start = json!({ "url": "https://www.broken.test/thing" });
    api.post(&format!("/tabs/{broken}/download/start"), start)
        .await;
    assert_eq!(ended(broken).await["outcome"], "the site said no");
    assert_eq!(std::fs::read_dir(&api.state.tmp).unwrap().count(), 0);
}

#[tokio::test]
async fn a_downloader_hands_an_address_to_another() {
    let api = Api::new();
    // One site's post shows a video that is another site's: the first
    // downloader knows the post, and hands the video's address over.
    api.downloader(
        "inner",
        r#"
input=$(cat)
out=$(printf '%s' "$input" | sed 's/.*"out":"\([^"]*\)".*/\1/')
printf 'the video' > "$out/v.txt"
echo "{\"event\":\"item\",\"key\":\"https://inner.test/v\",\"source_url\":\"https://inner.test/v\",\"files\":[\"$out/v.txt\"],\"tags\":{\"creator\":[\"Its Poster\"]}}"
"#,
    );
    // It is told which sites the other downloaders take.
    api.downloader(
        "outer",
        r#"
input=$(cat)
case "$input" in
  *'"delegates":["inner.test"]'*) ;;
  *) echo 'not told whom to hand things to' >&2; exit 4 ;;
esac
case "$input" in
  *lost*) to="https://nowhere.test/x" ;;
  *) to="https://www.inner.test/v" ;;
esac
echo "{\"event\":\"item\",\"key\":\"https://outer.test/post\",\"source_url\":\"https://outer.test/post\",\"title\":\"A post\",\"tags\":{\"genre\":[\"Linked\"]},\"delegate\":[\"$to\"]}"
"#,
    );
    let tab = api.post("/tabs", json!({ "kind": "upload" })).await["id"]
        .as_i64()
        .unwrap();
    let tags = json!({ "tags": { "tags": ["kept"] } });
    api.ok("PATCH", &format!("/tabs/{tab}/upload"), Some(tags))
        .await;

    let job = api.download(tab, "https://outer.test/post").await;
    assert_eq!(job["outcome"], "done");
    assert_eq!(job["errors"], json!([]));
    assert_eq!(
        (&job["downloaded"], &job["added"], &job["failed"]),
        (&json!(1), &json!(1), &json!(0))
    );
    // The one file has what each downloader gives: the source of both,
    // the address on both sites, the tags of both, and the tab's.
    let files = api.in_tab(tab, "file").await;
    assert_eq!(files.len(), 1);
    let file = api.metadata(&files).await;
    assert_eq!(carried(&file, "source"), [tag("inner", 1), tag("outer", 1)]);
    assert_eq!(
        carried(&file, "source_url"),
        [
            tag("https://inner.test/v", 1),
            tag("https://outer.test/post", 1)
        ]
    );
    assert_eq!(carried(&file, "creator"), [tag("Its Poster", 1)]);
    assert_eq!(carried(&file, "genre"), [tag("Linked", 1)]);
    assert_eq!(carried(&file, "tags"), [tag("kept", 1)]);
    assert_eq!(file["scalars"]["title"]["value"], "A post");
    assert_eq!(std::fs::read_dir(&api.state.tmp).unwrap().count(), 0);

    // An address no other downloader takes fails the thing that showed it.
    let job = api.download(tab, "https://outer.test/lost").await;
    assert_eq!((&job["downloaded"], &job["failed"]), (&json!(0), &json!(1)));
    let said = job["errors"][0].as_str().unwrap();
    assert!(said.contains("no other downloader takes"), "{said}");
}

/// A website of three addresses: a picture served without an extension,
/// a page, and nothing. Returns where it listens.
async fn website() -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let read = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).into_owned();
            let (status, kind, body) = if request.starts_with("GET /a%20picture?") {
                ("200 OK", "image/png", "not really a picture")
            } else if request.starts_with("GET /page ") {
                ("200 OK", "text/html; charset=utf-8", "<p>a page</p>")
            } else {
                ("404 Not Found", "text/plain", "nothing here")
            };
            let answer = format!(
                "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n\
                 Connection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(answer.as_bytes()).await;
        }
    });
    address
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_is_fetched_from_its_address() {
    let api = Api::new();
    let site = website().await;
    let tab = api.post("/tabs", json!({ "kind": "upload" })).await["id"]
        .as_i64()
        .unwrap();

    // It comes in as an upload would, named after its address, with the
    // extension its type gives, and the address as its source URL.
    let url = format!("{site}/a%20picture?size=large");
    let fetch = json!({ "url": url, "tab": tab });
    let (status, file) = api.call("POST", "/files/fetch", Some(fetch.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{file}");
    assert_eq!(file["original_name"], "a picture.png");
    assert_eq!(file["extension"], "png");
    let id = file["id"].as_i64().unwrap();
    assert_eq!(api.in_tab(tab, "file").await, [id]);
    assert_eq!(
        api.get(&format!("/entities/{id}")).await["source_url"],
        json!([url])
    );

    // Fetched again, the library has it already.
    let (status, again) = api.call("POST", "/files/fetch", Some(fetch)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["id"], id);

    // A page is not a file, and what is not there cannot be had; neither
    // is an address that is not of the web.
    for bad in [
        format!("{site}/page"),
        format!("{site}/gone"),
        "file:///etc/hosts".into(),
    ] {
        api.refused("/files/fetch", json!({ "url": bad, "tab": tab }))
            .await;
    }
    assert_eq!(api.found("kind=file").await, [id]);
    assert_eq!(std::fs::read_dir(&api.state.tmp).unwrap().count(), 0);
}

#[tokio::test]
async fn the_inbox_downloads_what_it_is_sent() {
    let api = Api::new();
    api.fake_downloader();
    let send = async |url: &str| api.call("POST", "/inbox", Some(json!({ "url": url }))).await;
    /// How a request ended, once it has.
    async fn ended(api: &Api, id: &Value) -> Value {
        for _ in 0..500 {
            let request = api.get(&format!("/inbox/queue/{id}")).await;
            if request["status"] != "queued" && request["status"] != "running" {
                return request;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("request {id} never ended");
    }

    // An address no downloader names as its site is refused.
    assert_eq!(send("https://elsewhere.test/item").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send("not an address").await.0, StatusCode::BAD_REQUEST);

    // The downloader is given tags of its own for the inbox.
    api.ok("PATCH", "/downloaders/fake", Some(json!({ "tags": { "tags": ["sent"] } })))
        .await;

    // It is found by the site, a subdomain of it included, and queued. It
    // can bring tags of its own, typed as in the interface.
    let with_tags = json!({
        "url": "https://www.example.test/board",
        "tags": ["once", " @cr:A Sender ", "@genre: quick", ""],
    });
    let (status, first) = api.call("POST", "/inbox", Some(with_tags)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(first["downloader"], "fake");
    assert_eq!(
        first["tags"],
        json!({ "tags": ["once"], "creator": ["A Sender"], "genre": ["quick"] })
    );
    let bad = json!({ "url": "https://example.test/board", "tags": ["@nothing:x"] });
    assert_eq!(api.call("POST", "/inbox", Some(bad)).await.0, StatusCode::BAD_REQUEST);
    let (_, second) = send("https://example.test/board").await;

    // One at a time, in the order asked: two things, of three files.
    let first = ended(&api, &first["id"]).await;
    assert_eq!((&first["status"], &first["added"]), (&json!("done"), &json!(3)));
    assert_eq!(first["message"], "one thing could not be had");
    // Nothing is skipped as seen: asked for again, it is fetched again, and
    // the library has it already.
    let second = ended(&api, &second["id"]).await;
    assert_eq!(
        (&second["status"], &second["added"], &second["existing"]),
        (&json!("done"), &json!(0), &json!(3))
    );

    // It is all listed under the inbox's tab: the files and their collections.
    let inbox = api.get("/inbox").await;
    let tab = inbox["tab"].as_i64().unwrap();
    assert_eq!(inbox["listed"], 5);
    assert_eq!(inbox["queue"].as_array().unwrap().len(), 2);
    assert_eq!(inbox["downloaders"][0]["tags"], json!({ "tags": ["sent"] }));
    assert_eq!(api.in_tab(tab, "file").await.len(), 3);
    assert_eq!(api.in_tab(tab, "collection").await.len(), 2);
    assert_eq!(api.found("sent kind=file").await.len(), 3);
    // The request's own tags are given too, beside the downloader's.
    assert_eq!(api.found("sent once \"@cr:A Sender\" @ge:quick kind=file").await.len(), 3);
    let tabs = api.get("/tabs").await;
    assert_eq!(tabs[0]["kind"], "inbox");
    // Asked for again, it is the same tab.
    let again = api.post("/tabs", json!({ "kind": "inbox" })).await;
    assert_eq!(again["id"], tab);

    // Closed, it is out of sight and keeps what it lists, and what is sent
    // meanwhile is listed too.
    api.ok("DELETE", &format!("/tabs/{tab}"), None).await;
    assert_eq!(api.get("/tabs").await, json!([]));
    let inbox = api.get("/inbox").await;
    assert_eq!((&inbox["tab"], &inbox["listed"]), (&Value::Null, &json!(5)));
    let (_, third) = send("https://example.test/board").await;
    assert_eq!(ended(&api, &third["id"]).await["status"], "done");
    assert_eq!(api.get("/tabs").await, json!([]));
    // Opened again, it is the same tab, as it was.
    let again = api.post("/tabs", json!({ "kind": "inbox" })).await;
    assert_eq!(again["id"], tab);
    assert_eq!(api.get("/tabs").await[0]["id"], tab);
    assert_eq!(api.in_tab(tab, "file").await.len(), 3);

    // Only clearing empties it, and that takes nothing out of the library.
    api.post("/inbox/clear", json!({})).await;
    let inbox = api.get("/inbox").await;
    assert_eq!((&inbox["listed"], &inbox["queue"]), (&json!(0), &json!([])));
    assert_eq!(api.found("kind=file").await.len(), 3);
}

#[tokio::test]
async fn a_selection_tab_holds_what_it_is_given() {
    let api = Api::new();
    let (a, b, c) = (api.file("a.png"), api.file("b.png"), api.file("c.png"));
    api.post("/entities/edit", json!({ "ids": [a], "add": { "tags": ["cat"] } }))
        .await;

    // It is given the entities it holds; one that does not exist is passed over.
    let tab = api
        .post("/tabs", json!({ "kind": "selection", "ids": [c, a, 999] }))
        .await;
    assert_eq!(tab["kind"], "selection");
    let id = tab["id"].as_i64().unwrap();
    assert_eq!(api.in_tab(id, "file").await, [a, c]);
    assert_eq!(api.get("/tabs").await[0]["kind"], "selection");

    // Its query filters what it holds, and never reaches beyond it.
    let within = async |q: &str| {
        let answer = api.get(&format!("/search/ids?q={q}&tab={id}")).await;
        serde_json::from_value::<Vec<i64>>(answer["ids"].clone()).unwrap()
    };
    assert_eq!(within("cat").await, [a]);
    assert_eq!(within("-cat").await, [c]);
    assert!(!within("").await.contains(&b));

    // Closing it takes nothing out of the library.
    api.ok("DELETE", &format!("/tabs/{id}"), None).await;
    assert_eq!(api.found("kind=file").await, [a, b, c]);
}

/// A downloader with a login: its script takes its own site's cookies out
/// of a file, and finds a login among them if there is one called `session`.
const LOGIN_DOWNLOADER: &str = r#"
[ "$1" = cookies ] || exit 2
[ "$2" = --file ] || { echo 'no browser here' >&2; exit 1; }
if grep -q "mysite.test.*session" "$3"; then
  grep "mysite.test" "$3" > "$5"
  echo '{"logged_in":true}'
else
  echo '{"logged_in":false}'
fi
"#;

#[tokio::test]
async fn a_headless_server_is_sent_its_logins() {
    let api = Api::with(true);
    api.downloader("site", LOGIN_DOWNLOADER);
    let folder = api.state.downloaders.join("site");
    let manifest = json!({
        "title": "Site",
        "source": "mysite",
        "command": ["sh", "fake.sh"],
        "cookies": { "browsers": ["chrome"] },
    });
    std::fs::write(folder.join("manifest.json"), manifest.to_string()).unwrap();
    let saved = api.state.cookies.join("site.txt");

    // It says what it is, and has no browser to read a login from.
    let listed = api.get("/downloaders").await;
    assert_eq!((&listed[0]["headless"], &listed[0]["login_saved"]), (&json!(true), &Value::Null));
    let from_browser = json!({ "browser": "chrome" });
    assert_eq!(
        api.refused("/downloaders/site/cookies", from_browser).await,
        StatusCode::BAD_REQUEST
    );

    // A file with no login for the site is refused, and nothing is kept.
    let other = "other.test\tTRUE\t/\tTRUE\t0\tsession\tabc\n";
    assert_eq!(
        api.refused("/downloaders/site/cookies/file", json!({ "cookies": other })).await,
        StatusCode::BAD_REQUEST
    );
    assert!(!saved.exists());

    // One with a login is kept: the site's own cookies, and no one else's.
    let both = format!("{other}.mysite.test\tTRUE\t/\tTRUE\t0\tsession\txyz\n");
    let kept = api
        .post("/downloaders/site/cookies/file", json!({ "cookies": both }))
        .await;
    assert!(kept["login_saved"].is_number());
    let text = std::fs::read_to_string(&saved).unwrap();
    assert!(text.contains("mysite.test") && !text.contains("other.test"));
    // What was sent is not left lying about.
    assert_eq!(std::fs::read_dir(&api.state.tmp).unwrap().count(), 0);

    api.ok("DELETE", "/downloaders/site/cookies", None).await;
    assert!(!saved.exists());
}

#[tokio::test]
async fn a_zip_is_unpacked_into_files_and_collections() {
    use std::io::Write;
    use zip::{ZipWriter, write::SimpleFileOptions};

    let api = Api::new();
    let tab = api.post("/tabs", json!({ "kind": "upload" })).await["id"]
        .as_i64()
        .unwrap();

    // Books are told by their names, so nothing here needs another program.
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for name in [
        "Album/page 10.pdf",
        "notes.txt",
        "Album/Extras/bonus.pdf",
        "cover.pdf",
        "Album/page 2.pdf",
        "Album/inner.zip",
        "Album/.DS_Store",
        "__MACOSX/Album/._page 2.pdf",
        "Unshown/readme.txt",
    ] {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(format!("what is in {name}").as_bytes()).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let send = async || {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/files/archive?name=things.zip&tab={tab}"))
            .body(Body::from(bytes.clone()))
            .unwrap();
        let response = api.app.clone().oneshot(request).await.unwrap();
        assert!(response.status().is_success());
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice::<Value>(&body).unwrap()
    };

    // The files the library can show go in; the folders they are in become
    // collections, one inside the other; the rest is said to have failed,
    // and what a Mac leaves behind is not spoken of.
    let unpacked = send().await;
    assert_eq!(
        (&unpacked["added"], &unpacked["duplicates"], &unpacked["collections"]),
        (&json!(4), &json!(0), &json!(2))
    );
    let failed: Vec<&str> = unpacked["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|failure| failure["name"].as_str().unwrap())
        .collect();
    assert_eq!(failed, ["notes.txt", "Album/inner.zip", "Unshown/readme.txt"]);
    // The archive itself is not kept.
    assert_eq!(api.found("kind=file").await.len(), 4);

    // The tab lists what was at the top: the loose file, and the folder.
    let titled = |id: i64| {
        let conn = api.state.db.lock().unwrap();
        conn.query_row(
            "SELECT coalesce(e.title, f.original_name) FROM entity e
             LEFT JOIN file f ON f.entity_id = e.id WHERE e.id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .unwrap()
    };
    let names = |ids: Vec<i64>| ids.into_iter().map(&titled).collect::<Vec<_>>();
    assert_eq!(names(api.in_tab(tab, "file").await), ["cover.pdf"]);
    let top = api.in_tab(tab, "collection").await;
    assert_eq!(names(top.clone()), ["Album"]);
    // A folder holds its files by name, 2 before 10, and then its folders.
    let inside = |collection: i64| {
        names(api.members(collection).into_iter().map(|(id, _)| id).collect())
    };
    assert_eq!(inside(top[0]), ["page 2.pdf", "page 10.pdf", "Extras"]);
    let extras = api.members(top[0])[2].0;
    assert_eq!(inside(extras), ["bonus.pdf"]);

    // The tab can be set to give tags: to what is uploaded from then on,
    // files and folders alike, and to a file the library already had.
    assert!(api.found("holiday").await.is_empty());
    api.ok("PATCH", &format!("/tabs/{tab}/upload"), Some(json!({ "tags": { "tags": ["holiday", " holiday "], "creator": ["Me"] } })))
        .await;
    assert_eq!(
        api.get(&format!("/tabs/{tab}/upload")).await["tags"],
        json!({ "creator": ["Me"], "tags": ["holiday"] })
    );
    // Sent again, the library has the files already.
    let again = send().await;
    assert_eq!((&again["added"], &again["duplicates"]), (&json!(0), &json!(4)));
    assert_eq!(api.found("holiday @cr:Me kind=file").await.len(), 4);
    assert_eq!(api.found("holiday kind=collection").await.len(), 2);
    // Only an upload tab gives tags, and only tags that are tags.
    let bad = json!({ "tags": { "nonsense": ["x"] } });
    assert_eq!(api.refused_with("PATCH", &format!("/tabs/{tab}/upload"), bad).await, StatusCode::BAD_REQUEST);
    let gallery = api.post("/tabs", json!({ "kind": "gallery" })).await["id"].as_i64().unwrap();
    let tags = json!({ "tags": { "tags": ["x"] } });
    assert_eq!(api.refused_with("PATCH", &format!("/tabs/{gallery}/upload"), tags).await, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_export_carries_metadata_to_another_library() {
    use std::io::{Read, Write};
    use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

    let from = Api::new();
    // Books are told by their names, so nothing here needs another program.
    let file = |name: &str| {
        let id = from.file(name);
        std::fs::write(from.stored(id), format!("what is in file {id}")).unwrap();
        id
    };
    let (a, b, c, d) = (file("a.pdf"), file("b.pdf"), file("c.pdf"), file("a.pdf"));
    from.edit(
        &[a],
        json!({
            "set": { "title": "First", "score": 6, "date": "2021-05", "content_rating": "safe" },
            "add": { "tags": ["metroid:samus"], "creator": ["Someone"] },
            "add_source_url": ["https://example.com/a"],
            "add_identifier": ["site:1"],
            "add_reference": ["4chan:g:1"],
        }),
    )
    .await;
    from.state
        .db
        .lock()
        .unwrap()
        .execute("UPDATE entity SET date_added = '2020-01-02T03:04:05Z' WHERE id = ?1", [a])
        .unwrap();
    let new = async |body: Value| from.post("/collections", body).await["id"].as_i64().unwrap();
    let series = new(json!({ "collection_type": "sequence", "title": "Series", "members": [b, a] })).await;
    new(json!({ "collection_type": "set", "members": [c], "collection_id": "pinterest:pin:1" })).await;
    let all = new(json!({ "collection_type": "usercollection", "title": "Everything", "members": [series] })).await;
    from.edit(&[series], json!({ "add": { "genre": ["horror"] } })).await;

    let zip_of = async |form: String| {
        let request = Request::builder()
            .method("POST")
            .uri("/export")
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(form))
            .unwrap();
        let response = from.app.clone().oneshot(request).await.unwrap();
        assert!(response.status().is_success());
        to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec()
    };
    let names_in = |bytes: &[u8]| {
        let archive = ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).unwrap();
        let mut names: Vec<String> = archive.file_names().map(str::to_string).collect();
        names.sort();
        names
    };

    // A download is the files alone.
    let plain = zip_of(format!("ids={series},{c},{d}")).await;
    assert_eq!(names_in(&plain), ["a (2).pdf", "a.pdf", "b.pdf", "c.pdf"]);

    // An export has a sidecar beside each, and one for each collection:
    // those selected, and those that what was selected is in.
    let exported = zip_of(format!("ids={series},{c},{d}&sidecars=1")).await;
    assert_eq!(
        names_in(&exported),
        [
            "a (2).pdf".to_string(),
            "a (2).pdf.json".to_string(),
            "a.pdf".to_string(),
            "a.pdf.json".to_string(),
            "b.pdf".to_string(),
            "b.pdf.json".to_string(),
            "c.pdf".to_string(),
            "c.pdf.json".to_string(),
            format!("collection-{series}.json"),
            format!("collection-{all}.json"),
            "pinterest_pin_1.json".to_string(),
        ]
    );
    let sidecar = |name: &str| {
        let mut archive = ZipArchive::new(std::io::Cursor::new(exported.clone())).unwrap();
        let mut text = String::new();
        archive.by_name(name).unwrap().read_to_string(&mut text).unwrap();
        serde_json::from_str::<Value>(&text).unwrap()
    };
    assert_eq!(
        sidecar("a.pdf.json"),
        json!({
            "metadata_type": "file",
            "date_added": "2020-01-02T03:04:05Z",
            "title": "First",
            "score": 6,
            "date": "2021-05",
            "content_rating": "safe",
            "tags": ["metroid:samus"],
            "creator": ["Someone"],
            "source_url": ["https://example.com/a"],
            "identifier": ["site:1"],
            "reference": ["4chan:g:1"],
            "collection": [
                { "id": format!("collection-{series}"), "collection_type": "sequence", "index": 1 },
            ],
            "hash": format!("{a:064x}"),
            "extension": "png",
            "media_type": "image",
            "size": 4,
            "original_name": "a.pdf",
        })
    );
    assert_eq!(sidecar("pinterest_pin_1.json")["collection_id"], "pinterest:pin:1");
    assert_eq!(sidecar("c.pdf.json")["collection"][0]["id"], "pinterest:pin:1");
    // The files can be named otherwise: by title where they have one, by
    // hash, or by nothing at all. The sidecar still has the name each had.
    assert_eq!(
        names_in(&zip_of(format!("ids={a},{b}&names=title")).await),
        ["First.png", "b.pdf"]
    );
    let hashed = zip_of(format!("ids={d}&names=hash&sidecars=1")).await;
    let name = format!("{d:064x}.png");
    assert_eq!(names_in(&hashed), [name.clone(), format!("{name}.json")]);
    let random = names_in(&zip_of(format!("ids={a},{b}&names=random")).await);
    assert!(random.iter().all(|name| name.len() == 20 && name.ends_with(".png")), "{random:?}");
    assert_ne!(random[0], random[1]);
    let request = Request::builder()
        .uri(format!("/files/{d}/content?download=1&names=hash"))
        .body(Body::empty())
        .unwrap();
    let response = from.app.clone().oneshot(request).await.unwrap();
    let disposition = response.headers()["content-disposition"].to_str().unwrap();
    assert_eq!(disposition, format!("attachment; filename*=UTF-8''{name}"));

    // A collection by itself can be exported, with nothing in it.
    let empty = new(json!({ "collection_type": "variant" })).await;
    let alone = zip_of(format!("ids={empty}&sidecars=1")).await;
    assert_eq!(names_in(&alone), [format!("collection-{empty}.json")]);

    // Uploaded to another library, the zip gives what it holds the same
    // metadata there.
    let to = Api::new();
    let tab = to.post("/tabs", json!({ "kind": "upload" })).await["id"].as_i64().unwrap();
    let send = async |bytes: Vec<u8>| {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/files/archive?name=export.zip&tab={tab}"))
            .body(Body::from(bytes))
            .unwrap();
        let response = to.app.clone().oneshot(request).await.unwrap();
        assert!(response.status().is_success());
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice::<Value>(&body).unwrap()
    };
    let unpacked = send(exported.clone()).await;
    assert_eq!(unpacked["failures"], json!([]));
    assert_eq!(
        (&unpacked["added"], &unpacked["duplicates"], &unpacked["collections"]),
        (&json!(4), &json!(0), &json!(3))
    );
    let one = async |query: &str| {
        let found = to.found(query).await;
        assert_eq!(found.len(), 1, "{query}");
        found[0]
    };
    let first = one("title=First").await;
    let entity = to.get(&format!("/entities/{first}")).await;
    assert_eq!(entity["date_added"], "2020-01-02T03:04:05Z");
    assert_eq!((&entity["score"], &entity["date"]), (&json!(6), &json!("2021-05")));
    assert_eq!(entity["content_rating"], "safe");
    assert_eq!(entity["tags"], json!({ "creator": ["Someone"], "tags": ["metroid:samus"] }));
    assert_eq!(entity["source_url"], json!(["https://example.com/a"]));
    assert_eq!(entity["identifier"], json!(["site:1"]));
    assert_eq!(entity["reference"], json!(["4chan:g:1"]));
    // The two files of one name have it again, though the zip told them apart.
    assert_eq!(to.found("name=a.pdf").await.len(), 2);

    // The collections are as they were: the sequence in its order, inside
    // the collection it was in, and the set with its collection ID.
    let series = one("title=Series").await;
    assert_eq!(to.found("kind=collection @ge:horror").await, [series]);
    let details = to.get(&format!("/entities/{series}")).await["collection"].clone();
    assert_eq!(
        (&details["collection_type"], &details["ordered"], &details["collection_id"]),
        (&json!("sequence"), &json!(true), &Value::Null)
    );
    let second = one("name=b.pdf").await;
    assert_eq!(to.members(series), [(second, Some(0)), (first, Some(1))]);
    let everything = one("title=Everything").await;
    assert_eq!(to.members(everything), [(series, None)]);
    let pin = one("collection_id=pinterest:pin:1").await;
    assert_eq!(to.members(pin), [(one("name=c.pdf").await, None)]);
    assert_eq!(to.get(&format!("/entities/{pin}")).await["title"], "Set");
    // The tab lists what was at the top of the zip, and the collections.
    assert_eq!(to.in_tab(tab, "file").await.len(), 4);
    assert_eq!(to.in_tab(tab, "collection").await.len(), 3);

    // Sent again, nothing the library has is replaced: what the user has
    // written since stays, and the collection with the ID is not made twice.
    to.edit(&[first], json!({ "set": { "title": "Mine", "score": null } })).await;
    let again = send(exported).await;
    assert_eq!((&again["added"], &again["duplicates"]), (&json!(0), &json!(4)));
    let entity = to.get(&format!("/entities/{first}")).await;
    assert_eq!((&entity["title"], &entity["score"]), (&json!("Mine"), &json!(6)));
    assert_eq!(to.found("collection_id=pinterest:pin:1").await, [pin]);
    assert_eq!(to.members(pin).len(), 1);

    // Sidecars written by hand: what can be used of one is, and the rest
    // is said. A folder's own describes the collection the folder becomes.
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let x = json!({
        "title": "Loose",
        "score": 9,
        "tags": ["fine", "@not"],
        "genre": "noir",
        "collection": [{ "id": "group:1", "collection_type": "variant" }],
        "anything_else": { "is": "ignored" },
    });
    let folder = json!({ "collection_type": "sequence", "title": "Chapters", "collection_id": "book:1" });
    for (name, content) in [
        ("x.pdf", "the loose one".to_string()),
        ("x.pdf.json", x.to_string()),
        ("stray.json", json!({ "title": "of nothing" }).to_string()),
        ("broken.pdf.json", "{".to_string()),
        ("Book/1.pdf", "chapter one".to_string()),
        ("Book/_collection.json", folder.to_string()),
    ] {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }
    let unpacked = send(zip.finish().unwrap().into_inner()).await;
    assert_eq!((&unpacked["added"], &unpacked["collections"]), (&json!(2), &json!(2)));
    let failed: Vec<&str> = unpacked["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|failure| failure["name"].as_str().unwrap())
        .collect();
    assert_eq!(failed, ["broken.pdf.json", "stray.json", "x.pdf.json"]);
    let reason = unpacked["failures"][2]["reason"].as_str().unwrap();
    assert!(reason.contains("`score`") && reason.contains("@not"), "{reason}");
    let loose = one("title=Loose").await;
    let entity = to.get(&format!("/entities/{loose}")).await;
    assert_eq!(entity["score"], Value::Null);
    assert_eq!(entity["tags"], json!({ "genre": ["noir"], "tags": ["fine"] }));
    let group = one("collection_id=group:1").await;
    assert_eq!(to.get(&format!("/entities/{group}")).await["collection"]["collection_type"], "variant");
    assert_eq!(to.members(group), [(loose, None)]);
    let book = one("collection_id=book:1").await;
    let entity = to.get(&format!("/entities/{book}")).await;
    assert_eq!((&entity["title"], &entity["collection"]["collection_type"]), (&json!("Chapters"), &json!("sequence")));
    assert_eq!(to.members(book).len(), 1);
}
