//! Classifying stored files, reading their attributes and making thumbnails
//! with external tools (`file`, ImageMagick, ffmpeg, poppler). A missing or
//! failing tool is logged and leaves the attribute unset; it never fails the
//! upload. EPUB and CBZ archives are read directly, in `book`.

use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use serde_json::Value;
use tokio::process::Command;

use crate::book;

/// Book formats `file` reports as a generic archive or not at all.
const BOOK_EXTENSIONS: &[&str] = &["pdf", "epub", "mobi", "azw3", "djvu", "cbz", "cbr", "cb7"];

/// Books that are zip archives, read by `book`.
const ARCHIVE_BOOKS: &[&str] = &["epub", "cbz"];

/// Longest side of a thumbnail, in pixels.
const THUMBNAIL_SIZE: u32 = 400;

#[derive(Default)]
pub struct Attributes {
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// In seconds.
    pub length: Option<f64>,
    pub page_count: Option<i64>,
}

/// Runs a tool and returns its stdout. `quiet` suppresses the log line for a
/// non-zero exit, for commands that are expected to fail on some inputs.
async fn run<S: AsRef<OsStr>>(program: &str, args: &[S], quiet: bool) -> Option<String> {
    match Command::new(program).args(args).output().await {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(output) => {
            if !quiet {
                let stderr = String::from_utf8_lossy(&output.stderr);
                eprintln!("{program} failed: {}", stderr.trim());
            }
            None
        }
        Err(err) => {
            eprintln!("could not run {program}: {err}");
            None
        }
    }
}

fn os(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

/// One of the `media_type` values the database accepts.
pub async fn media_type(path: &Path, extension: &str) -> &'static str {
    if BOOK_EXTENSIONS.contains(&extension) {
        return "book";
    }
    let mut args = os(&["--brief", "--mime-type"]);
    args.push(path.into());
    let Some(mime) = run("file", &args, false).await else {
        return "other";
    };
    match mime.trim() {
        "application/pdf" | "application/epub+zip" | "image/vnd.djvu" => "book",
        "application/ogg" => "audio",
        mime if mime.starts_with("image/") => "image",
        mime if mime.starts_with("video/") => "video",
        mime if mime.starts_with("audio/") => "audio",
        _ => "other",
    }
}

pub async fn probe(path: &Path, media_type: &str, extension: &str) -> Attributes {
    match media_type {
        "image" => probe_image(path).await,
        "video" => probe_av(path).await,
        // An audio file's video stream is its cover art, not its dimensions.
        "audio" => Attributes {
            length: probe_av(path).await.length,
            ..Attributes::default()
        },
        "book" if extension == "pdf" => Attributes {
            page_count: pdf_pages(path).await,
            ..Attributes::default()
        },
        "book" if ARCHIVE_BOOKS.contains(&extension) => Attributes {
            page_count: in_archive(path, extension, book::pages).await,
            ..Attributes::default()
        },
        _ => Attributes::default(),
    }
}

/// Runs one of the blocking `book` functions off the async threads.
async fn in_archive<T: Send + 'static>(
    path: &Path,
    extension: &str,
    read: fn(&Path, &str) -> Option<T>,
) -> Option<T> {
    let (path, extension): (PathBuf, String) = (path.into(), extension.into());
    tokio::task::spawn_blocking(move || read(&path, &extension))
        .await
        .ok()
        .flatten()
}

/// Thumbnail of an image file. [0] takes the first frame of animations and
/// multi-page images.
async fn image_thumbnail(source: &Path, dest: &Path) {
    let size = THUMBNAIL_SIZE;
    let mut first_frame = source.as_os_str().to_owned();
    first_frame.push("[0]");
    let mut output = OsString::from("jpeg:");
    output.push(dest);
    let mut args = vec![first_frame];
    // ">" only ever shrinks. Transparency is flattened onto white.
    args.extend(os(&[
        "-auto-orient",
        "-thumbnail",
        &format!("{size}x{size}>"),
        "-background",
        "white",
        "-alpha",
        "remove",
        "-alpha",
        "off",
        "-strip",
        "-quality",
        "82",
    ]));
    args.push(output);
    run("magick", &args, false).await;
}

