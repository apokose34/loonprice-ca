"""
LoonPrice.com - Tam Doğrulamalı Fiyat, Stok ve Gramaj Senkronizasyon Motoru (v3)
================================================================================
- Best Buy Canada: Resmi JSON API üzerinden canlı CAD fiyat + stok.
- Well.ca: Önce hızlı JSON-LD dener, engellenirse gerçek Chromium tarayıcısı
  (Playwright) ile sayfayı açıp canlı CAD fiyat, stok ve mL/g gramajını doğrular.
"""

import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

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
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-CA,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def supabase_headers() -> dict[str, str]:
    headers = {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    if not SUPABASE_KEY.startswith("sb_"):
        headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
    return headers


def fetch_active_listings() -> list[dict[str, Any]]:
    url = (
        f"{SUPABASE_URL}/rest/v1/product_listings"
        "?select=id,product_id,store_id,product_url,current_price_cad,in_stock,"
        "stores(slug,name),products(name,size_value,size_unit)"
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


def extract_size_from_text(text: str) -> tuple[Optional[float], Optional[str]]:
    match = re.search(r"(\d+(?:\.\d+)?)\s*(ml|mL|g|gr)\b", text, re.IGNORECASE)
    if not match:
        return None, None
    val = float(match.group(1))
    unit_raw = match.group(2).lower()
    if unit_raw == "ml":
        return val, "mL"
    if unit_raw in ("g", "gr"):
        return val, "g"
    return None, None


def extract_well_ca_from_html(html: str) -> tuple[Optional[float], bool, Optional[float], Optional[str]]:
    soup = BeautifulSoup(html, "html.parser")
    price = None
    in_stock = "notify me - sold out" not in soup.get_text(" ").lower()
    detected_size, detected_unit = None, None

    # 1) JSON-LD kontrolü
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "{}")
        except json.JSONDecodeError:
            continue
        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            name_str = str(node.get("name", ""))
            if name_str and detected_size is None:
                detected_size, detected_unit = extract_size_from_text(name_str)
            offers = node.get("offers")
            if not offers:
                continue
            offer_list = offers if isinstance(offers, list) else [offers]
            for offer in offer_list:
                if not isinstance(offer, dict):
                    continue
                p = parse_price_value(offer.get("price") or offer.get("lowPrice"))
                if p is not None:
                    price = p
                    avail = str(offer.get("availability", "")).lower()
                    if "outofstock" in avail:
                        in_stock = False
                    break

    # 2) Meta / HTML fiyat seçicileri
    if price is None:
        meta_price = soup.find("meta", property="product:price:amount") or soup.find(
            "meta", attrs={"itemprop": "price"}
        )
        if meta_price and meta_price.get("content"):
            price = parse_price_value(meta_price["content"])

    if price is None:
        for sel in (".product_price", ".price", "[itemprop='price']", ".sale_price"):
            el = soup.select_one(sel)
            if el:
                p = parse_price_value(el.get_text(" "))
                if p is not None and p < 500:
                    price = p
                    break

    if detected_size is None:
        for sel in (".product_size", "h1", "title"):
            el = soup.select_one(sel)
            if el:
                detected_size, detected_unit = extract_size_from_text(el.get_text(" "))
                if detected_size is not None:
                    break

    return price, in_stock, detected_size, detected_unit


def scrape_bestbuy_ca(url: str) -> tuple[Optional[float], bool, Optional[float], Optional[str]]:
    match = re.search(r"/(\d{7,9})(?:$|\?)", url)
    if not match:
        return None, True, None, None
    sku = match.group(1)
    api_url = f"https://www.bestbuy.ca/api/v2/json/product/{sku}?lang=en-CA"
    resp = requests.get(api_url, headers=HEADERS, timeout=15)
    if resp.status_code != 200:
        return None, True, None, None
    data = resp.json()
    price = parse_price_value(data.get("salePrice") or data.get("regularPrice"))
    in_stock = bool(data.get("isAvailableOnline", True))
    return price, in_stock, None, None


def update_product_size_if_needed(
    product_id: str,
    product_info: dict[str, Any],
    detected_size: Optional[float],
    detected_unit: Optional[str],
) -> None:
    if detected_size is None or detected_unit is None:
        return
    old_size = product_info.get("size_value")
    old_unit = product_info.get("size_unit")
    if old_size is not None and abs(float(old_size) - detected_size) < 0.01 and old_unit == detected_unit:
        return

    url = f"{SUPABASE_URL}/rest/v1/products?id=eq.{product_id}"
    payload = {"size_value": detected_size, "size_unit": detected_unit}
    resp = requests.patch(url, headers=supabase_headers(), json=payload, timeout=15)
    resp.raise_for_status()
    print(f"  [Gramaj Düzeltildi] {old_size} {old_unit} -> {detected_size} {detected_unit}")


def update_listing_and_history(
    listing: dict[str, Any], new_price: float, in_stock: bool
) -> None:
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
        print(f"  [Fiyat Güncellendi] {old_price:.2f} -> {new_price:.2f} CAD")
    else:
        print(f"  [Doğrulandı] {new_price:.2f} CAD")


def run_sync() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY tanımlı olmalıdır.")

    listings = fetch_active_listings()
    print(f"Toplam {len(listings)} mağaza kaydı canlı doğrulanıyor...")

    ok_count = 0
    skip_count = 0

    # Playwright tarayıcısını yalnızca Well.ca kayıtları için bir kez başlat
    pw_context = None
    browser = None
    page = None
    try:
        from playwright.sync_api import sync_playwright

        pw_context = sync_playwright().start()
        browser = pw_context.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=HEADERS["User-Agent"],
            locale="en-CA",
        )
        page = context.new_page()
    except Exception as exc:
        print(f"[Bilgi] Playwright başlatılamadı, sadece requests kullanılacak: {exc}")

    try:
        for item in listings:
            store = item.get("stores") or {}
            store_slug = store.get("slug", "unknown")
            product_info = item.get("products") or {}
            url = item["product_url"]
            print(f"- [{store_slug}] {product_info.get('name', '')} -> {url}")

            new_price, in_stock, det_size, det_unit = None, True, None, None

            try:
                if store_slug == "best-buy-ca":
                    new_price, in_stock, det_size, det_unit = scrape_bestbuy_ca(url)
                elif store_slug == "well-ca":
                    resp = requests.get(url, headers=HEADERS, timeout=15)
                    if resp.status_code == 200:
                        new_price, in_stock, det_size, det_unit = extract_well_ca_from_html(resp.text)
                    if new_price is None and page is not None:
                        page.goto(url, wait_until="domcontentloaded", timeout=25000)
                        page.wait_for_timeout(1500)
                        new_price, in_stock, det_size, det_unit = extract_well_ca_from_html(
                            page.content()
                        )
            except Exception as exc:
                print(f"  [Hata] {exc}")

            if new_price is not None:
                update_product_size_if_needed(item["product_id"], product_info, det_size, det_unit)
                update_listing_and_history(item, new_price, in_stock)
                ok_count += 1
            else:
                print("  [Doğrulanamadı / Bot Koruması]")
                skip_count += 1

            time.sleep(0.5)
    finally:
        if browser:
            browser.close()
        if pw_context:
            pw_context.stop()

    print(f"\nÖZET: {ok_count} kayıt canlı doğrulandı, {skip_count} kayıt doğrulanamadı.")


if __name__ == "__main__":
    run_sync()
