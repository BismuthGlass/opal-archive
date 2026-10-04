#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "yt-dlp"]
# ///
"""The Pinterest downloader for tagutils. See ../README.md for the protocol.

    pinterest.py cookies --browser chrome --out FILE
    pinterest.py download < request.json

It takes pin, board, board section and profile URLs. Public boards need no
login, but Pinterest hides some pins, and every secret board, from visitors
who are logged out.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests

API = "https://www.pinterest.com/resource/{}Resource/get/"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*, q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "X-Pinterest-AppState": "active",
    # The API answers 403 "Invalid Resource Request" without this header.
    "X-Pinterest-PWS-Handler": "www/[username]/[slug].js",
    "Referer": "https://www.pinterest.com/",
    "Origin": "https://www.pinterest.com",
}
RETRY_STATUS = {429, 500, 502, 503, 504}
# Pins fetched at once.
JOBS = 8

session = requests.Session()
session.headers.update(HEADERS)


def emit(event: str, **fields) -> None:
    """Tells the server something, as one line of JSON."""
    try:
        print(json.dumps({"event": event, **fields}), flush=True)
    except BrokenPipeError:
        # The server has gone, or cancelled the download.
        os._exit(1)


def pin_url(pin_id: str) -> str:
    return f"https://www.pinterest.com/pin/{pin_id}/"


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


def call(resource: str, options: dict) -> dict:
    r = get(
        API.format(resource),
        params={"source_url": "/", "data": json.dumps({"options": options, "context": {}})},
    )
    if r.status_code != 200:
        raise RuntimeError(f"{resource}: HTTP {r.status_code} {r.text[:200]}")
    return r.json()["resource_response"]


def paginate(resource: str, options: dict):
    options = dict(options)
    while True:
        resp = call(resource, options)
        yield from resp.get("data") or []
        bookmark = resp.get("bookmark")
        if not bookmark or bookmark == "-end-":
            return
        options["bookmarks"] = [bookmark]


# --- listing -----------------------------------------------------------------


def list_boards(user: str) -> list[dict]:
    opts = {
        "username": user,
        "page_size": 50,
        "field_set_key": "profile_grid_item",
        "privacy_filter": "all",
        "sort": "last_pinned_to",
    }
    return [b for b in paginate("Boards", opts) if b.get("type") == "board"]


def get_board(user: str, slug: str) -> dict:
    return call("Board", {"username": user, "slug": slug, "field_set_key": "detailed"})["data"]


def list_sections(board_id: str) -> list[dict]:
    return list(paginate("BoardSections", {"board_id": board_id}))


def list_pins(resource: str, options: dict) -> list[dict]:
    # Feeds also carry non-pin modules ("Find more ideas"); keep only real pins.
    return [p for p in paginate(resource, {**options, "page_size": 50}) if p.get("type") == "pin"]


def board_pins(user: str, slug: str, only_section: str | None, recursive: bool) -> list[dict]:
    """The pins of a board, or of one of its sections.

    Without `recursive`, only the pins that sit in the board itself, outside
    its sections.
    """
    board = get_board(user, slug)
    emit("log", message=f"Listing {board['name']}")
    sections = list_sections(board["id"]) if board.get("section_count") or only_section else []
    if only_section:
        sections = [s for s in sections if s["slug"] == only_section]
        if not sections:
            raise RuntimeError(f"section {only_section!r} not found in {user}/{slug}")
    pins: list[dict] = []
    in_sections: set[str] = set()
    for section in sections:
        found = list_pins("BoardSectionPins", {"section_id": section["id"]})
        in_sections.update(p["id"] for p in found)
        if recursive or only_section:
            pins += found
    if not only_section:
        feed = list_pins("BoardFeed", {"board_id": board["id"], "field_set_key": "react_grid_pin"})
        pins += [p for p in feed if p["id"] not in in_sections]
    return pins


# --- media extraction --------------------------------------------------------


def best_image(images: dict | None) -> str | None:
    if not images:
        return None
    for key in ("orig", "originals"):
        if images.get(key, {}).get("url"):
            return images[key]["url"]
    # Carousel slots only list resized variants; the original lives at /originals/.
    largest = max(images.values(), key=lambda i: (i.get("width") or 0) * (i.get("height") or 0))
    return re.sub(r"(i\.pinimg\.com)/[^/]+/", r"\1/originals/", largest["url"], count=1)


def best_video(videos: dict | None) -> str | None:
    variants = [v for v in ((videos or {}).get("video_list") or {}).values() if v.get("url")]
    if not variants:
        return None
    mp4 = [v for v in variants if urlparse(v["url"]).path.endswith(".mp4")]
    pool = mp4 or variants
    return max(pool, key=lambda v: (v.get("width") or 0) * (v.get("height") or 0))["url"]


def media_urls(pin: dict, want_video: bool) -> list[str]:
    """Every media URL of a pin, in display order."""
    video = best_video(pin.get("videos"))
    if video:
        return [video] if want_video else []

    urls = []
    for page in (pin.get("story_pin_data") or {}).get("pages") or []:
        for block in page.get("blocks") or []:
            v = best_video(block.get("video"))
            if v:
                if want_video:
                    urls.append(v)
            elif (block.get("image") or {}).get("images"):
                urls.append(best_image(block["image"]["images"]))
    if not urls:
        for slot in (pin.get("carousel_data") or {}).get("carousel_slots") or []:
            urls.append(best_image(slot.get("images")))
    if not urls:
        urls.append(best_image(pin.get("images")))
    return [u for u in urls if u]


def pin_title(pin: dict) -> str:
    """The title a pin shows on its page, if it has one."""
    # Pins made in Pinterest's own editor ("story pins") keep theirs apart.
    story = ((pin.get("story_pin_data") or {}).get("metadata") or {}).get("pin_title")
    return (pin.get("title") or pin.get("grid_title") or story or "").strip()


# --- downloading -------------------------------------------------------------


def fetch(url: str, dest: Path) -> None:
    part = dest.with_name(dest.name + ".part")
    if urlparse(url).path.endswith(".m3u8"):
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg is needed for this video")
        subprocess.run(
            ["ffmpeg", "-loglevel", "fatal", "-y", "-i", url, "-c", "copy", "-f", "mp4", str(part)],
            check=True,
        )
    else:
        r = get(url, stream=True)
        if r.status_code != 200 and "/originals/" in url:
            # Guessed original URL did not exist; fall back to the largest resize.
            r = get(url.replace("/originals/", "/736x/"), stream=True)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        with open(part, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
    part.rename(dest)


def fetch_pin(pin: dict, out: Path, want_video: bool) -> list[str]:
    """Downloads a pin's files into `out`, and returns their paths in order."""
    urls = media_urls(pin, want_video)
    files = []
    for i, url in enumerate(urls, 1):
        ext = Path(urlparse(url).path).suffix.lower()
        ext = ".mp4" if ext == ".m3u8" else ext or ".jpg"
        suffix = f"_{i:02d}" if len(urls) > 1 else ""
        dest = out / f"{pin['id']}{suffix}{ext}"
        fetch(url, dest)
        files.append(str(dest))
    return files


