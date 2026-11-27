const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = window.LOONPRICE_CONFIG;

let sb = null;
let allCategories = [];
let allRows = [];
let minPriceByListing = new Map();
let activeCategory = "all";
let activeBrand = "all";
let activeStore = "all";
let activeWaitlistSlug = "";
let priceChartInstance = null;

const STORE_COLORS = {
  "Amazon.ca": "#d9232e",
  "Walmart Canada": "#0071ce",
  "Well.ca": "#16a34a",
  "Shoppers Drug Mart": "#9333ea",
  "Sephora Canada": "#0f172a",
  "Best Buy Canada": "#eab308",
};

function loadSupabaseSDK() {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve(window.supabase);
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    s.onload = () => resolve(window.supabase);
    s.onerror = () => reject(new Error("Failed to load Supabase SDK"));
    document.head.appendChild(s);
  });
}

window.logStoreClick = function (productId, slug, storeName) {
  if (!sb) return;
  sb.from("click_logs")
    .insert({ product_id: productId, product_slug: slug, store_name: storeName })
    .then(() => {})
    .catch(() => {});
};

function groupByProduct(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.product_id)) {
      map.set(row.product_id, {
        product_id: row.product_id,
        slug: row.product_slug,
        brand: row.brand,
        name: row.product_name,
        size_value: row.size_value,
        size_unit: row.size_unit,
        image_url: row.image_url,
        category_slug: row.category_slug,
        category_name: row.category_name,
        listings: [],
      });
    }
    map.get(row.product_id).listings.push(row);
  }
  for (const p of map.values()) {
    p.listings.sort((a, b) => Number(a.total_price_cad) - Number(b.total_price_cad));
    p.best = p.listings[0];
    p.highest = p.listings[p.listings.length - 1];
    p.savings = Math.max(0, Number(p.highest.total_price_cad) - Number(p.best.total_price_cad));
    const histMin = minPriceByListing.get(p.best.listing_id);
    p.isNinetyDayLow =
      histMin !== undefined && Number(p.best.current_price_cad) <= histMin + 0.01;
    p.updatedLabel = p.best.last_checked_at
      ? new Date(p.best.last_checked_at).toLocaleDateString("en-CA", {
          month: "short",
          day: "numeric",
        })
      : "Today";
  }
  return Array.from(map.values());
}

function ensureFilterControls() {
  const searchRow = document.querySelector(".search-row");
  const sortSelect = document.getElementById("sortSelect");

  if (!document.getElementById("brandSelect") && searchRow) {
    const brandSelect = document.createElement("select");
    brandSelect.id = "brandSelect";
    brandSelect.setAttribute("aria-label", "Filter by brand");
    brandSelect.innerHTML = `<option value="all">All Brands</option>`;
    brandSelect.addEventListener("change", () => {
      activeBrand = brandSelect.value;
      renderProducts();
    });
    searchRow.insertBefore(brandSelect, sortSelect);
  }

  if (!document.getElementById("storeSelect") && searchRow) {
    const storeSelect = document.createElement("select");
    storeSelect.id = "storeSelect";
    storeSelect.setAttribute("aria-label", "Filter by retailer");
    storeSelect.innerHTML = `<option value="all">All Retailers</option>`;
    storeSelect.addEventListener("change", () => {
      activeStore = storeSelect.value;
      renderProducts();
    });
    searchRow.insertBefore(storeSelect, sortSelect);
  }

  if (sortSelect && !sortSelect.querySelector('option[value="savings-desc"]')) {
    const opt = document.createElement("option");
    opt.value = "savings-desc";
    opt.textContent = "Biggest Savings (CAD)";
    sortSelect.appendChild(opt);
  }

  const grid = document.getElementById("productGrid");
  if (!document.getElementById("topDealsStrip") && grid) {
    const strip = document.createElement("section");
    strip.id = "topDealsStrip";
    strip.style.marginBottom = "24px";
    grid.parentNode.insertBefore(strip, grid);
  }

  const footer = document.querySelector("footer .container");
  if (footer && !document.getElementById("footerLinks")) {
    footer.innerHTML = `
      <div id="footerLinks" style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;">
        <span>LoonPrice • Independent Canadian Price Tracker • Prices shown in CAD</span>
        <div style="display:flex;gap:16px;">
          <a href="#" onclick="openInfoModal('about');return false;" style="color:#475569;text-decoration:none;font-weight:600;">About</a>
          <a href="#" onclick="openInfoModal('how');return false;" style="color:#475569;text-decoration:none;font-weight:600;">How It Works</a>
          <a href="#" onclick="openInfoModal('privacy');return false;" style="color:#475569;text-decoration:none;font-weight:600;">Privacy &amp; Terms</a>
        </div>
      </div>
    `;
  }

  if (!document.getElementById("infoModal")) {
    const modal = document.createElement("div");
    modal.id = "infoModal";
    modal.className = "modal hidden";
    modal.innerHTML = `
      <div class="modal-card modal-small">
        <button class="modal-close" aria-label="Close" onclick="document.getElementById('infoModal').classList.add('hidden')">&times;</button>
        <h2 id="infoModalTitle" style="margin-top:0;"></h2>
        <div id="infoModalBody" class="subtitle" style="line-height:1.6;"></div>
      </div>
    `;
    document.body.appendChild(modal);
  }
}

