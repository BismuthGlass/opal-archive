#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "yt-dlp"]
# ///
"""The Reddit downloader for OpalArchive. See ../README.md for the protocol.

    reddit.py cookies --browser chrome --out FILE
    reddit.py cookies --file cookies.txt --out FILE
    reddit.py download < request.json

It takes a post URL and downloads the post's image, video or gallery. A post
of several files becomes a set. Each file is tagged with its poster, as the
source `reddit:<username>`. A crosspost is downloaded as the post it points
to. Public posts need no login; private and quarantined subreddits do.

A post that links to a site another downloader takes, as Redgifs, is not
fetched here: the address is handed over to that downloader, whose files
then have what it gives them as well as what this one does.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import requests

SITE = "https://www.reddit.com"
POST = SITE + "/comments/{id}/"
# Reddit keeps every upload under its ID here, whatever preview it shows.
ORIGINAL = "https://i.redd.it/{name}"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
}
IMAGE = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"}
VIDEO = {".mp4", ".webm", ".mov", ".m4v"}
RETRY_STATUS = {429, 500, 502, 503, 504}
# Files of a gallery fetched at once.
JOBS = 4

session = requests.Session()
session.headers.update(HEADERS)


def emit(event: str, **fields) -> None:
    """Tells the server something, as one line of JSON."""
    try:
        print(json.dumps({"event": event, **fields}), flush=True)
    except BrokenPipeError:
        # The server has gone, or cancelled the download.
        os._exit(1)


def get(url: str, **kwargs) -> requests.Response:
    """GET with retries on rate limiting and transient errors."""
    for attempt in range(6):
        try:
            r = session.get(url, timeout=60, **kwargs)
            if r.status_code not in RETRY_STATUS:
                return r
            err = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            err = str(e)
        if attempt == 5:
            raise RuntimeError(f"{url}: {err}")
        time.sleep(2**attempt)
    raise AssertionError


# --- reading the post --------------------------------------------------------


def logged_in() -> bool:
    return bool(session.cookies.get("reddit_session", domain=".reddit.com"))


def post_id(url: str) -> str:
    """The ID of the post a URL names."""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.hostname or "").lower()
    if host == "redd.it":
        # The short form: redd.it/1wy568f.
        match = re.match(r"^/([a-z0-9]+)/?$", parsed.path)
    elif host == "reddit.com" or host.endswith((".reddit.com", ".redd.it")):
        match = re.search(r"/(?:comments|gallery)/([a-z0-9]+)", parsed.path)
        if not match and (host == "v.redd.it" or re.search(r"/s/\w+", parsed.path)):
            # A video's own address and a share link both lead on to the post.
            led = get(parsed.geturl()).url
            match = re.search(r"/(?:comments|gallery)/([a-z0-9]+)", urlparse(led).path)
    else:
        raise RuntimeError("that is not a Reddit address")
    if not match:
        raise RuntimeError("that is not a post address")
    return match.group(1)


def ask_for_post(id: str) -> requests.Response:
    # Asked this way, Reddit hands a visitor the cookies its API wants of one.
    if not logged_in():
        get(f"{SITE}/svc/shreddit/comments/{id}", params={"seeker-session": "false", "render-mode": "partial"})
    return get(POST.format(id=id) + ".json", params={"raw_json": 1, "limit": 1})


def read_post(id: str) -> dict:
    r = ask_for_post(id)
    # Now and then Reddit turns a visitor away for no reason it gives, and
    # lets the same one in a moment later.
    for wait in (2, 5):
        if r.status_code != 403 or logged_in() or "json" in r.headers.get("Content-Type", ""):
            break
        time.sleep(wait)
        r = ask_for_post(id)
    try:
        data = r.json()
    except ValueError:
        if r.status_code == 404:
            raise RuntimeError("there is no such post")
        if logged_in():
            raise RuntimeError(f"Reddit would not show the post (HTTP {r.status_code})")
        raise RuntimeError(f"Reddit would not show the post (HTTP {r.status_code}): try logging in")
    if isinstance(data, dict):
        reason = data.get("reason") or data.get("message") or f"HTTP {r.status_code}"
        if r.status_code == 404:
            raise RuntimeError("there is no such post")
        if reason in ("private", "quarantined", "gated"):
            raise RuntimeError(f"the subreddit is {reason}: log in with an account that can read it")
        raise RuntimeError(f"Reddit would not show the post: {reason}")
    return data[0]["data"]["children"][0]["data"]


# --- media extraction --------------------------------------------------------
#
# A medium is a pair: how to get it, "file" for a plain download, "video"
# for one yt-dlp has to put together, or "delegate" for one that another
# downloader is to fetch, and its address.


def taken_by(host: str, sites: list[str]) -> bool:
    """Whether a host is of one of the sites other downloaders take.

    A site is a domain, standing for its subdomains too, or a name and
    `.*` for that name under any ending.
    """
    for site in sites:
        site = site.lower()
        if site.endswith(".*"):
            if site[:-2] in host.split("."):
                return True
        elif host == site or host.endswith(f".{site}"):
            return True
    return False


def extension(url: str) -> str:
    return Path(urlparse(url).path).suffix.lower()


def uploaded(media_id: str, meta: dict) -> tuple[str, str]:
    """One upload of a gallery, or of a text post that shows it inline."""
    if meta.get("status") != "valid":
        raise RuntimeError(f"Reddit has not kept one of the files ({meta.get('status')})")
    kind, full = meta.get("e"), meta.get("s") or {}
    if kind == "RedditVideo":
        return "video", meta["dashUrl"]
    if kind == "AnimatedImage":
        return "file", ORIGINAL.format(name=f"{media_id}.gif")
    # The address given is of a preview; the original has the same name.
    ext = extension(full.get("u") or "") or "." + (meta.get("m") or "image/jpg").split("/")[-1]
    return "file", ORIGINAL.format(name=f"{media_id}{ext}")


def media_of(post: dict, delegates: list[str]) -> list[tuple[str, str]]:
    """Everything a post shows, in display order."""
    metadata = post.get("media_metadata") or {}
    if post.get("gallery_data"):
        ids = [item["media_id"] for item in post["gallery_data"].get("items") or []]
        return [uploaded(i, metadata[i]) for i in ids if i in metadata]

    url = post.get("url_overridden_by_dest") or post.get("url") or ""
    host = (urlparse(url).hostname or "").lower()
    video = ((post.get("secure_media") or post.get("media") or {}).get("reddit_video")) or {}
    if video or host == "v.redd.it":
        address = video.get("dash_url") or f"{url.rstrip('/')}/DASHPlaylist.mpd"
        return [("video", address)]
    if host in ("i.redd.it", "preview.redd.it"):
        return [("file", ORIGINAL.format(name=Path(urlparse(url).path).name))]
    if post.get("is_self") or host.endswith("reddit.com"):
        # A text post; any pictures are in among its words.
        return [uploaded(i, meta) for i, meta in metadata.items()]
    # A site with a downloader of its own is that downloader's to fetch:
    # it knows what the site says of it, which is then kept too.
    if taken_by(host, delegates):
        return [("delegate", url)]
    if extension(url) in IMAGE | VIDEO:
        return [("file", url)]
    # Imgur's .gifv is a page around a video.
    if host.endswith("imgur.com") and extension(url) == ".gifv":
        return [("file", url[: -len(".gifv")] + ".mp4")]
    # Anything else is another site's page: yt-dlp knows the video sites.
    return [("video", url)]


# --- downloading -------------------------------------------------------------


class Quiet:
    """Keeps yt-dlp off standard output, which is the server's."""

    def debug(self, message):
        pass

    warning = error = debug


