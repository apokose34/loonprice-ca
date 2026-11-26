"""
LoonPrice.com - Faz 2 / Adım 3: Otomatik Katalog Büyütme Motoru
==================================================================
Best Buy Canada açık JSON API'si üzerinden Personal Care Tech
(Dyson, Shark, Philips, Oral-B, Braun) ürünlerini otomatik tarar,
boyut/marka bilgilerini çıkarır ve Supabase'deki products,
product_listings ve price_history tablolarına ekler.
"""

import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

import requests

raw_url = os.environ.get("SUPABASE_URL", "").strip().strip('"').strip("'").rstrip("/")
if raw_url.endswith("/rest/v1"):
    raw_url = raw_url[:-8]
if raw_url and not raw_url.startswith(("http://", "https://")):
    raw_url = f"https://{raw_url}"

SUPABASE_URL = raw_url.rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip().strip('"').strip("'")

HEADERS = {
    "User-Agent": "LoonPriceCatalogBot/1.0 (+https://www.loonprice.com)",
    "Accept": "application/json",
}

TECH_SEARCH_TERMS = [
    "Dyson hair",
    "Shark FlexStyle",
    "Philips Sonicare",
    "Oral-B iO",
    "Braun Series",
    "Braun Silk-expert",
]


def supabase_headers(prefer: str = "return=representation") -> dict[str, str]:
    headers = {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": prefer,
    }
    if not SUPABASE_KEY.startswith("sb_"):
        headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
    return headers


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:90]


def get_lookup_ids() -> tuple[dict[str, str], dict[str, str]]:
    cats = requests.get(
        f"{SUPABASE_URL}/rest/v1/categories?select=id,slug",
        headers=supabase_headers("return=minimal"),
        timeout=15,
    ).json()
    stores = requests.get(
        f"{SUPABASE_URL}/rest/v1/stores?select=id,slug",
        headers=supabase_headers("return=minimal"),
        timeout=15,
    ).json()
    return (
        {c["slug"]: c["id"] for c in cats},
        {s["slug"]: s["id"] for s in stores},
    )


def upsert_product_and_listing(
    category_id: str,
    store_id: str,
    brand: str,
    name: str,
    slug: str,
    sku: str,
    price_cad: float,
    product_url: str,
    image_url: Optional[str],
    size_value: float = 1.0,
    size_unit: str = "unit",
) -> None:
    prod_payload = {
        "brand": brand,
        "name": name,
        "slug": slug,
        "category_id": category_id,
        "size_value": size_value,
        "size_unit": size_unit,
        "condition": "new",
        "image_url": image_url,
        "is_featured": False,
    }
    p_resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/products?on_conflict=slug",
        headers=supabase_headers("resolution=merge-duplicates,return=representation"),
        json=prod_payload,
        timeout=15,
    )
    if p_resp.status_code not in (200, 201):
        print(f"  [Atlandı] Ürün eklenemedi ({slug}): {p_resp.text}")
        return

    product_id = p_resp.json()[0]["id"]
    now_iso = datetime.now(timezone.utc).isoformat()

    listing_payload = {
        "product_id": product_id,
        "store_id": store_id,
        "store_sku": sku,
        "product_url": product_url,
        "current_price_cad": price_cad,
        "shipping_cost_cad": 0.00,
        "in_stock": True,
        "last_checked_at": now_iso,
    }
    l_resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/product_listings?on_conflict=product_id,store_id",
        headers=supabase_headers("resolution=merge-duplicates,return=representation"),
        json=listing_payload,
        timeout=15,
    )
    if l_resp.status_code not in (200, 201):
        print(f"  [Atlandı] Listeleme eklenemedi ({slug}): {l_resp.text}")
        return

    listing_id = l_resp.json()[0]["id"]
    requests.post(
        f"{SUPABASE_URL}/rest/v1/price_history",
        headers=supabase_headers("return=minimal"),
        json={"listing_id": listing_id, "price_cad": price_cad, "recorded_at": now_iso},
        timeout=15,
    )
    print(f"  [Eklendi/Güncellendi] {brand} - {name} -> ${price_cad:.2f} CAD")


def discover_bestbuy_ca(category_id: str, store_id: str) -> None:
    for term in TECH_SEARCH_TERMS:
        print(f"Best Buy Canada aranıyor: '{term}'...")
        url = (
            "https://www.bestbuy.ca/api/v2/json/search"
            f"?query={requests.utils.quote(term)}&lang=en-CA&pageSize=10"
        )
        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
            if resp.status_code != 200:
                print(f"  [Uyarı] Best Buy API HTTP {resp.status_code}")
                continue
            products = resp.json().get("products", [])
        except requests.RequestException as exc:
            print(f"  [Hata] {exc}")
            continue

        for item in products:
            if item.get("isMarketplace"):
                continue  # Sadece resmi Kanada satıcısı (gümrüksüz/güvenilir)
            name = (item.get("name") or "").strip()
            sku = str(item.get("sku") or "").strip()
            price = item.get("salePrice") or item.get("regularPrice")
            rel_url = item.get("productUrl") or ""
            if not name or not sku or not price or not rel_url:
                continue

            brand = name.split()[0]
            full_url = f"https://www.bestbuy.ca{rel_url}" if rel_url.startswith("/") else rel_url
            img = item.get("highResImage") or item.get("thumbnailImage")
            slug = slugify(f"{name}-{sku}")

            upsert_product_and_listing(
                category_id=category_id,
                store_id=store_id,
                brand=brand,
                name=name,
                slug=slug,
                sku=sku,
                price_cad=round(float(price), 2),
                product_url=full_url,
                image_url=img,
            )


def run_discovery() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY tanımlı olmalıdır.")

    cat_map, store_map = get_lookup_ids()
    tech_cat_id = cat_map.get("personal-care-tech")
    bestbuy_id = store_map.get("best-buy-ca")

    if not tech_cat_id or not bestbuy_id:
        raise RuntimeError("Kategori veya mağaza ID'si bulunamadı.")

    discover_bestbuy_ca(tech_cat_id, bestbuy_id)
    print("Katalog keşfi tamamlandı.")


if __name__ == "__main__":
    run_discovery()
