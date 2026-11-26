const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = window.LOONPRICE_CONFIG;

let sb = null;
let allCategories = [];
let allRows = [];
let activeCategory = "all";
let activeWaitlistSlug = "";
let priceChartInstance = null;

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
        ? `<div class="unit-pill">$${Number(p.best.unit_price_per_100_cad).toFixed(2)} CAD / 100 ${p.size_unit}</div>`
        : "";
      return `
      <article class="card">
        <div>
          <div class="card-brand">${p.brand}</div>
          <h2 class="card-title">${p.name}</h2>
          <div class="card-meta">${p.category_name} • ${sizeLabel} • ${p.listings.length} Canadian store(s)</div>
        </div>
        <div>
          <div class="price-box">
            <div class="best-price">$${Number(p.best.total_price_cad).toFixed(2)} CAD</div>
            <div class="best-store">Best at <strong>${p.best.store_name}</strong></div>
            ${unitPill}
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

  document.getElementById("modalHeader").innerHTML = `
    <div class="card-brand">${product.brand}</div>
    <h2 style="margin:4px 0 6px;">${product.name}</h2>
    <p class="subtitle">All prices in CAD • Ships from Canada</p>
  `;

  document.getElementById("modalTableBody").innerHTML = product.listings
    .map(
      (l) => `
      <tr>
        <td><strong>${l.store_name}</strong></td>
        <td>$${Number(l.current_price_cad).toFixed(2)} CAD</td>
        <td>${Number(l.shipping_cost_cad) === 0 ? "Free" : `$${Number(l.shipping_cost_cad).toFixed(2)} CAD`}</td>
        <td><strong>$${Number(l.total_price_cad).toFixed(2)} CAD</strong></td>
        <td>${l.unit_price_per_100_cad ? `$${Number(l.unit_price_per_100_cad).toFixed(2)}` : "—"}</td>
        <td>${l.in_stock ? "In Stock" : "Out of Stock"}</td>
        <td><a class="btn-primary" href="${l.target_url}" target="_blank" rel="noopener noreferrer">Visit Store</a></td>
      </tr>`
    )
    .join("");

  document.getElementById("productModal").classList.remove("hidden");

  const bestListingId = product.best.listing_id;
  const { data: history } = await sb
    .from("price_history")
    .select("*")
    .eq("listing_id", bestListingId)
    .order("recorded_at", { ascending: true });

  const ctx = document.getElementById("priceChart").getContext("2d");
  if (priceChartInstance) priceChartInstance.destroy();
  priceChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: (history || []).map((h) => new Date(h.recorded_at).toLocaleDateString("en-CA")),
      datasets: [
        {
          label: `${product.best.store_name} (CAD)`,
          data: (history || []).map((h) => Number(h.price_cad)),
          borderColor: "#d9232e",
          backgroundColor: "rgba(217, 35, 46, 0.12)",
          fill: true,
          tension: 0.25,
        },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
};

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
document.getElementById("closeModal").addEventListener("click", () => {
  document.getElementById("productModal").classList.add("hidden");
});
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