async fn probe_image(path: &Path) -> Attributes {
    let mut args = os(&["identify", "-ping", "-format", "%w %h\n"]);
    args.push(path.into());
    let Some(output) = run("magick", &args, false).await else {
        return Attributes::default();
    };
    // One line per frame; the first frame gives the dimensions.
    let mut numbers = output
        .lines()
        .next()
        .unwrap_or("")
        .split(' ')
        .map(|n| n.parse::<i64>().ok().filter(|n| *n > 0));
    Attributes {
        width: numbers.next().flatten(),
        height: numbers.next().flatten(),
        ..Attributes::default()
    }
}

async fn probe_av(path: &Path) -> Attributes {
    let mut args = os(&[
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
    ]);
    args.push(path.into());
    let Some(output) = run("ffprobe", &args, false).await else {
        return Attributes::default();
    };
    let Ok(info) = serde_json::from_str::<Value>(&output) else {
        return Attributes::default();
    };
    let stream = &info["streams"][0];
    Attributes {
        width: stream["width"].as_i64().filter(|n| *n > 0),
        height: stream["height"].as_i64().filter(|n| *n > 0),
        // ffprobe prints the duration as a string.
        length: info["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| *n >= 0.0),
        ..Attributes::default()
    }
}

async fn pdf_pages(path: &Path) -> Option<i64> {
    let output = run("pdfinfo", &[path], false).await?;
    output
        .lines()
        .find_map(|line| line.strip_prefix("Pages:"))
        .and_then(|pages| pages.trim().parse::<i64>().ok())
        .filter(|n| *n > 0)
}

/// Writes a JPEG thumbnail of `source` to `dest`. Returns whether one was
/// made; many files (text, audio without cover art, most e-book formats) have none.
pub async fn thumbnail(
    source: &Path,
    media_type: &str,
    extension: &str,
    length: Option<f64>,
    dest: &Path,
) -> bool {
    let size = THUMBNAIL_SIZE;
    // min() keeps small sources at their own size instead of enlarging them.
    let scale =
        format!("scale='min({size},iw)':'min({size},ih)':force_original_aspect_ratio=decrease");
    match media_type {
        "image" => image_thumbnail(source, dest).await,
        "video" => {
            // A little way in, to skip black lead-in frames.
            let offset = length.map_or(0.0, |length| (length * 0.1).min(10.0));
            let mut args = os(&["-v", "error", "-y", "-ss", &format!("{offset:.3}"), "-i"]);
            args.push(source.into());
            args.extend(os(&[
                "-frames:v",
                "1",
                "-vf",
                &scale,
                "-f",
                "image2",
                "-update",
                "1",
                "-q:v",
                "4",
            ]));
            args.push(dest.into());
            run("ffmpeg", &args, false).await;
        }
        "audio" => {
            // Embedded cover art, if any; most files have none.
            let mut args = os(&["-v", "error", "-y", "-i"]);
            args.push(source.into());
            args.extend(os(&[
                "-an",
                "-frames:v",
                "1",
                "-vf",
                &scale,
                "-f",
                "image2",
                "-update",
                "1",
                "-q:v",
                "4",
            ]));
            args.push(dest.into());
            run("ffmpeg", &args, true).await;
        }
        "book" if extension == "pdf" => {
            // pdftoppm appends ".jpg" to the prefix it is given.
            let mut args = os(&["-f", "1", "-l", "1", "-singlefile", "-jpeg", "-scale-to"]);
            args.push(size.to_string().into());
            args.push(source.into());
            args.push(dest.with_extension("").into());
            run("pdftoppm", &args, false).await;
        }
        "book" if ARCHIVE_BOOKS.contains(&extension) => {
            // The cover goes through a file, for ImageMagick to read.
            if let Some(cover) = in_archive(source, extension, book::cover).await {
                let extracted = dest.with_extension("cover");
                if tokio::fs::write(&extracted, cover).await.is_ok() {
                    image_thumbnail(&extracted, dest).await;
                }
                let _ = tokio::fs::remove_file(&extracted).await;
            }
        }
        _ => return false,
    }
    let made = std::fs::metadata(dest).is_ok_and(|meta| meta.len() > 0);
    if !made {
        let _ = std::fs::remove_file(dest);
    }
    made
}