def fetch_file(url: str, dest: Path) -> str:
    r = get(url, stream=True, headers={"Accept": "image/*, video/*, */*;q=0.5"})
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    kind = r.headers.get("Content-Type", "").split(";")[0]
    if kind.startswith("text/"):
        raise RuntimeError("the file is gone")
    # i.redd.it serves some uploads as another format than they are named for.
    named = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "video/mp4": ".mp4"}
    dest = dest.with_suffix(named.get(kind) or extension(url) or ".jpg")
    part = dest.with_name(dest.name + ".part")
    with open(part, "wb") as f:
        for chunk in r.iter_content(1 << 16):
            f.write(chunk)
    part.rename(dest)
    return str(dest)


def fetch_video(url: str, dest: Path) -> str:
    from yt_dlp import YoutubeDL

    options = {
        "outtmpl": f"{dest}.%(ext)s",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        "logger": Quiet(),
    }
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as e:
        raise RuntimeError(re.sub(r"^ERROR: ", "", str(e))) from None
    # A page of several videos comes back as a list of them.
    for entry in info.get("entries") or [info]:
        for done in (entry or {}).get("requested_downloads") or []:
            return done["filepath"]
    raise RuntimeError("there was no video there")


def fetch_post(post: dict, media: list[tuple[str, str]], out: Path) -> list[str]:
    """Downloads a post's files into `out`, and returns their paths in order."""

    def work(numbered: tuple[int, tuple[str, str]]) -> str:
        i, (how, url) = numbered
        suffix = f"_{i:02d}" if len(media) > 1 else ""
        dest = out / f"{post['id']}{suffix}"
        return fetch_video(url, dest) if how == "video" else fetch_file(url, dest)

    with ThreadPoolExecutor(JOBS) as pool:
        return list(pool.map(work, enumerate(media, 1)))


