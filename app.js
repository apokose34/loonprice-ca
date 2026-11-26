const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = window.LOONPRICE_CONFIG;

let sb = null;
let allCategories = [];
let allRows = [];
let activeCategory = "all";
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
  }
  return Array.from(map.values());
}

function renderTabs() {
  const nav = document.getElementById("categoryTabs");
  const buttons = [
    `<button class="tab-btn ${activeCategory === "all" ? "active" : ""}" data-slug="all">All Active Categories</button>`,
  ];
  for (const cat of allCategories) {
    if (cat.is_coming_soon) {
      buttons.push(
        `<button class="tab-btn" data-soon="${cat.slug}" data-title="${cat.name_en}">${cat.name_en}<span class="soon-badge">Soon</span></button>`
      );
    } else {
      buttons.push(
        `<button class="tab-btn ${activeCategory === cat.slug ? "active" : ""}" data-slug="${cat.slug}">${cat.name_en}</button>`
      );
    }
  }
  nav.innerHTML = buttons.join("");

  nav.querySelectorAll("[data-slug]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCategory = btn.dataset.slug;
      renderTabs();
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
    const matchQ =
      !query ||
      p.brand.toLowerCase().includes(query) ||
      p.name.toLowerCase().includes(query);
    return matchCat && matchQ;
  });

  if (sort === "price-asc") {
    products.sort((a, b) => Number(a.best.total_price_cad) - Number(b.best.total_price_cad));
  } else if (sort === "unit-asc") {
    products.sort(
      (a, b) =>
        Number(a.best.unit_price_per_100_cad ?? 999999) -
        Number(b.best.unit_price_per_100_cad ?? 999999)
    );
  }

  if (!products.length) {
    grid.innerHTML = `<p class="subtitle">No matching products found.</p>`;
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
      const imgHtml = p.image_url
        ? `<img src="${p.image_url}" alt="${p.brand} ${p.name}" loading="lazy" onerror="this.style.display='none'" style="width:100%;height:170px;object-fit:contain;margin-bottom:10px;border-radius:8px;background:#fff;" />`
        : "";
      return `
      <article class="card">
        <div>
          ${imgHtml}
          <div class="card-brand">${p.brand}</div>
          <h2 class="card-title">${p.name}</h2>
          <div class="card-meta">${p.category_name} • ${sizeLabel} • ${p.listings.length} Canadian store(s)</div>
        </div>
        <div>
          <div class="price-box">
            <div class="best-price">$${Number(p.best.total_price_cad).toFixed(2)} CAD</div>
            <div class="best-store">Best at <strong>${p.best.store_name}</strong></div>
            <div>${unitPill}${savingsBadge}</div>
          </div>
          <button class="btn-primary" style="width:100%;margin-top:10px;" onclick="openProductModal('${p.product_id}')">
            Compare Stores &amp; History
          </button>
        </div>
      </article>`;
    })
    .join("");
}

window.openProductModal = async function (productId) {
  const products = groupByProduct(allRows);
  const product = products.find((p) => p.product_id === productId);
  if (!product) return;

  // Update URL so users can copy & share direct product links
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
        <td><a class="btn-primary" href="${l.target_url}" target="_blank" rel="noopener noreferrer">Visit Store</a></td>
      </tr>`
    )
    .join("");

  // Render Similar Products in the same category
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

    const [catRes, prodRes] = await Promise.all([
      sb.from("categories").select("*").order("sort_order", { ascending: true }),
      sb.from("v_product_comparison").select("*"),
    ]);

    if (catRes.error) throw catRes.error;
    if (prodRes.error) throw prodRes.error;

    allCategories = catRes.data || [];
    allRows = prodRes.data || [];
    renderTabs();
    renderProducts();

    // Open product directly if ?product=slug is in URL
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
