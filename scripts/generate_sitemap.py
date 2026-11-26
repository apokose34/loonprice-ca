"""
LoonPrice.com - Otomatik Sitemap Oluşturucu
===========================================
Supabase'deki tüm ürünlerin slug'larını çeker ve Google Search Console'un
her ürünü tek tek indeksleyebilmesi için sitemap.xml dosyasını günceller.
"""

import os
from datetime import datetime, timezone
from xml.sax.saxutils import escape

import requests

raw_url = os.environ.get("SUPABASE_URL", "").strip().strip('"').strip("'").rstrip("/")
if raw_url.endswith("/rest/v1"):
    raw_url = raw_url[:-8]
if raw_url and not raw_url.startswith(("http://", "https://")):
    raw_url = f"https://{raw_url}"

SUPABASE_URL = raw_url.rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip().strip('"').strip("'")


def supabase_headers() -> dict[str, str]:
    headers = {"apikey": SUPABASE_KEY}
    if not SUPABASE_KEY.startswith("sb_"):
        headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
    return headers


def build_sitemap() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY tanımlı olmalıdır.")

    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/products?select=slug&order=created_at.desc",
        headers=supabase_headers(),
        timeout=20,
    )
    resp.raise_for_status()
    products = resp.json()

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    urls = [
        f"""  <url>
    <loc>https://www.loonprice.com/</loc>
    <lastmod>{today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>"""
    ]

    for p in products:
        slug = escape(p["slug"])
        urls.append(
            f"""  <url>
    <loc>https://www.loonprice.com/?product={slug}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>"""
        )

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls)
        + "\n</urlset>\n"
    )

    with open("sitemap.xml", "w", encoding="utf-8") as f:
        f.write(xml)
    print(f"sitemap.xml güncellendi: toplam {len(urls)} URL.")


if __name__ == "__main__":
    build_sitemap()