def collect(url: str, recursive: bool) -> list[dict]:
    """The pins a URL stands for."""
    parts = [unquote(p) for p in urlparse(url).path.split("/") if p]
    if "pinterest." not in (urlparse(url).hostname or ""):
        raise RuntimeError("that is not a Pinterest address")
    if not parts or (parts[0] == "pin" and len(parts) < 2):
        raise RuntimeError("that is not a pin, board, section or profile address")
    if parts[0] == "pin":
        # Slugged pin URLs look like /pin/some-title--1234567890/.
        pin_id = parts[1].rsplit("--", 1)[-1]
        return [call("Pin", {"id": pin_id, "field_set_key": "detailed"})["data"]]
    user, rest = parts[0], [p for p in parts[1:] if not p.startswith("_")]
    if rest:
        return board_pins(user, rest[0], rest[1] if len(rest) > 1 else None, recursive)
    if not recursive:
        raise RuntimeError("a profile holds only boards: turn on going into what is inside")
    pins: list[dict] = []
    for board in list_boards(user):
        slug = unquote(board["url"].strip("/").split("/")[-1])
        try:
            pins += board_pins(user, slug, None, True)
        except RuntimeError as e:
            emit("error", message=f"{slug}: {e}")
        emit("found", total=len(pins))
    return pins


def load_cookies(path: str | None) -> None:
    if not path:
        return
    jar = http.cookiejar.MozillaCookieJar(path)
    jar.load(ignore_discard=True, ignore_expires=True)
    session.cookies.update(jar)


def download() -> int:
    request = json.load(sys.stdin)
    options = request.get("options") or {}
    out = Path(request["out"])
    out.mkdir(parents=True, exist_ok=True)
    seen = set(request.get("seen") or [])
    load_cookies(request.get("cookies"))

    emit("log", message="Looking at the address")
    pins = collect(request["url"], options.get("recursive", True))
    # A pin can sit in several boards of a profile.
    unique = list({pin["id"]: pin for pin in pins}.values())
    emit("found", total=len(unique))
    emit("log", message="Downloading")

    todo = []
    for pin in unique:
        if pin_url(pin["id"]) in seen:
            emit("skipped", key=pin_url(pin["id"]))
        else:
            todo.append(pin)

    def work(pin: dict):
        try:
            return pin, fetch_pin(pin, out, options.get("video", True)), None
        except Exception as e:  # keep going; the server is told
            return pin, [], str(e)

    with ThreadPoolExecutor(JOBS) as pool:
        for pin, files, err in pool.map(work, todo):
            key = pin_url(pin["id"])
            if err:
                emit("error", key=key, message=f"{key}: {err}")
            else:
                emit(
                    "item",
                    key=key,
                    source_url=key,
                    files=files,
                    title=pin_title(pin),
                    # A pin of several files becomes a set, named for the pin.
                    set_title=f"pinterest#{pin['id']}",
                    description=(pin.get("description") or "").strip(),
                )
    return 0


def cookies(browser: str, out: str) -> int:
    from yt_dlp.cookies import extract_cookies_from_browser

    # Only Pinterest's cookies are kept.
    jar = http.cookiejar.MozillaCookieJar(out)
    count = 0
    logged_in = False
    for cookie in extract_cookies_from_browser(browser):
        if "pinterest." in cookie.domain:
            jar.set_cookie(cookie)
            count += 1
            logged_in = logged_in or (cookie.name == "_auth" and cookie.value == "1")
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
    get_cookies = sub.add_parser("cookies", help="save the Pinterest login of a browser")
    get_cookies.add_argument("--browser", required=True)
    get_cookies.add_argument("--out", required=True)
    args = ap.parse_args()
    try:
        if args.command == "cookies":
            return cookies(args.browser, args.out)
        return download()
    except Exception as e:
        # The last line of standard error is what the user is shown.
        print(str(e) or type(e).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
