#!/usr/bin/env python3
"""Загрузка страницы через Scrapling — обход проверок по отпечатку клиента.

Сайты афиш отбивают обычные запросы: Киноафиша отвечает 403, Киномакс
показывает «Верификацию». Проверяется не только адрес, но и то, как клиент
здоровается — TLS-отпечаток, порядок заголовков, следы автоматизации в
браузере. Scrapling подделывает всё это.

Вызывается из Node: печатает HTML в stdout, диагностику в stderr,
код возврата 0 — успех, 1 — не вышло.

    python3 scripts/fetch_page.py <url> [--stealth] [--wait SELECTOR]
"""

import sys
import argparse


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    # Скрытый режим поднимает настоящий браузер: он медленнее, поэтому
    # включается только там, где обычного запроса не хватило.
    ap.add_argument("--stealth", action="store_true")
    ap.add_argument("--wait", default=None, help="CSS-селектор, которого дождаться")
    ap.add_argument("--timeout", type=int, default=60)
    args = ap.parse_args()

    try:
        from scrapling.fetchers import Fetcher, StealthyFetcher
    except ImportError as exc:
        print(f"scrapling не установлен: {exc}", file=sys.stderr)
        return 1

    try:
        if args.stealth:
            page = StealthyFetcher.fetch(
                args.url,
                headless=True,
                network_idle=True,
                # Turnstile и подобные проверки решаются автоматически.
                solve_cloudflare=True,
                wait_selector=args.wait,
                timeout=args.timeout * 1000,
            )
        else:
            # Обычный запрос, но с отпечатком настоящего Chrome.
            page = Fetcher.get(
                args.url,
                stealthy_headers=True,
                impersonate="chrome",
                timeout=args.timeout,
            )
    except Exception as exc:  # noqa: BLE001 — наверх уходит только диагностика
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    status = getattr(page, "status", 0)
    html = getattr(page, "html_content", "") or str(page)
    print(f"HTTP {status}, {len(html) / 1024:.0f} КБ", file=sys.stderr)

    if status and status >= 400:
        return 1
    if len(html) < 2048:
        print("ответ подозрительно короткий", file=sys.stderr)
        return 1

    sys.stdout.write(html)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