window.openInfoModal = function (type) {
  const title = document.getElementById("infoModalTitle");
  const body = document.getElementById("infoModalBody");
  if (type === "about") {
    title.textContent = "About LoonPrice";
    body.innerHTML =
      "LoonPrice is an independent Canadian price comparison platform built to help shoppers in Canada compare real-time CAD prices, unit prices (per 100 mL / 100 g), and 365-day price history across trusted Canadian retailers without customs or USD surprises.";
  } else if (type === "how") {
    title.textContent = "How LoonPrice Works";
    body.innerHTML =
      "Our automated tracker monitors verified Canadian retailers daily (Amazon.ca, Sephora Canada, Shoppers Drug Mart, Well.ca, Walmart Canada, and Best Buy Canada). Rankings are strictly sorted by lowest total CAD price—completely unbiased and transparent.";
  } else {
    title.textContent = "Privacy & Terms";
    body.innerHTML =
      "LoonPrice does not sell personal data or require user accounts to browse prices. Emails submitted to Coming Soon waitlists are used solely to notify you when new Canadian categories launch. Prices and stock are verified daily from public retailer listings.";
  }
  document.getElementById("infoModal").classList.remove("hidden");
};

function populateFilterDropdowns() {
  const brandSelect = document.getElementById("brandSelect");
  const storeSelect = document.getElementById("storeSelect");

  const products = groupByProduct(allRows).filter(
    (p) => activeCategory === "all" || p.category_slug === activeCategory
  );

  if (brandSelect) {
    const brands = Array.from(new Set(products.map((p) => p.brand))).sort((a, b) =>
      a.localeCompare(b)
    );
    if (activeBrand !== "all" && !brands.includes(activeBrand)) activeBrand = "all";
    brandSelect.innerHTML =
      `<option value="all">All Brands (${brands.length})</option>` +
      brands
        .map(
          (b) =>
            `<option value="${b}" ${activeBrand === b ? "selected" : ""}>${b}</option>`
        )
        .join("");
  }

  if (storeSelect) {
    const stores = Array.from(new Set(allRows.map((r) => r.store_name))).sort((a, b) =>
      a.localeCompare(b)
    );
    if (activeStore !== "all" && !stores.includes(activeStore)) activeStore = "all";
    storeSelect.innerHTML =
      `<option value="all">All Retailers (${stores.length})</option>` +
      stores
        .map(
          (s) =>
            `<option value="${s}" ${activeStore === s ? "selected" : ""}>${s}</option>`
        )
        .join("");
  }
}

