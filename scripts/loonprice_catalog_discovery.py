"""
LoonPrice.com - Otomatik Katalog Büyütme Motoru (Tech + Beauty)
==================================================================
1. Personal Care Tech (Best Buy Canada JSON API):
   Dyson saç şekillendiriciler, Shark, Philips Sonicare, Oral-B iO, Braun.
   (Süpürge, fan, hava temizleyici gibi kategori dışı ürünleri otomatik eler.)
2. Beauty & Skincare (Well.ca açık ürün sayfaları / JSON-LD):
   CeraVe, La Roche-Posay, The Ordinary, Bioderma, Cetaphil, Vichy, Neutrogena.
   Otomatik mL/g boyut çıkarımı ve hotlink engeli olmayan CloudFront görselleri.
"""

import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote_plus

import requests
from bs4 import BeautifulSoup

raw_url = os.environ.get("SUPABASE_URL", "").strip().strip('"').strip("'").rstrip("/")
if raw_url.endswith("/rest/v1"):
    raw_url = raw_url[:-8]
if raw_url and not raw_url.startswith(("http://", "https://")):
    raw_url = f"https://{raw_url}"

SUPABASE_URL = raw_url.rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip().strip('"').strip("'")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-CA,en;q=0.9",
}

TECH_SEARCH_TERMS = [
    "Dyson Airwrap",
    "Dyson Supersonic",
    "Dyson Airstrait",
    "Shark FlexStyle",
    "Philips Sonicare",
    "Oral-B iO",
    "Braun Series",
    "Braun Silk-expert",
]

EXCLUDED_TECH_WORDS = (
    "vacuum",
    "cordless",
    "stick",
    "canister",
    "upright",
    "purifier",
    "humidifier",
    "heater",
    "fan",
    "filter",
    "robot",
    "mop",
    "pet",
    "case",
    "stand",
    "bag",
    "replacement",
    "refill",
    "brush head",
)

BEAUTY_SEARCH_TERMS = [
    "CeraVe",
    "La Roche-Posay",
    "The Ordinary",
    "Bioderma",
    "Cetaphil",
    "Vichy",
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
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:90]


def extract_size_and_unit(name: str) -> tuple[float, str]:
    match = re.search(r"(\d+(?:\.\d+)?)\s*(ml|mL|g|gr|oz)\b", name, re.IGNORECASE)
    if not match:
        return 1.0, "unit"
    val = float(match.group(1))
    unit_raw = match.group(2).lower()
    if unit_raw == "ml":
        return val, "mL"
    if unit_raw in ("g", "gr"):
        return val, "g"
    if unit_raw == "oz":
        return round(val * 29.57, 1), "mL"
    return 1.0, "unit"


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
        return

    listing_id = l_resp.json()[0]["id"]
    requests.post(
        f"{SUPABASE_URL}/rest/v1/price_history",
        headers=supabase_headers("return=minimal"),
        json={"listing_id": listing_id, "price_cad": price_cad, "recorded_at": now_iso},
        timeout=15,
    )
    print(f"  [Eklendi] {brand} - {name} -> ${price_cad:.2f} CAD")


def discover_bestbuy_ca(category_id: str, store_id: str) -> None:
    for term in TECH_SEARCH_TERMS:
        print(f"Best Buy Canada aranıyor: '{term}'...")
        url = f"https://www.bestbuy.ca/api/v2/json/search?query={quote_plus(term)}&lang=en-CA&pageSize=8"
        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
            if resp.status_code != 200:
                continue
            products = resp.json().get("products", [])
        except requests.RequestException:
            continue

        for item in products:
            if item.get("isMarketplace"):
                continue
            name = (item.get("name") or "").strip()
            lower_name = name.lower()
            if any(bad in lower_name for bad in EXCLUDED_TECH_WORDS):
                continue

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


def discover_well_ca_beauty(category_id: str, store_id: str) -> None:
    for brand_term in BEAUTY_SEARCH_TERMS:
        print(f"Well.ca Kozmetik aranıyor: '{brand_term}'...")
        search_url = f"https://well.ca/searchresult.html?keyword={quote_plus(brand_term)}"
        try:
            resp = requests.get(search_url, headers=HEADERS, timeout=20)
            if resp.status_code != 200:
                continue
        except requests.RequestException:
            continue

        soup = BeautifulSoup(resp.text, "html.parser")
        links = []
        for a in soup.select("a[href*='/products/']"):
            href = a.get("href", "")
            if href.startswith("/products/"):
                href = f"https://well.ca{href}"
            if href.startswith("https://well.ca/products/") and href not in links:
                links.append(href)
            if len(links) >= 5:
                break

        for prod_url in links:
            try:
                p_resp = requests.get(prod_url, headers=HEADERS, timeout=15)
                if p_resp.status_code != 200:
                    continue
                p_soup = BeautifulSoup(p_resp.text, "html.parser")
                for script in p_soup.find_all("script", type="application/ld+json"):
                    try:
                        data = json.loads(script.string or "{}")
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(data, dict) or data.get("@type") != "Product":
                        continue
                    name = (data.get("name") or "").strip()
                    offers = data.get("offers") or {}
                    if isinstance(offers, list):
                        offers = offers[0] if offers else {}
                    price = offers.get("price")
                    img = data.get("image")
                    if isinstance(img, list):
                        img = img[0] if img else None
                    if not name or not price:
                        continue
                    size_val, size_unit = extract_size_and_unit(name)
                    sku_match = re.search(r"_(\d+)\.html", prod_url)
                    sku = sku_match.group(1) if sku_match else slugify(name)[:20]
                    upsert_product_and_listing(
                        category_id=category_id,
                        store_id=store_id,
                        brand=brand_term,
                        name=name,
                        slug=slugify(f"{name}-{sku}"),
                        sku=sku,
                        price_cad=round(float(price), 2),
                        product_url=prod_url,
                        image_url=img,
                        size_value=size_val,
                        size_unit=size_unit,
                    )
                    break
            except requests.RequestException:
                continue
            time.sleep(0.8)


def run_discovery() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY tanımlı olmalıdır.")

    cat_map, store_map = get_lookup_ids()
    tech_cat_id = cat_map.get("personal-care-tech")
    beauty_cat_id = cat_map.get("beauty-skincare")
    bestbuy_id = store_map.get("best-buy-ca")
    well_id = store_map.get("well-ca")

    if tech_cat_id and bestbuy_id:
        discover_bestbuy_ca(tech_cat_id, bestbuy_id)
    if beauty_cat_id and well_id:
        discover_well_ca_beauty(beauty_cat_id, well_id)
    print("Katalog keşfi tamamlandı.")


if __name__ == "__main__":
    run_discovery()
