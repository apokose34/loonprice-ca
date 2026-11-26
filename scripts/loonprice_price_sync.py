"""
LoonPrice.com - Adım 4 (%80): Otomatik Fiyat & Stok Tarama Motoru
==================================================================
Supabase'deki aktif ürün listelemelerini (product_listings) okur,
6 Kanada mağazasından (Amazon.ca, Sephora, Shoppers, Well.ca,
Walmart.ca, Best Buy Canada) güncel CAD fiyatını ve stok durumunu
JSON-LD / mağaza şemaları üzerinden çeker ve Supabase'i günceller.

Gerekli Ortam Değişkenleri (GitHub Secrets veya .env):
  SUPABASE_URL=https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
"""

import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

import requests
from bs4 import BeautifulSoup

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-CA,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def supabase_headers() -> dict[str, str]:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


def fetch_active_listings() -> list[dict[str, Any]]:
    """Supabase'den mağaza bilgisiyle birlikte aktif ürün listelemelerini çeker."""
    url = (
        f"{SUPABASE_URL}/rest/v1/product_listings"
        "?select=id,product_id,store_id,product_url,current_price_cad,in_stock,"
        "stores(slug,name)"
    )
    resp = requests.get(url, headers=supabase_headers(), timeout=20)
    resp.raise_for_status()
    return resp.json()


def parse_price_value(raw: Any) -> Optional[float]:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return round(float(raw), 2)
    cleaned = re.sub(r"[^\d.]", "", str(raw).replace(",", ""))
    try:
        val = round(float(cleaned), 2)
        return val if val > 0 else None
    except ValueError:
        return None


def extract_json_ld_offer(html: str) -> tuple[Optional[float], bool]:
    """Sayfadaki standart schema.org Product/Offer JSON-LD verisinden CAD fiyat ve stok çıkarır."""
    soup = BeautifulSoup(html, "html.parser")
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "{}")
        except json.JSONDecodeError:
            continue

        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            offers = node.get("offers")
            if not offers:
                continue
            offer_list = offers if isinstance(offers, list) else [offers]
            for offer in offer_list:
                if not isinstance(offer, dict):
                    continue
                currency = str(offer.get("priceCurrency", "CAD")).upper()
                if currency not in ("CAD", ""):
                    continue
                price = parse_price_value(offer.get("price") or offer.get("lowPrice"))
                availability = str(offer.get("availability", "")).lower()
                in_stock = "outofstock" not in availability
                if price is not None:
                    return price, in_stock
    return None, True


def scrape_bestbuy_ca(url: str) -> tuple[Optional[float], bool]:
    """Best Buy Canada ürün URL'sindeki SKU'yu bulup resmi JSON API'sinden fiyat çeker."""
    match = re.search(r"/(\d{7,9})(?:$|\?)", url)
    if not match:
        return None, True
    sku = match.group(1)
    api_url = f"https://www.bestbuy.ca/api/v2/json/product/{sku}?lang=en-CA"
    resp = requests.get(api_url, headers=HEADERS, timeout=15)
    if resp.status_code != 200:
        return None, True
    data = resp.json()
    price = parse_price_value(data.get("salePrice") or data.get("regularPrice"))
    in_stock = bool(data.get("isAvailableOnline", True))
    return price, in_stock


def scrape_listing_price(store_slug: str, url: str) -> tuple[Optional[float], bool]:
    """Mağaza türüne göre en uygun yöntemle canlı CAD fiyatını getirir."""
    try:
        if store_slug == "best-buy-ca":
            price, in_stock = scrape_bestbuy_ca(url)
            if price is not None:
                return price, in_stock

        resp = requests.get(url, headers=HEADERS, timeout=20)
        if resp.status_code != 200:
            print(f"  [Uyarı] {store_slug} HTTP {resp.status_code}: {url}")
            return None, True

        return extract_json_ld_offer(resp.text)
    except requests.RequestException as exc:
        print(f"  [Hata] {store_slug} bağlantı hatası: {exc}")
        return None, True


def update_listing_and_history(
    listing: dict[str, Any], new_price: float, in_stock: bool
) -> None:
    """Fiyat değiştiyse price_history'ye kayıt atar ve product_listings'i günceller."""
    listing_id = listing["id"]
    old_price = float(listing["current_price_cad"])
    now_iso = datetime.now(timezone.utc).isoformat()

    patch_url = f"{SUPABASE_URL}/rest/v1/product_listings?id=eq.{listing_id}"
    patch_payload = {
        "current_price_cad": new_price,
        "in_stock": in_stock,
        "last_checked_at": now_iso,
    }
    resp = requests.patch(patch_url, headers=supabase_headers(), json=patch_payload, timeout=15)
    resp.raise_for_status()

    if abs(new_price - old_price) >= 0.01:
        history_url = f"{SUPABASE_URL}/rest/v1/price_history"
        history_payload = {
            "listing_id": listing_id,
            "price_cad": new_price,
            "recorded_at": now_iso,
        }
        h_resp = requests.post(
            history_url, headers=supabase_headers(), json=history_payload, timeout=15
        )
        h_resp.raise_for_status()
        print(f"  [Güncellendi] {old_price:.2f} -> {new_price:.2f} CAD (tarihçeye eklendi)")
    else:
        print(f"  [Sabit] {new_price:.2f} CAD")


def run_sync() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError(
            "SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY ortam değişkenleri tanımlı olmalıdır."
        )

    listings = fetch_active_listings()
    print(f"Toplam {len(listings)} aktif mağaza kaydı taranıyor...")

    for item in listings:
        store = item.get("stores") or {}
        store_slug = store.get("slug", "unknown")
        url = item["product_url"]
        print(f"- {store_slug}: {url}")

        new_price, in_stock = scrape_listing_price(store_slug, url)
        if new_price is not None:
            update_listing_and_history(item, new_price, in_stock)
        else:
            print("  [Atlandı] Fiyat bilgisi okunamadı (bot koruması veya sayfa yapısı).")

        time.sleep(1.5)  # Mağaza sunucularını yormamak için nazik bekleme


if __name__ == "__main__":
    run_sync()