def load_cookies(path: str | None) -> None:
    if path:
        jar = http.cookiejar.MozillaCookieJar(path)
        jar.load(ignore_discard=True, ignore_expires=True)
        session.cookies.update(jar)
    # Says yes to the question asked before an adult subreddit.
    session.cookies.set("over18", "1", domain=".reddit.com")


def download() -> int:
    request = json.load(sys.stdin)
    out = Path(request["out"])
    out.mkdir(parents=True, exist_ok=True)
    seen = set(request.get("seen") or [])
    load_cookies(request.get("cookies"))

    emit("log", message="Looking at the address")
    id = post_id(request["url"])
    key = POST.format(id=id)
    emit("found", total=1)
    if key in seen:
        emit("skipped", key=key)
        return 0

    emit("log", message="Reading the post")
    post = read_post(id)
    # A crosspost only points to another post, and that one is what is
    # downloaded: its files, under its own poster, address and ID.
    while post.get("crosspost_parent_list"):
        post = post["crosspost_parent_list"][0]
        id = post["id"]
    if POST.format(id=id) != key:
        key = POST.format(id=id)
        if key in seen:
            emit("skipped", key=key)
            return 0
    media = media_of(post, request.get("delegates") or [])
    if not media:
        raise RuntimeError("the post has nothing to download")
    emit("log", message="Downloading")
    handed = [url for how, url in media if how == "delegate"]
    files = fetch_post(post, [medium for medium in media if medium[0] != "delegate"], out)

    address = SITE + post["permalink"]
    title = (post.get("title") or "").strip()
    description = (post.get("selftext") or "").strip()
    # Deleted accounts and removed posts leave "[deleted]" for a name.
    author = post.get("author") or ""
    tags = {"source": [f"reddit:{author}"]} if author and not author.startswith("[") else {}
    whole = {}
    if len(files) > 1:
        # A post of several files becomes a set, named for the post.
        whole["collection"] = {
            "id": f"reddit:post:{id}",
            "type": "set",
            "url": address,
            "title": title,
            "description": description,
            "tags": tags,
        }
    emit(
        "item",
        key=key,
        source_url=address,
        files=files,
        delegate=handed,
        title=title,
        description=description,
        tags=tags,
        **whole,
    )
    return 0


def cookies(browser: str | None, file: str | None, out: str) -> int:
    """Saves the site's login: read from a browser, or out of a cookie file."""
    if file:
        found = http.cookiejar.MozillaCookieJar(file)
        found.load(ignore_discard=True, ignore_expires=True)
    else:
        from yt_dlp.cookies import extract_cookies_from_browser

        found = extract_cookies_from_browser(browser)

    # Only Reddit's cookies are kept.
    jar = http.cookiejar.MozillaCookieJar(out)
    count = 0
    logged_in = False
    for cookie in found:
        if cookie.domain.lstrip(".").endswith("reddit.com"):
            jar.set_cookie(cookie)
            count += 1
            logged_in = logged_in or (cookie.name == "reddit_session" and bool(cookie.value))
    if logged_in:
        # Readable by the user alone from the moment it exists.
        os.close(os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600))
        jar.save(ignore_discard=True, ignore_expires=True)
    print(json.dumps({"logged_in": logged_in, "count": count}), flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("download", help="download what the request on standard input asks for")
    get_cookies = sub.add_parser("cookies", help="save the Reddit login of a browser, or of a cookie file")
    source = get_cookies.add_mutually_exclusive_group(required=True)
    source.add_argument("--browser")
    source.add_argument("--file")
    get_cookies.add_argument("--out", required=True)
    args = ap.parse_args()
    try:
        if args.command == "cookies":
            return cookies(args.browser, args.file, args.out)
        return download()
    except Exception as e:
        # The last line of standard error is what the user is shown.
        print(str(e) or type(e).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
