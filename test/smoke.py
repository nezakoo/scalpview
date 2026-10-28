#!/usr/bin/env python3
"""Headless smoke test: load dist/scalpview.html, wait, print console errors + state, save screenshot.
Usage: .venv/bin/python test/smoke.py [seconds=25] [js-to-eval-after]"""
import glob, os, sys, json
from playwright.sync_api import sync_playwright
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell"))[0]
secs = float(sys.argv[1]) if len(sys.argv) > 1 else 25
extra = sys.argv[2] if len(sys.argv) > 2 else None
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE)
    pg = b.new_page(viewport={"width": 1600, "height": 950})
    logs = []
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    pg.goto("file://" + os.environ.get("SB_PAGE", os.path.join(H, "dist/scalpview.html")))
    pg.wait_for_timeout(secs * 1000)
    state = pg.evaluate("""() => window.SB ? ({coins: SB.coins.size, list: SB.list.length,
        withM1: [...SB.coins.values()].filter(c => c.m1 && c.m1.length > 20).length,
        charts: SB.charts ? SB.charts.size : 0,
        top: SB.list.slice(0, 8).map(c => c.key + ' ' + c.ex)}) : 'no SB'""")
    print("STATE", json.dumps(state))
    if extra:
        print("EVAL", json.dumps(pg.evaluate(extra), default=str)[:3000])
    pg.screenshot(path=os.path.join(H, "test/shot.png"), type="png")
    for l in logs[:40]:
        print(l[:400])
    print(f"{len(logs)} console errors/warnings")
    b.close()
