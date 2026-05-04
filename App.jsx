// frontend/src/App.jsx
// React frontend for DealHunt
// Install: npm create vite@latest frontend -- --template react
// Then: npm install, then replace src/App.jsx with this file

import { useState, useEffect, useCallback } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

const SORT_OPTIONS = [
  { value: "discount",   label: "Biggest Discount" },
  { value: "price-asc",  label: "Price: Low → High" },
  { value: "price-desc", label: "Price: High → Low" },
  { value: "rating",     label: "Best Rated" },
  { value: "savings",    label: "Most Savings" },
  { value: "newest",     label: "Newest" },
];

export default function App() {
  const [deals, setDeals]       = useState([]);
  const [cats, setCats]         = useState(["All"]);
  const [activeCat, setActiveCat] = useState("All");
  const [sort, setSort]         = useState("discount");
  const [query, setQuery]       = useState("");
  const [primeOnly, setPrime]   = useState(false);
  const [loading, setLoading]   = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [error, setError]       = useState(null);

  // Load categories once
  useEffect(() => {
    fetch(`${API}/api/deals/categories`)
      .then(r => r.json())
      .then(d => setCats(d.categories))
      .catch(() => {});
  }, []);

  // Load deals on filter change
  const loadDeals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sort });
      if (activeCat !== "All") params.set("cat", activeCat);
      if (query.trim())        params.set("q", query.trim());
      if (primeOnly)           params.set("prime", "true");

      const res  = await fetch(`${API}/api/deals?${params}`);
      const data = await res.json();
      setDeals(data.deals);
      setUpdatedAt(data.updatedAt);
    } catch (e) {
      setError("Could not load deals. Is the API server running?");
    } finally {
      setLoading(false);
    }
  }, [activeCat, sort, query, primeOnly]);

  useEffect(() => { loadDeals(); }, [loadDeals]);

  function discount(d) { return Math.round((1 - d.price / d.was) * 100); }

  return (
    <div className="app">
      {/* Header */}
      <header>
        <div className="logo">Deal<span>Hunt</span></div>
        <div className="header-right">
          <span className="deal-count">{deals.length} deals</span>
          {updatedAt && (
            <span className="updated">
              Updated {new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      </header>

      {/* Hero */}
      <section className="hero">
        <h1>Best Amazon Deals,<br /><em>hunted daily</em></h1>
        <p>Our bot scans Amazon every 4 hours to find the biggest discounts across all categories.</p>
      </section>

      {/* Affiliate notice */}
      <div className="aff-notice">
        As an Amazon Associate, we earn from qualifying purchases.
      </div>

      {/* Controls */}
      <div className="controls">
        <input
          type="search"
          placeholder="Search deals…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <select value={sort} onChange={e => setSort(e.target.value)}>
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label className="prime-toggle">
          <input type="checkbox" checked={primeOnly} onChange={e => setPrime(e.target.checked)} />
          Prime only
        </label>
      </div>

      {/* Category pills */}
      <div className="cat-row">
        {cats.map(c => (
          <button
            key={c}
            className={`cat-pill${activeCat === c ? " active" : ""}`}
            onClick={() => setActiveCat(c)}
          >{c}</button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="loading">Loading deals…</div>
      ) : error ? (
        <div className="error">{error}</div>
      ) : deals.length === 0 ? (
        <div className="empty">No deals match your filters.</div>
      ) : (
        <div className="grid">
          {deals.map(deal => (
            <div key={deal.asin} className="card">
              {deal.image ? (
                <img className="card-img" src={deal.image} alt={deal.title} />
              ) : (
                <div className="card-img-placeholder">🛍</div>
              )}
              {deal.prime && <span className="badge-prime">prime</span>}
              <span className="badge-discount">-{discount(deal)}%</span>

              <div className="card-body">
                <div className="card-cat">{deal.cat}</div>
                <div className="card-title">{deal.title}</div>
                {deal.rating && (
                  <div className="card-rating">
                    {"★".repeat(Math.round(deal.rating))}{"☆".repeat(5 - Math.round(deal.rating))}
                    <span>{deal.rating} ({deal.reviews?.toLocaleString()})</span>
                  </div>
                )}
                <div className="card-price">
                  <span className="price-now">${deal.price.toFixed(2)}</span>
                  <span className="price-was">${deal.was.toFixed(2)}</span>
                  <span className="price-save">Save ${deal.savings.toFixed(2)}</span>
                </div>
                <a
                  className="cta-btn"
                  href={deal.url}
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                >
                  View on Amazon →
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      <footer>
        <p>DealHunt · Amazon Associate · Prices subject to change</p>
      </footer>
    </div>
  );
}
