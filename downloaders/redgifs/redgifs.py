#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///
"""The Redgifs downloader for OpalArchive. See ../README.md for the protocol.

    redgifs.py download < request.json

It takes the address of a video's page (`/watch/<name>`, or `/ifr/<name>` as
it is embedded) and downloads the video, at its best quality, through
Redgifs' own API. It also takes the address of the video file itself, which
names the video, and downloads that video the same way; and a user's page
(`/users/<name>`), which stands for everything the user has posted.

Each file is tagged with its poster, as the source `redgifs:<username>`. A
post of several pictures becomes a set. No login is needed: the API hands a
visitor a pass that lasts the download.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import requests

API = "https://api.redgifs.com/v2"
WATCH = "https://www.redgifs.com/watch/{id}"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
}
RETRY_STATUS = {429, 500, 502, 503, 504}
# Videos fetched at once, and listed at once from a user's page.
JOBS = 3
PAGE = 80

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


def log_in() -> None:
    """Takes the pass the API hands a visitor, which every other call needs.

    It is good for this address and this browser's name alone, which is why
    the files are fetched with the same session.
    """
    r = get(f"{API}/auth/temporary")
    if r.status_code != 200:
        raise RuntimeError(f"Redgifs would not let a visitor in (HTTP {r.status_code})")
    session.headers["Authorization"] = f"Bearer {r.json()['token']}"


def call(path: str, missing: str, **params) -> dict:
    r = get(f"{API}/{path}", params=params)
    if r.status_code in (404, 410):
        raise RuntimeError(missing)
    if r.status_code != 200:
        try:
            reason = r.json()["error"]["description"]
        except (ValueError, KeyError, TypeError):
            reason = f"HTTP {r.status_code}"
        raise RuntimeError(f"Redgifs would not show it: {reason}")
    return r.json()


def target(url: str) -> tuple[str, str]:
    """What an address names: a `video` and its name, or a `user` and theirs."""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.hostname or "").lower()
    if not (host == "redgifs.com" or host.endswith(".redgifs.com")):
        raise RuntimeError("that is not a Redgifs address")
    parts = [part for part in parsed.path.split("/") if part]
    # /watch/name, and /ifr/name as it is embedded in other pages.
    if len(parts) >= 2 and parts[0] in ("watch", "ifr"):
        return "video", parts[1].lower()
    if len(parts) >= 2 and parts[0] == "users":
        return "user", parts[1].lower()
    # A file's own address: /NameOfTheVideo.mp4, or -mobile.mp4, -poster.jpg
    # and the like for its other forms. The name is the video's, in capitals.
    if len(parts) == 1 and Path(parts[0]).suffix:
        return "video", re.split(r"[-.]", parts[0])[0].lower()
    raise RuntimeError("that is not a video's address, or a user's")


def videos_of(user: str) -> list[dict]:
    """Everything a user has posted, newest first."""
    found: list[dict] = []
    page = 1
    while True:
        listed = call(
            f"users/{user}/search", "there is no such user", order="new", count=PAGE, page=page
        )
        found += listed.get("gifs") or []
        emit("found", total=len(found))
        if page >= (listed.get("pages") or 1) or not listed.get("gifs"):
            return found
        page += 1


def parts_of(video: dict) -> list[dict]:
    """What a post is made of: itself, or each picture of a post of several."""
    if not video.get("gallery"):
        return [video]
    gallery = call(f"gallery/{video['gallery']}", "the pictures of that post are gone")
    return gallery.get("gifs") or [video]


def fetch(video: dict, out: Path) -> str:
    """Downloads a video, or a picture, at its best quality, and returns its path."""
    urls = video.get("urls") or {}
    url = urls.get("hd") or urls.get("sd")
    if not url:
        raise RuntimeError("Redgifs gave no file for it")
    ext = Path(urlparse(url).path).suffix.lower() or ".mp4"
    dest = out / f"{video['id']}{ext}"
    part = dest.with_name(dest.name + ".part")
    r = get(url, stream=True)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    with open(part, "wb") as f:
        for chunk in r.iter_content(1 << 16):
            f.write(chunk)
    part.rename(dest)
    return str(dest)


def download() -> int:
    request = json.load(sys.stdin)
    out = Path(request["out"])
    out.mkdir(parents=True, exist_ok=True)
    seen = set(request.get("seen") or [])

    kind, name = target(request["url"])
    emit("log", message="Looking at the address")
    log_in()
    if kind == "user":
        videos = videos_of(name)
    else:
        videos = [call(f"gifs/{name}", "there is no such video")["gif"]]
    # The pictures of one post are each listed, and are one post.
    posts = list({video.get("gallery") or video["id"]: video for video in videos}.values())
    emit("found", total=len(posts))
    emit("log", message="Downloading")

    def key_of(video: dict) -> str:
        return WATCH.format(id=video["id"])

    todo = []
    for video in posts:
        if key_of(video) in seen:
            emit("skipped", key=key_of(video))
        else:
            todo.append(video)

    def work(video: dict):
        try:
            return video, [fetch(part, out) for part in parts_of(video)], None
        except Exception as e:  # keep going; the server is told
            return video, [], str(e)

    with ThreadPoolExecutor(JOBS) as pool:
        for video, files, err in pool.map(work, todo):
            key = key_of(video)
            if err:
                emit("error", key=key, message=f"{key}: {err}")
                continue
            poster = video.get("userName") or ""
            tags = {"source": [f"redgifs:{poster}"]} if poster else {}
            description = (video.get("description") or "").strip()
            whole = {}
            if len(files) > 1:
                # A post of several pictures becomes a set.
                whole["collection"] = {
                    "id": f"redgifs:gallery:{video['gallery']}",
                    "type": "set",
                    "url": key,
                    "description": description,
                    "tags": tags,
                }
            emit(
                "item",
                key=key,
                source_url=key,
                files=files,
                description=description,
                tags=tags,
                **whole,
            )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("download", help="download what the request on standard input asks for")
    ap.parse_args()
    try:
        return download()
    except Exception as e:
        # The last line of standard error is what the user is shown.
        print(str(e) or type(e).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
