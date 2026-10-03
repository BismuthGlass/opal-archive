//! Reading EPUB books and CBZ comic archives, which are both zip files: how
//! many pages they have and which image is the cover.
//!
//! Everything here is blocking; call it from `spawn_blocking`.

use std::{cmp::Ordering, fs::File, io::Read, path::Path};

use zip::ZipArchive;

/// Text characters taken to fill one page of an EPUB that does not say
/// where its pages are; about a paperback page.
const CHARS_PER_PAGE: u64 = 1800;

/// Most that is read of one archive member, so a hostile archive cannot
/// exhaust memory.
const MAX_MEMBER: u64 = 64 * 1024 * 1024;

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"];

type Archive = ZipArchive<File>;

/// Page count of an `epub` or `cbz`. For an EPUB this is the number of
/// print pages it marks, or failing that an estimate from its text.
pub fn pages(path: &Path, extension: &str) -> Option<i64> {
    let mut archive = open(path)?;
    let count = match extension {
        "epub" => epub_pages(&mut archive)?,
        "cbz" => comic_pages(&archive).len() as u64,
        _ => return None,
    };
    (count > 0).then_some(count as i64)
}

/// The cover image of an `epub` or `cbz`, in whatever format it is stored.
pub fn cover(path: &Path, extension: &str) -> Option<Vec<u8>> {
    let mut archive = open(path)?;
    let name = match extension {
        "epub" => epub_cover(&mut archive)?,
        "cbz" => comic_pages(&archive).into_iter().next()?,
        _ => return None,
    };
    read(&mut archive, &name)
}

fn open(path: &Path) -> Option<Archive> {
    match ZipArchive::new(File::open(path).ok()?) {
        Ok(archive) => Some(archive),
        Err(err) => {
            eprintln!("could not read {} as a zip: {err}", path.display());
            None
        }
    }
}

fn read(archive: &mut Archive, name: &str) -> Option<Vec<u8>> {
    let member = archive.by_name(name).ok()?;
    let mut data = Vec::new();
    member.take(MAX_MEMBER).read_to_end(&mut data).ok()?;
    Some(data)
}

fn read_text(archive: &mut Archive, name: &str) -> Option<String> {
    read(archive, name).map(|data| String::from_utf8_lossy(&data).into_owned())
}

// Comic archives: every image is a page, in name order.

fn extension_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

fn comic_pages(archive: &Archive) -> Vec<String> {
    let mut names: Vec<String> = archive
        .file_names()
        .filter(|name| IMAGE_EXTENSIONS.contains(&extension_of(name).as_str()))
        // Finder's resource forks and other hidden files are not pages.
        .filter(|name| {
            !name
                .split('/')
                .any(|part| part.starts_with('.') || part == "__MACOSX")
        })
        .map(str::to_string)
        .collect();
    names.sort_by(|a, b| natural(a, b));
    names
}

/// Orders names the way a person would: `page2` before `page10`.
fn natural(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut a, mut b) = (a.as_str(), b.as_str());
    loop {
        let digits = |s: &str| s.len() - s.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        let (da, db) = (digits(a), digits(b));
        if da > 0 && db > 0 {
            let (na, nb) = (
                a[..da].trim_start_matches('0'),
                b[..db].trim_start_matches('0'),
            );
            let order = na.len().cmp(&nb.len()).then_with(|| na.cmp(nb));
            if order != Ordering::Equal {
                return order;
            }
            (a, b) = (&a[da..], &b[db..]);
            continue;
        }
        match (a.chars().next(), b.chars().next()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(ca), Some(cb)) if ca != cb => return ca.cmp(&cb),
            (Some(ca), _) => (a, b) = (&a[ca.len_utf8()..], &b[ca.len_utf8()..]),
        }
    }
}

// EPUB: a package document lists the book's files (the manifest) and their
// reading order (the spine).

/// A start tag: its name without namespace prefix, and where it begins.
struct Element {
    name: String,
    attributes: Vec<(String, String)>,
    start: usize,
}

