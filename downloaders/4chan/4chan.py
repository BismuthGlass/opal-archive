#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///
"""The 4chan downloader for OpalArchive. See ../README.md for the protocol.

    4chan.py download < request.json

It takes a thread URL and downloads the files posted in it, through 4chan's
read-only JSON API (https://github.com/4chan/4chan-API). A thread still on
the board or in its archive can be read; one that has been pruned is gone.
The files are not put in a set: each is given its thread as its
collection, `4chan:<board>:<thread>`, by which the files of a thread are
found.

A post may also link to a file kept somewhere else, as on catbox, where what
4chan will not take is put. Those are downloaded too, into the thread's
collection like the rest, each with two source URLs: its own address and its
post's.

It also takes the address of one post, a thread URL ending in `#p` and the
post's number, and downloads that post's file alone, with its thread as its
collection all the same; and the address of a file itself, which it
downloads as it is, with no collection: it does not say what thread it is of.
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
# Where the files themselves are served from.
FILE_HOSTS = ("4cdn.org", "4chan.org")
# Where else a post's files may be kept, and linked to from its comment.
LINKED_HOSTS = ("catbox.moe", "lain.la", "uguu.se")
# An address in a comment, with or without its scheme.
LINK = re.compile(r"(?:https?://)?((?:[\w-]+\.)+[a-z]{2,})(/[^\s<>\"']*)", re.I)
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


def on(host: str, known: tuple[str, ...]) -> bool:
    return any(host == name or host.endswith(f".{name}") for name in known)


def file_of(url: str) -> str | None:
    """The address of the file a URL names, if it is a file's own address."""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.hostname or "").lower()
    # /g/1717171717171717.jpg: the board, and the number the file was given.
    if on(host, FILE_HOSTS) and re.match(r"^/\w+/\d+\.\w+$", parsed.path):
        return f"https://{host}{parsed.path}"
    return None


def thread_of(url: str) -> tuple[str, str, int | None]:
    """The board and thread number a URL names, and the post if it names one."""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.hostname or "").lower()
    if not on(host, HOSTS):
        raise RuntimeError("that is not a 4chan address")
    # /g/thread/109956993, with or without the thread's name after it.
    match = re.match(r"^/(\w+)/thread/(\d+)", parsed.path)
    if not match:
        raise RuntimeError("that is not a thread, post or file address")
    # A post's address ends in #p and its number; a reply to it, in #q.
    post = re.match(r"^[pq](\d+)$", parsed.fragment)
    return match.group(1), match.group(2), int(post.group(1)) if post else None


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


def linked_of(post: dict) -> list[str]:
    """The files a post's comment links to on the hosts that keep them."""
    found = []
    for host, path in LINK.findall(text_of(post.get("com") or "")):
        # What ends a sentence or a bracket is not part of the address.
        path = path.split("?")[0].split("#")[0].rstrip(".,;:!)]}")
        # Only a file's own address: a name and what kind of file it is.
        if on(host.lower(), LINKED_HOSTS) and re.search(r"/[^/]+\.\w{2,5}$", path):
            url = f"https://{host.lower()}{path}"
            if url not in found:
                found.append(url)
    return found


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


def fetch_file(url: str, out: Path) -> str:
    """Downloads a file by its own address, and returns its path."""
    dest = out / Path(urlparse(url).path).name
    part = dest.with_name(dest.name + ".part")
    r = get(url, stream=True)
    if r.status_code == 404:
        raise RuntimeError("there is no such file: it may have been removed")
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    out.mkdir(parents=True, exist_ok=True)
    with open(part, "wb") as f:
        for chunk in r.iter_content(1 << 16):
            f.write(chunk)
    part.rename(dest)
    return str(dest)


def download() -> int:
    request = json.load(sys.stdin)
    options = request.get("options") or {}
    out = Path(request["out"])
    out.mkdir(parents=True, exist_ok=True)
    seen = set(request.get("seen") or [])

    # A file's own address says nothing of its post or thread: it is
    # downloaded as it is, and known by that address.
    file = file_of(request["url"])
    if file:
        emit("found", total=1)
        if file in seen:
            emit("skipped", key=file)
        else:
            emit("log", message="Downloading")
            emit("item", key=file, source_url=file, files=[fetch_file(file, out)])
        return 0

    emit("log", message="Reading the thread")
    board, thread, only = thread_of(request["url"])
    posts = posts_of(board, thread)
    if only is not None:
        posts = [post for post in posts if post["no"] == only]
        if not posts:
            raise RuntimeError(f"there is no post {only} in that thread: it may have been deleted")

    def post_url(post: dict) -> str:
        return POST.format(board=board, thread=thread, no=post["no"])

    # What there is to fetch: each post's own file, known by the post's
    # address, and each file a post links to, known by its own. A file
    # linked to in several posts is the first one's.
    things = []
    linked = set()
    for post in posts:
        if post.get("tim") and post.get("ext") and not post.get("filedeleted"):
            things.append((post_url(post), post, None))
        for n, url in enumerate(linked_of(post)):
            if url not in linked:
                linked.add(url)
                things.append((url, post, n))
    if only is not None and not things:
        raise RuntimeError("that post has no file")
    emit("found", total=len(things))
    emit("log", message="Downloading")

    # Each file says which thread it is of, and is in no set for it. Thread
    # numbers are a board's own, so the board is part of the collection.
    # The thread's address is the collection's own.
    collection = {
        "id": f"4chan:{board}:{thread}",
        "url": THREAD.format(board=board, thread=thread),
    }

    todo = []
    for thing in things:
        if thing[0] in seen:
            emit("skipped", key=thing[0])
        else:
            todo.append(thing)

    def work(thing: tuple):
        key, post, n = thing
        try:
            if n is None:
                return thing, fetch(board, post, out), None
            # Apart from the post's own file, and from its other links.
            return thing, fetch_file(key, out / f"{post['no']}-{n}"), None
        except Exception as e:  # keep going; the server is told
            return thing, None, str(e)

    with ThreadPoolExecutor(JOBS) as pool:
        for (key, post, n), file, err in pool.map(work, todo):
            if err:
                emit("error", key=key, message=f"{key}: {err}")
                continue
            comment = text_of(post.get("com") or "") if options.get("comments") else ""
            # A linked file is at its own address and at its post's.
            source = key if n is None else [key, post_url(post)]
            emit("item", key=key, source_url=source, files=[file], description=comment, collection=collection)
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
