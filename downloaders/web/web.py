#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///
"""The downloader for any site, for OpalArchive. See ../README.md for the protocol.

    web.py download < request.json

It takes what no other downloader takes: the address of a file itself, a
picture or a video, on any site. It knows nothing of the site, so it brings
no title or creator, only the file, with its address as the source URL and
the site as the source `web:<host>`. A page is refused, as it would be in
an upload tab: there is nothing in it to tell which of its files is meant.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "image/avif,image/webp,image/*,video/*,*/*;q=0.8",
}
RETRY_STATUS = {429, 500, 502, 503, 504}
PAGES = ("text/html", "application/xhtml+xml")


def emit(event: str, **fields) -> None:
    """Tells the server something, as one line of JSON."""
    try:
        print(json.dumps({"event": event, **fields}), flush=True)
    except BrokenPipeError:
        # The server has gone, or cancelled the download.
        os._exit(1)


def get(url: str) -> requests.Response:
    """GET with retries on rate limiting and transient errors."""
    # Some sites only hand out their files to their own pages.
    parsed = urlparse(url)
    headers = {**HEADERS, "Referer": f"{parsed.scheme}://{parsed.netloc}/"}
    for attempt in range(4):
        try:
            r = requests.get(url, headers=headers, timeout=60, stream=True)
            if r.status_code not in RETRY_STATUS:
                return r
            err = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            err = str(e)
        if attempt == 3:
            raise RuntimeError(err)
        time.sleep(2**attempt)
    raise AssertionError


def name_of(r: requests.Response) -> str:
    """The file's name: as the site gives it, or the last part of its address,
    with the extension its type gives if it has none."""
    given = re.search(r"""filename\*?=(?:UTF-8'')?["']?([^"';]+)""", r.headers.get("content-disposition", ""))
    name = unquote(given.group(1)) if given else unquote(urlparse(r.url).path.rsplit("/", 1)[-1])
    # Only a name, with nothing in it that leads elsewhere.
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(". ") or "file"
    content_type = r.headers.get("content-type", "").split(";")[0].strip().lower()
    if not Path(name).suffix:
        name += mimetypes.guess_extension(content_type) or ""
    return name[-150:]


def site_of(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def download() -> int:
    request = json.load(sys.stdin)
    out = Path(request["out"])
    out.mkdir(parents=True, exist_ok=True)
    url = request["url"]
    emit("found", total=1)
    if url in (request.get("seen") or []):
        emit("skipped", key=url)
        return 0

    emit("log", message="Downloading")
    r = get(url)
    if r.status_code != 200:
        raise RuntimeError(f"the site said HTTP {r.status_code}")
    content_type = r.headers.get("content-type", "").lower()
    if content_type.startswith(PAGES):
        raise RuntimeError(
            f"that address is a page, not a file, and there is no downloader for {site_of(url)}: "
            "send the picture or video itself"
        )
    dest = out / name_of(r)
    part = dest.with_name(dest.name + ".part")
    with open(part, "wb") as f:
        for chunk in r.iter_content(1 << 16):
            f.write(chunk)
    part.rename(dest)

    sources = [url] if r.url == url else [url, r.url]
    emit("item", key=url, source_url=sources, files=[str(dest)], tags={"source": [f"web:{site_of(url)}"]})
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
