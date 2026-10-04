#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///
"""The 4chan downloader for tagutils. See ../README.md for the protocol.

    4chan.py download < request.json

It takes a thread URL and downloads the files posted in it, into a collection
named for the thread, through 4chan's
read-only JSON API (https://github.com/4chan/4chan-API). A thread still on
the board or in its archive can be read; one that has been pruned is gone.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import requests

API = "https://a.4cdn.org/{board}/thread/{thread}.json"
FILES = "https://i.4cdn.org/{board}/{tim}{ext}"
THREAD = "https://boards.4chan.org/{board}/thread/{thread}"
POST = THREAD + "#p{no}"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
}
HOSTS = ("4chan.org", "4channel.org")
VIDEO = {".webm", ".mp4"}
RETRY_STATUS = {429, 500, 502, 503, 504}
# Files fetched at once. 4chan asks its readers to go easy.
JOBS = 2

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


def thread_of(url: str) -> tuple[str, str]:
    """The board and thread number a URL names."""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.hostname or "").lower()
    if not any(host == known or host.endswith(f".{known}") for known in HOSTS):
        raise RuntimeError("that is not a 4chan address")
    # /g/thread/109956993, with or without the thread's name after it.
    match = re.match(r"^/(\w+)/thread/(\d+)", parsed.path)
    if not match:
        raise RuntimeError("that is not a thread address")
    return match.group(1), match.group(2)


def posts_of(board: str, thread: str) -> list[dict]:
    r = get(API.format(board=board, thread=thread))
    if r.status_code == 404:
        raise RuntimeError("there is no such thread: it may have been pruned")
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code} reading the thread")
    return r.json()["posts"]


def text_of(comment: str) -> str:
    """A post's comment as plain text."""
    text = re.sub(r"<br\s*/?>", "\n", comment)
    # <wbr> only says where a long word may break.
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def file_name(post: dict) -> str:
    """The name the file was posted under, made safe to store."""
    name = re.sub(r'[\x00-\x1f/\\:*?"<>|]', "_", post.get("filename") or "").strip(" .")
    return f"{name or post['tim']}{post['ext']}"


def fetch(board: str, post: dict, out: Path) -> str:
    """Downloads a post's file into a folder of its own, and returns its path.

    Two posts can carry files of the same name, so each gets a folder.
    """
    folder = out / str(post["no"])
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / file_name(post)
    part = dest.with_name(dest.name + ".part")
    r = get(FILES.format(board=board, tim=post["tim"], ext=post["ext"]), stream=True)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    digest = hashlib.md5()
    with open(part, "wb") as f:
        for chunk in r.iter_content(1 << 16):
            digest.update(chunk)
            f.write(chunk)
    # 4chan says what each file hashes to; a download cut short does not match.
    if post.get("md5") and base64.b64encode(digest.digest()).decode() != post["md5"]:
        part.unlink()
        raise RuntimeError("the file arrived damaged")
    part.rename(dest)
    return str(dest)


def download() -> int:
    request = json.load(sys.stdin)
    options = request.get("options") or {}
    out = Path(request["out"])
    out.mkdir(parents=True, exist_ok=True)
    seen = set(request.get("seen") or [])

    emit("log", message="Reading the thread")
    board, thread = thread_of(request["url"])
    posts = [
        post
        for post in posts_of(board, thread)
        if post.get("tim") and post.get("ext") and not post.get("filedeleted")
    ]
    if not options.get("video", True):
        posts = [post for post in posts if post["ext"].lower() not in VIDEO]
    emit("found", total=len(posts))
    emit("log", message="Downloading")

    def post_url(post: dict) -> str:
        return POST.format(board=board, thread=thread, no=post["no"])

    # The thread becomes a collection holding its files, in the order posted.
    whole = {}
    if options.get("collection", True):
        address = THREAD.format(board=board, thread=thread)
        whole = {
            "collection": {"type": "sourceset", "url": address, "title": f"4chan#{thread}"}
        }

    todo = []
    for post in posts:
        if post_url(post) in seen:
            emit("skipped", key=post_url(post))
        else:
            todo.append(post)

    def work(post: dict):
        try:
            return post, fetch(board, post, out), None
        except Exception as e:  # keep going; the server is told
            return post, None, str(e)

    with ThreadPoolExecutor(JOBS) as pool:
        for post, file, err in pool.map(work, todo):
            key = post_url(post)
            if err:
                emit("error", key=key, message=f"{key}: {err}")
                continue
            comment = text_of(post.get("com") or "") if options.get("comments") else ""
            emit("item", key=key, source_url=key, files=[file], description=comment, **whole)
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