impl Element {
    fn get(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// The start tags of an XML document, in order. Just enough of a parser for
/// the well-formed, machine-written files inside an EPUB.
fn elements(xml: &str) -> Vec<Element> {
    let bytes = xml.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while let Some(offset) = xml[i..].find('<') {
        let start = i + offset;
        i = start + 1;
        if xml[i..].starts_with("!--") {
            i = xml[i..].find("-->").map_or(xml.len(), |end| i + end + 3);
            continue;
        }
        if matches!(bytes.get(i), None | Some(b'/' | b'!' | b'?')) {
            continue;
        }
        let name_end = xml[i..]
            .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
            .map_or(xml.len(), |end| i + end);
        let name = &xml[i..name_end];
        let name = name.rsplit(':').next().unwrap_or(name).to_string();
        i = name_end;

        let mut attributes = Vec::new();
        loop {
            i += xml[i..].len() - xml[i..].trim_start().len();
            let rest = &xml[i..];
            if rest.is_empty() || rest.starts_with('>') || rest.starts_with("/>") {
                break;
            }
            let Some(equals) = rest
                .find(['=', '>'])
                .filter(|&at| rest.as_bytes()[at] == b'=')
            else {
                break;
            };
            let key = rest[..equals].trim().to_string();
            let value = rest[equals + 1..].trim_start();
            let Some(quote) = value.chars().next().filter(|c| *c == '"' || *c == '\'') else {
                break;
            };
            let Some(length) = value[1..].find(quote) else {
                break;
            };
            attributes.push((key, unescape(&value[1..1 + length])));
            i = xml.len() - value.len() + length + 2;
        }
        found.push(Element {
            name,
            attributes,
            start,
        });
    }
    found
}

fn unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

struct Item {
    id: String,
    /// Name of the file inside the archive.
    path: String,
    media_type: String,
    properties: String,
}

struct Package {
    manifest: Vec<Item>,
    /// Indices into `manifest`, in reading order.
    spine: Vec<usize>,
    /// EPUB 2's way of naming the cover: the ID of a manifest item.
    cover_id: Option<String>,
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|pair| std::str::from_utf8(pair).ok());
        match hex.and_then(|pair| u8::from_str_radix(pair, 16).ok()) {
            Some(byte) if bytes[i] == b'%' => {
                decoded.push(byte);
                i += 3;
            }
            _ => {
                decoded.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// Resolves a link found in the file `from` to a name inside the archive.
fn resolve(from: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or("");
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    let decoded = percent_decode(href);
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}

fn package(archive: &mut Archive) -> Option<Package> {
    let container = read_text(archive, "META-INF/container.xml")?;
    let opf_path = elements(&container)
        .iter()
        .find(|element| element.name == "rootfile")?
        .get("full-path")?
        .to_string();
    let opf = read_text(archive, &opf_path)?;

    let mut package = Package {
        manifest: Vec::new(),
        spine: Vec::new(),
        cover_id: None,
    };
    let mut spine_ids = Vec::new();
    for element in elements(&opf) {
        match element.name.as_str() {
            "item" => {
                if let (Some(id), Some(href)) = (element.get("id"), element.get("href")) {
                    package.manifest.push(Item {
                        id: id.to_string(),
                        path: resolve(&opf_path, href),
                        media_type: element.get("media-type").unwrap_or("").to_string(),
                        properties: element.get("properties").unwrap_or("").to_string(),
                    });
                }
            }
            "itemref" => spine_ids.extend(element.get("idref").map(str::to_string)),
            "meta" if element.get("name") == Some("cover") => {
                package.cover_id = element.get("content").map(str::to_string);
            }
            _ => {}
        }
    }
    package.spine = spine_ids
        .iter()
        .filter_map(|id| package.manifest.iter().position(|item| &item.id == id))
        .collect();
    Some(package)
}

fn has_property(item: &Item, property: &str) -> bool {
    item.properties.split_whitespace().any(|p| p == property)
}

fn epub_cover(archive: &mut Archive) -> Option<String> {
    let package = package(archive)?;
    let images = || {
        package
            .manifest
            .iter()
            .filter(|item| item.media_type.starts_with("image/"))
    };
    let named_cover = |item: &&Item| {
        item.id.to_lowercase().contains("cover") || item.path.to_lowercase().contains("cover")
    };
    images()
        .find(|item| has_property(item, "cover-image"))
        .or_else(|| images().find(|item| Some(&item.id) == package.cover_id.as_ref()))
        // Not declared: go by the name.
        .or_else(|| images().find(named_cover))
        .map(|item| item.path.clone())
}

fn epub_pages(archive: &mut Archive) -> Option<u64> {
    let package = package(archive)?;
    let marked = marked_pages(archive, &package);
    if marked > 0 {
        return Some(marked);
    }
    let mut characters = 0;
    for &index in &package.spine {
        if let Some(text) = read_text(archive, &package.manifest[index].path) {
            characters += text_length(&text);
        }
    }
    Some(characters.div_ceil(CHARS_PER_PAGE))
}

/// Number of print pages the book marks in its navigation, if it does: the
/// page list of an EPUB 3 navigation document or of an EPUB 2 NCX.
fn marked_pages(archive: &mut Archive, package: &Package) -> u64 {
    let nav = package
        .manifest
        .iter()
        .find(|item| has_property(item, "nav"));
    if let Some(text) = nav.and_then(|item| read_text(archive, &item.path)) {
        let tags = elements(&text);
        let list = tags.iter().find(|tag| {
            tag.name == "nav"
                && tag
                    .get("epub:type")
                    .is_some_and(|kinds| kinds.split(' ').any(|k| k == "page-list"))
        });
        if let Some(list) = list {
            let end = text[list.start..]
                .find("</nav")
                .map_or(text.len(), |at| list.start + at);
            let links = tags
                .iter()
                .filter(|tag| tag.name == "a" && (list.start..end).contains(&tag.start));
            return links.count() as u64;
        }
    }
    let ncx = package
        .manifest
        .iter()
        .find(|item| item.media_type == "application/x-dtbncx+xml");
    if let Some(text) = ncx.and_then(|item| read_text(archive, &item.path)) {
        return elements(&text)
            .iter()
            .filter(|tag| tag.name == "pageTarget")
            .count() as u64;
    }
    0
}

/// Characters of text in the body of an XHTML document, with runs of
/// whitespace counted once.
fn text_length(xhtml: &str) -> u64 {
    let body = xhtml.find("<body").map_or(xhtml, |at| &xhtml[at..]);
    let mut count = 0;
    let mut in_tag = false;
    let mut after_space = true;
    for c in body.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if in_tag => {}
            c if c.is_whitespace() => {
                if !after_space {
                    count += 1;
                }
                after_space = true;
            }
            _ => {
                count += 1;
                after_space = false;
            }
        }
    }
    count
}