function renderTopDeals() {
  const strip = document.getElementById("topDealsStrip");
  if (!strip) return;

  const topDeals = groupByProduct(allRows)
    .filter((p) => p.savings >= 2)
    .sort((a, b) => b.savings - a.savings)
    .slice(0, 3);

  if (!topDeals.length) {
    strip.innerHTML = "";
    return;
  }

  strip.innerHTML = `
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
        <strong style="font-size:15px;">🍁 Today's Top Canadian Savings</strong>
        <span style="font-size:12px;color:#475569;">Biggest verified CAD price gaps across stores</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
        ${topDeals
          .map(
            (d) => `
          <div onclick="openProductModal('${d.product_id}')" style="cursor:pointer;display:flex;align-items:center;gap:12px;padding:10px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;">
            ${
              d.image_url
                ? `<img src="${d.image_url}" alt="${d.name}" onerror="this.style.display='none'" style="width:48px;height:48px;object-fit:contain;background:#fff;border-radius:6px;padding:2px;" />`
                : ""
            }
            <div style="min-width:0;">
              <div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;">${d.brand}</div>
              <div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${d.name}</div>
              <div style="font-size:13px;font-weight:800;color:#15803d;">$${Number(d.best.total_price_cad).toFixed(2)} CAD <span style="background:#dcfce7;padding:1px 6px;border-radius:4px;font-size:11px;">Save $${d.savings.toFixed(2)}</span></div>
            </div>
          </div>`
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderTabs() {
  const nav = document.getElementById("categoryTabs");
  const grouped = groupByProduct(allRows);
  const counts = {};
  for (const p of grouped) {
    counts[p.category_slug] = (counts[p.category_slug] || 0) + 1;
  }

  const buttons = [
    `<button class="tab-btn ${activeCategory === "all" ? "active" : ""}" data-slug="all">All Active Categories (${grouped.length})</button>`,
  ];
  for (const cat of allCategories) {
    if (cat.is_coming_soon) {
      buttons.push(
        `<button class="tab-btn" data-soon="${cat.slug}" data-title="${cat.name_en}">${cat.name_en}<span class="soon-badge">Soon</span></button>`
      );
    } else {
      const cnt = counts[cat.slug] || 0;
      buttons.push(
        `<button class="tab-btn ${activeCategory === cat.slug ? "active" : ""}" data-slug="${cat.slug}">${cat.name_en} (${cnt})</button>`
      );
    }
  }
  nav.innerHTML = buttons.join("");

  nav.querySelectorAll("[data-slug]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCategory = btn.dataset.slug;
      activeBrand = "all";
      renderTabs();
      populateFilterDropdowns();
      renderProducts();
    });
  });

  nav.querySelectorAll("[data-soon]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeWaitlistSlug = btn.dataset.soon;
      document.getElementById("waitlistTitle").textContent = `${btn.dataset.title} — Coming Soon`;
      document.getElementById("waitlistMsg").textContent = "";
      document.getElementById("waitlistModal").classList.remove("hidden");
    });
  });
}

function renderProducts() {
  const grid = document.getElementById("productGrid");
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const sort = document.getElementById("sortSelect").value;

  let products = groupByProduct(allRows).filter((p) => {
    const matchCat = activeCategory === "all" || p.category_slug === activeCategory;
    const matchBrand = activeBrand === "all" || p.brand === activeBrand;
    const matchStore =
      activeStore === "all" || p.listings.some((l) => l.store_name === activeStore);
    const matchQ =
      !query ||
      p.brand.toLowerCase().includes(query) ||
      p.name.toLowerCase().includes(query);
    return matchCat && matchBrand && matchStore && matchQ;
  });

  if (sort === "price-asc") {
    products.sort((a, b) => Number(a.best.total_price_cad) - Number(b.best.total_price_cad));
  } else if (sort === "unit-asc") {
    products.sort(
      (a, b) =>
        Number(a.best.unit_price_per_100_cad ?? 999999) -
        Number(b.best.unit_price_per_100_cad ?? 999999)
    );
  } else if (sort === "savings-desc") {
    products.sort((a, b) => b.savings - a.savings);
  }

  if (!products.length) {
    grid.innerHTML = `
      <div class="card">
        <p class="subtitle" style="margin:0 0 10px;">No matching products found.</p>
        <button class="btn-primary" onclick="resetFilters()">Clear Filters</button>
      </div>`;
    return;
  }

  grid.innerHTML = products
    .map((p) => {
      const sizeLabel = p.size_unit === "unit" ? "1 Unit" : `${p.size_value} ${p.size_unit}`;
      const unitPill = p.best.unit_price_per_100_cad
        ? `<span class="unit-pill">$${Number(p.best.unit_price_per_100_cad).toFixed(2)} CAD / 100 ${p.size_unit}</span>`
        : "";
      const savingsBadge =
        p.savings >= 1
          ? `<span style="display:inline-block;margin-top:6px;margin-left:6px;font-size:12px;font-weight:700;background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:6px;">Save $${p.savings.toFixed(2)} CAD</span>`
          : "";
      const lowBadge = p.isNinetyDayLow
        ? `<span style="display:inline-block;margin-top:6px;margin-left:6px;font-size:11px;font-weight:700;background:#fef3c7;color:#92400e;padding:2px 7px;border-radius:6px;">90-Day Low</span>`
        : "";
      const imgHtml = p.image_url
        ? `<img src="${p.image_url}" alt="${p.brand} ${p.name}" loading="lazy" onerror="this.style.display='none'" style="width:100%;height:170px;object-fit:contain;margin-bottom:10px;border-radius:8px;background:#fff;" />`
        : "";
      return `
      <article class="card">
        <div>
          ${imgHtml}
          <div class="card-brand">${p.brand}</div>
          <h2 class="card-title">${p.name}</h2>
          <div class="card-meta">${p.category_name} • ${sizeLabel} • ${p.listings.length} store(s) • Updated ${p.updatedLabel}</div>
        </div>
        <div>
          <div class="price-box">
            <div class="best-price">$${Number(p.best.total_price_cad).toFixed(2)} CAD</div>
            <div class="best-store">Best at <strong>${p.best.store_name}</strong></div>
            <div>${unitPill}${savingsBadge}${lowBadge}</div>
          </div>
          <button class="btn-primary" style="width:100%;margin-top:10px;" onclick="openProductModal('${p.product_id}')">
            Compare Stores &amp; History
          </button>
        </div>
      </article>`;
    })
    .join("");
}

window.resetFilters = function () {
  activeCategory = "all";
  activeBrand = "all";
  activeStore = "all";
  document.getElementById("searchInput").value = "";
  document.getElementById("sortSelect").value = "featured";
  renderTabs();
  populateFilterDropdowns();
  renderProducts();
};

window.openProductModal = async function (productId) {
  const products = groupByProduct(allRows);
  const product = products.find((p) => p.product_id === productId);
  if (!product) return;

  const url = new URL(window.location);
  url.searchParams.set("product", product.slug);
  window.history.replaceState({}, "", url);

  document.getElementById("modalHeader").innerHTML = `
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
      ${
        product.image_url
          ? `<img src="${product.image_url}" alt="${product.name}" onerror="this.style.display='none'" style="width:84px;height:84px;object-fit:contain;border-radius:8px;border:1px solid #e2e8f0;background:#fff;padding:4px;" />`
          : ""
      }
      <div>
        <div class="card-brand">${product.brand}</div>
        <h2 style="margin:4px 0 4px;">${product.name}</h2>
        <p class="subtitle" style="margin:0;">All prices in CAD • Ships from Canada • ${
          product.savings >= 1
            ? `<strong>Save up to $${product.savings.toFixed(2)} CAD</strong> by comparing`
            : "Verified Canadian retailers"
        }</p>
      </div>
    </div>
  `;

  document.getElementById("modalTableBody").innerHTML = product.listings
    .map(
      (l, idx) => `
      <tr>
        <td><strong>${l.store_name}</strong> ${idx === 0 ? '<span style="font-size:11px;background:#dcfce7;color:#15803d;padding:2px 6px;border-radius:6px;font-weight:700;">Best</span>' : ""}</td>
        <td>$${Number(l.current_price_cad).toFixed(2)} CAD</td>
        <td>${Number(l.shipping_cost_cad) === 0 ? "Free" : `$${Number(l.shipping_cost_cad).toFixed(2)} CAD`}</td>
        <td><strong>$${Number(l.total_price_cad).toFixed(2)} CAD</strong></td>
        <td>${l.unit_price_per_100_cad ? `$${Number(l.unit_price_per_100_cad).toFixed(2)}` : "—"}</td>
        <td>${l.in_stock ? "In Stock" : "Out of Stock"}</td>
        <td><a class="btn-primary" href="${l.target_url}" target="_blank" rel="noopener noreferrer" onclick="logStoreClick('${product.product_id}','${product.slug}','${l.store_name}')">Visit Store</a></td>
      </tr>`
    )
    .join("");

  const similar = products
    .filter((p) => p.category_slug === product.category_slug && p.product_id !== product.product_id)
    .slice(0, 3);

  let similarContainer = document.getElementById("similarProductsSection");
  if (!similarContainer) {
    similarContainer = document.createElement("div");
    similarContainer.id = "similarProductsSection";
    document.querySelector("#productModal .modal-body").appendChild(similarContainer);
  }

  if (similar.length) {
    similarContainer.innerHTML = `
      <h3 style="margin-top:24px;">Similar Products in ${product.category_name}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;">
        ${similar
          .map(
            (s) => `
          <div onclick="openProductModal('${s.product_id}')" style="cursor:pointer;border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#f8fafc;">
            <div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;">${s.brand}</div>
            <div style="font-size:14px;font-weight:700;margin:4px 0;">${s.name}</div>
            <div style="font-size:15px;font-weight:800;color:#15803d;">$${Number(s.best.total_price_cad).toFixed(2)} CAD</div>
            <div style="font-size:12px;color:#475569;">at ${s.best.store_name}</div>
          </div>`
          )
          .join("")}
      </div>
    `;
  } else {
    similarContainer.innerHTML = "";
  }

  document.getElementById("productModal").classList.remove("hidden");

  const listingIds = product.listings.map((l) => l.listing_id);
  const { data: history } = await sb
    .from("price_history")
    .select("*")
    .in("listing_id", listingIds)
    .order("recorded_at", { ascending: true });

  const allDates = Array.from(
    new Set((history || []).map((h) => new Date(h.recorded_at).toLocaleDateString("en-CA")))
  );

  const datasets = product.listings
    .map((l) => {
      const storeHistory = (history || []).filter((h) => h.listing_id === l.listing_id);
      if (!storeHistory.length) return null;
      const byDate = new Map(
        storeHistory.map((h) => [
          new Date(h.recorded_at).toLocaleDateString("en-CA"),
          Number(h.price_cad),
        ])
      );
      const color = STORE_COLORS[l.store_name] || "#64748b";
      return {
        label: `${l.store_name} (CAD)`,
        data: allDates.map((d) => byDate.get(d) ?? null),
        borderColor: color,
        backgroundColor: `${color}22`,
        spanGaps: true,
        tension: 0.25,
      };
    })
    .filter(Boolean);

  const ctx = document.getElementById("priceChart").getContext("2d");
  if (priceChartInstance) priceChartInstance.destroy();
  priceChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: allDates,
      datasets,
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
};

function closeProductModal() {
  document.getElementById("productModal").classList.add("hidden");
  const url = new URL(window.location);
  url.searchParams.delete("product");
  window.history.replaceState({}, "", url);
}

async function init() {
  try {
    if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR_PROJECT_ID")) {
      throw new Error("Update config.js with your Supabase Project URL and Publishable Key.");
    }
    const { createClient } = await loadSupabaseSDK();
    sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

    const [catRes, prodRes, histRes] = await Promise.all([
      sb.from("categories").select("*").order("sort_order", { ascending: true }),
      sb.from("v_product_comparison").select("*"),
      sb.from("price_history").select("listing_id,price_cad"),
    ]);

    if (catRes.error) throw catRes.error;
    if (prodRes.error) throw prodRes.error;

    minPriceByListing = new Map();
    for (const h of histRes.data || []) {
      const val = Number(h.price_cad);
      const prev = minPriceByListing.get(h.listing_id);
      if (prev === undefined || val < prev) {
        minPriceByListing.set(h.listing_id, val);
      }
    }

    allCategories = catRes.data || [];
    allRows = prodRes.data || [];
    ensureFilterControls();
    renderTopDeals();
    renderTabs();
    populateFilterDropdowns();
    renderProducts();

    const targetSlug = new URLSearchParams(window.location.search).get("product");
    if (targetSlug) {
      const match = groupByProduct(allRows).find((p) => p.slug === targetSlug);
      if (match) window.openProductModal(match.product_id);
    }
  } catch (err) {
    document.getElementById("productGrid").innerHTML = `
      <div class="card">
        <h3>Connection Notice</h3>
        <p class="subtitle">${err.message || "Unable to load products from Supabase."}</p>
      </div>`;
  }
}

document.getElementById("searchInput").addEventListener("input", renderProducts);
document.getElementById("sortSelect").addEventListener("change", renderProducts);
document.getElementById("closeModal").addEventListener("click", closeProductModal);
document.getElementById("closeWaitlist").addEventListener("click", () => {
  document.getElementById("waitlistModal").classList.add("hidden");
});
document.getElementById("waitlistForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("waitlistEmail").value.trim();
  const msg = document.getElementById("waitlistMsg");
  try {
    const { error } = await sb
      .from("category_waitlist")
      .insert({ category_slug: activeWaitlistSlug, email });
    msg.textContent = !error
      ? "Thanks! You are on the Canadian launch waitlist."
      : "You are already subscribed or an error occurred.";
    document.getElementById("waitlistEmail").value = "";
  } catch {
    msg.textContent = "Unable to save right now. Please try again.";
  }
});

init();
