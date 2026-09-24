/* =========================================================================
   CineMetrics — pure HTML/CSS/JS build.
   Everything the original FastAPI + SQLite backend did (catalog, seat
   booking, analytics, auth, live sync across windows) now happens in the
   browser: the "database" is a JSON blob in localStorage, and "the
   websocket" is a BroadcastChannel that every open tab on this page listens
   to. There is no server and nothing ever leaves this browser.
   ========================================================================= */

const DB_KEY = "cinemetrics_db";
const SESSION_KEY = "cinemetrics_session";
const THEME_KEY = "cm_theme";
const CHANNEL_NAME = "cinemetrics_live";

let DB = null;
let authMode = "login";
let currentMovie = null;
let selectedSeats = new Map(); // id -> section
let charts = {};

/* ---------------- generic helpers ---------------- */
function $(id) { return document.getElementById(id); }
function fmtMoney(n) {
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}
function showToast(msg) {
  const t = $("toast");
  $("toastMsg").textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}

/* ---------------- tiny seeded RNG (mulberry32) ----------------
   Only used once, to generate the starting catalog deterministically -
   mirrors the original `random.Random(42)` seeding, just in JS. */
function makeRNG(seed) {
  let s = seed >>> 0;
  function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    random: next,
    choice: (arr) => arr[Math.floor(next() * arr.length)],
    uniform: (a, b) => a + next() * (b - a),
    randint: (a, b) => a + Math.floor(next() * (b - a + 1)),
  };
}

/* ---------------- password hashing (client-only demo) ----------------
   There's no server here, so there is no real threat model - anything a
   user types is only ever stored in their own browser's localStorage.
   We still salt + hash rather than storing plaintext, using SubtleCrypto
   where available and falling back to a small deterministic hash
   otherwise (e.g. very old browsers, or restrictive file:// contexts). */
async function sha256Hex(str) {
  if (window.crypto && crypto.subtle && crypto.subtle.digest) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067) >>> 0;
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233) >>> 0;
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213) >>> 0;
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179) >>> 0;
  return [h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, "0")).join("");
}
function randomSaltHex(bytes = 8) {
  const arr = crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(bytes)) : [Date.now() % 256];
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password, saltHex) {
  const salt = saltHex || randomSaltHex();
  const digest = await sha256Hex(salt + ":" + password);
  return `${salt}$${digest}`;
}
async function verifyPassword(password, stored) {
  const [salt, digest] = (stored || "").split("$");
  if (!salt || !digest) return false;
  const check = await sha256Hex(salt + ":" + password);
  return check === digest;
}

/* ---------------- seed data (mirrors app/database.py) ---------------- */
const GENRES = ["Drama", "Action", "Comedy", "Romance", "Animation", "Thriller", "Sci-Fi", "Documentary"];
const PLATFORMS = ["Netflix", "Prime Video", "Disney+", "HBO Max", "Apple TV+", "Mubi"];
const LANGUAGES = ["English", "Hindi", "Spanish", "Korean", "French", "Japanese"];
const DIRECTORS = ["Ishita Mehta", "Kabir Malhotra", "Arjun Rao", "Mira Sen", "Mateo Silva", "Daniel Kim"];
const TITLE_STEMS = [
  "The Glass Province", "A Thousand Roads", "A Map of Tomorrow", "Velvet Revolution",
  "Echoes of July", "Midnight Assembly", "The Wild Orchard", "Northbound",
  "The Last Meridian", "Neon Horizon", "The Long Detour", "After the Monsoon",
  "Paper Satellites", "Crimson Harbor", "Silent Cartography", "The Hollow Choir",
];
const SECTIONS = [
  ["front", 2, 8],
  ["middle", 3, 10],
  ["back", 2, 10],
];

function roundTo(n, step) {
  return Math.round(n / step) * step;
}

async function buildSeedDB() {
  const rng = makeRNG(42);
  const movies = [];
  for (let i = 0; i < 48; i++) {
    const stem = TITLE_STEMS[i % TITLE_STEMS.length];
    const suffix = Math.floor(i / TITLE_STEMS.length) + 1;
    const title = suffix === 1 ? stem : `${stem} ${suffix}`;
    const budget = roundTo(rng.uniform(5_000_000, 140_000_000), 1000);
    const box_office = roundTo(budget * rng.uniform(1.1, 3.4), 1000);
    movies.push({
      id: i + 1,
      title,
      genre: rng.choice(GENRES),
      director: rng.choice(DIRECTORS),
      language: rng.choice(LANGUAGES),
      platform: rng.choice(PLATFORMS),
      year: rng.choice([2012, 2019]),
      runtime: rng.randint(90, 175),
      imdb_rating: Math.round(rng.uniform(6.0, 9.3) * 10) / 10,
      budget,
      box_office,
      ticket_price: Math.round(rng.uniform(8, 20) * 100) / 100,
      featured: i === 0 ? 1 : 0,
    });
  }

  const seats = [];
  let seatId = 1;
  movies.forEach((movie) => {
    SECTIONS.forEach(([section, rows, perRow]) => {
      for (let r = 0; r < rows; r++) {
        const row_label = String.fromCharCode(65 + r);
        for (let n = 1; n <= perRow; n++) {
          seats.push({
            id: seatId++,
            movie_id: movie.id,
            section,
            row_label,
            seat_number: n,
            booked: rng.random() < 0.12 ? 1 : 0,
            booked_by: null,
          });
        }
      }
    });
  });

  const admin = {
    id: 1,
    username: "admin",
    password_hash: await hashPassword("admin123"),
    role: "admin",
  };

  return {
    movies,
    seats,
    bookings: [],
    users: [admin],
    nextUserId: 2,
    nextBookingId: 1,
  };
}

/* ---------------- persistence ---------------- */
function loadDB() {
  const raw = localStorage.getItem(DB_KEY);
  return raw ? JSON.parse(raw) : null;
}
function saveDB(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}
async function ensureDB() {
  let db = loadDB();
  if (!db) {
    db = await buildSeedDB();
    saveDB(db);
  }
  return db;
}

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}
function saveSession(user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/* ---------------- "API" layer (mirrors app/main.py) ---------------- */
async function registerUser(username, password) {
  if (username.trim().length < 3 || password.length < 4) {
    throw new Error("Username needs 3+ characters, password 4+ characters");
  }
  if (DB.users.some((u) => u.username === username)) {
    throw new Error("That username is taken");
  }
  const user = {
    id: DB.nextUserId++,
    username,
    password_hash: await hashPassword(password),
    role: "user",
  };
  DB.users.push(user);
  saveDB(DB);
  return { id: user.id, username: user.username, role: user.role };
}

async function loginUser(username, password) {
  const user = DB.users.find((u) => u.username === username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new Error("Incorrect username or password");
  }
  return { id: user.id, username: user.username, role: user.role };
}

function filterMovies(list, filters) {
  let out = list;
  if (filters.genre) out = out.filter((m) => m.genre === filters.genre);
  if (filters.platform) out = out.filter((m) => m.platform === filters.platform);
  if (filters.language) out = out.filter((m) => m.language === filters.language);
  if (filters.min_rating) out = out.filter((m) => m.imdb_rating >= filters.min_rating);
  if (filters.search) {
    const q = filters.search.toLowerCase();
    out = out.filter((m) => m.title.toLowerCase().includes(q) || m.director.toLowerCase().includes(q));
  }
  return out;
}

function getMovies(filters = {}) {
  let list = filterMovies(DB.movies.slice(), filters);
  const sortCol = ["imdb_rating", "year", "box_office", "title", "runtime"].includes(filters.sort)
    ? filters.sort
    : "imdb_rating";
  list = list.slice().sort((a, b) => {
    if (sortCol === "title") return String(b.title).localeCompare(a.title);
    return b[sortCol] - a[sortCol];
  });
  return { count: list.length, movies: list };
}

function getSeats(movieId) {
  return DB.seats
    .filter((s) => s.movie_id === movieId)
    .slice()
    .sort((a, b) =>
      a.section === b.section
        ? a.row_label === b.row_label
          ? a.seat_number - b.seat_number
          : a.row_label.localeCompare(b.row_label)
        : a.section.localeCompare(b.section)
    );
}

function bookSeats(movieId, seatIds, user) {
  if (!seatIds.length) throw new Error("Pick at least one seat");
  const movie = DB.movies.find((m) => m.id === movieId);
  if (!movie) throw new Error("Movie not found");

  const seats = DB.seats.filter((s) => seatIds.includes(s.id) && s.movie_id === movieId);
  if (seats.length !== seatIds.length) throw new Error("One or more seats don't exist for this movie");

  const already = seats.filter((s) => s.booked).map((s) => s.id);
  if (already.length) {
    throw new Error(`Seat(s) ${already.join(", ")} were just booked by someone else - pick another seat`);
  }

  seats.forEach((seat) => {
    seat.booked = 1;
    seat.booked_by = user.id;
    DB.bookings.push({
      id: DB.nextBookingId++,
      user_id: user.id,
      movie_id: movieId,
      seat_id: seat.id,
      section: seat.section,
      price: movie.ticket_price,
    });
  });
  saveDB(DB);
  return { booked: seatIds, movie: movie.title };
}

/* ---------------- analytics (mirrors app/analytics.py) ---------------- */
function emptyAnalytics() {
  return {
    movies_tracked: 0, avg_rating: 0, avg_runtime: 0, total_box_office: 0,
    genre_composition: [], release_timeline: [], language_distribution: [],
    rating_distribution: { "<6": 0, "6-6.9": 0, "7-7.9": 0, "8-8.9": 0, "9+": 0 },
    budget_vs_box_office: [], avg_rating_by_genre: [], tickets_by_movie: {},
    tickets_by_section: {}, total_tickets_sold: 0, ticket_revenue: 0, top_selling: [],
  };
}

function computeAnalytics(filters = {}) {
  const movies = filterMovies(DB.movies.slice(), filters);
  if (!movies.length) return emptyAnalytics();
  const ids = new Set(movies.map((m) => m.id));
  const seats = DB.seats.filter((s) => ids.has(s.movie_id));

  const genreCounts = {};
  movies.forEach((m) => (genreCounts[m.genre] = (genreCounts[m.genre] || 0) + 1));
  const genre_composition = Object.entries(genreCounts)
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count);

  const yearCounts = {};
  movies.forEach((m) => (yearCounts[m.year] = (yearCounts[m.year] || 0) + 1));
  const release_timeline = Object.entries(yearCounts)
    .map(([year, count]) => ({ year: Number(year), count }))
    .sort((a, b) => a.year - b.year);

  const langCounts = {};
  movies.forEach((m) => (langCounts[m.language] = (langCounts[m.language] || 0) + 1));
  const language_distribution = Object.entries(langCounts)
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count);

  const rating_distribution = { "<6": 0, "6-6.9": 0, "7-7.9": 0, "8-8.9": 0, "9+": 0 };
  movies.forEach((m) => {
    const r = m.imdb_rating;
    if (r < 6) rating_distribution["<6"]++;
    else if (r < 7) rating_distribution["6-6.9"]++;
    else if (r < 8) rating_distribution["7-7.9"]++;
    else if (r < 9) rating_distribution["8-8.9"]++;
    else rating_distribution["9+"]++;
  });

  const budget_vs_box_office = movies.map((m) => ({
    budget: m.budget, box_office: m.box_office, title: m.title,
  }));

  const genreRatingSums = {}, genreRatingCounts = {};
  movies.forEach((m) => {
    genreRatingSums[m.genre] = (genreRatingSums[m.genre] || 0) + m.imdb_rating;
    genreRatingCounts[m.genre] = (genreRatingCounts[m.genre] || 0) + 1;
  });
  const avg_rating_by_genre = Object.keys(genreRatingSums)
    .map((genre) => ({
      genre,
      avg_rating: Math.round((genreRatingSums[genre] / genreRatingCounts[genre]) * 100) / 100,
    }))
    .sort((a, b) => b.avg_rating - a.avg_rating);

  const tickets_by_movie = {};
  movies.forEach((m) => {
    const ms = seats.filter((s) => s.movie_id === m.id);
    tickets_by_movie[m.id] = {
      movie_id: m.id,
      booked_seats: ms.filter((s) => s.booked).length,
      total_seats: ms.length,
    };
  });

  const tickets_by_section = {};
  ["front", "middle", "back"].forEach((section) => {
    const ss = seats.filter((s) => s.section === section);
    tickets_by_section[section] = {
      section,
      booked_seats: ss.filter((s) => s.booked).length,
      total_seats: ss.length,
    };
  });

  const total_tickets_sold = seats.filter((s) => s.booked).length;
  const priceByMovie = {};
  movies.forEach((m) => (priceByMovie[m.id] = m.ticket_price));
  const ticket_revenue =
    Math.round(
      seats.filter((s) => s.booked).reduce((sum, s) => sum + (priceByMovie[s.movie_id] || 0), 0) * 100
    ) / 100;

  const soldByMovie = {};
  seats.forEach((s) => {
    if (s.booked) soldByMovie[s.movie_id] = (soldByMovie[s.movie_id] || 0) + 1;
  });
  const top_selling = movies
    .map((m) => ({ id: m.id, title: m.title, sold: soldByMovie[m.id] || 0 }))
    .sort((a, b) => b.sold - a.sold)
    .slice(0, 5);

  const avg_rating = Math.round((movies.reduce((s, m) => s + m.imdb_rating, 0) / movies.length) * 100) / 100;
  const avg_runtime = Math.round((movies.reduce((s, m) => s + m.runtime, 0) / movies.length) * 10) / 10;
  const total_box_office = movies.reduce((s, m) => s + m.box_office, 0);

  return {
    movies_tracked: movies.length, avg_rating, avg_runtime, total_box_office,
    genre_composition, release_timeline, language_distribution, rating_distribution,
    budget_vs_box_office, avg_rating_by_genre, tickets_by_movie, tickets_by_section,
    total_tickets_sold, ticket_revenue, top_selling,
  };
}

/* ---------------- theme ---------------- */
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  $("themeToggle").textContent = saved === "dark" ? "\u263D" : "\u2600";
}
$("themeToggle").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
  $("themeToggle").textContent = next === "dark" ? "\u263D" : "\u2600";
  renderAllCharts(window.lastAnalytics || {});
};

/* ---------------- routing ---------------- */
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("view-" + name).classList.add("active");
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  if (name === "catalog") loadMovies();
  if (name === "analytics") loadAnalytics();
}
document.querySelectorAll("[data-view]").forEach((el) => {
  el.addEventListener("click", (e) => { e.preventDefault(); showView(el.dataset.view); });
});

/* ---------------- auth ---------------- */
function refreshAuthButton() {
  const session = getSession();
  $("authBtn").textContent = session ? `Sign out (${session.username})` : "Sign in";
}
$("authBtn").onclick = () => {
  const session = getSession();
  if (session) {
    clearSession();
    refreshAuthButton();
    showToast("Signed out");
  } else {
    openAuthModal("login");
  }
};
function openAuthModal(mode) {
  authMode = mode;
  $("authTitle").textContent = mode === "login" ? "Sign in" : "Create an account";
  $("authSubmit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("authSwitch").textContent = mode === "login" ? "Create an account" : "Have an account? Sign in";
  $("authError").textContent = "";
  $("authUsername").value = "";
  $("authPassword").value = "";
  $("authModal").classList.add("open");
}
$("closeAuth").onclick = () => $("authModal").classList.remove("open");
$("authSwitch").onclick = (e) => { e.preventDefault(); openAuthModal(authMode === "login" ? "register" : "login"); };
$("authSubmit").onclick = async () => {
  const username = $("authUsername").value.trim();
  const password = $("authPassword").value;
  try {
    const user = authMode === "login" ? await loginUser(username, password) : await registerUser(username, password);
    saveSession(user);
    refreshAuthButton();
    $("authModal").classList.remove("open");
    showToast(`Welcome, ${user.username}`);
  } catch (err) {
    $("authError").textContent = err.message;
  }
};

/* ---------------- catalog ---------------- */
function populateFilterOptions() {
  const genres = [...new Set(DB.movies.map((m) => m.genre))].sort();
  const langs = [...new Set(DB.movies.map((m) => m.language))].sort();
  const platforms = [...new Set(DB.movies.map((m) => m.platform))].sort();
  fillSelect("fGenre", genres);
  fillSelect("fLanguage", langs);
  fillSelect("fPlatform", platforms);
}
function fillSelect(id, values) {
  const sel = $(id);
  values.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v;
    sel.appendChild(opt);
  });
}
function loadMovies() {
  const filters = {
    search: $("fSearch").value || undefined,
    genre: $("fGenre").value || undefined,
    language: $("fLanguage").value || undefined,
    platform: $("fPlatform").value || undefined,
    min_rating: $("fRating").value ? Number($("fRating").value) : undefined,
    sort: $("fSort").value,
  };
  const data = getMovies(filters);
  $("resultCount").textContent = `${data.count} films in view`;
  const grid = $("movieGrid");
  grid.innerHTML = "";
  data.movies.forEach((m) => grid.appendChild(movieCard(m)));
}
function movieCard(m) {
  const div = document.createElement("div");
  div.className = "card";
  div.innerHTML = `
    <div class="thumb">
      <span class="rating">\u2605 ${m.imdb_rating}</span>
      ${m.featured ? '<span class="pill" style="background:var(--accent);color:#fff;">Featured</span>' : ""}
    </div>
    <div class="meta">${m.year} · ${m.runtime} min</div>
    <div class="title">${m.title}</div>
    <div class="sub">${m.genre} · ${m.director}</div>
    <div class="foot">
      <span class="platform">${m.platform}</span>
      <span class="box">${fmtMoney(m.box_office)}</span>
    </div>
    <div class="book-link"><button class="btn btn-primary" data-book="${m.id}">Book tickets</button></div>
  `;
  div.querySelector("[data-book]").onclick = () => openBooking(m);
  return div;
}
["fSearch", "fGenre", "fLanguage", "fPlatform", "fRating", "fSort"].forEach((id) => {
  $(id).addEventListener("input", loadMovies);
  $(id).addEventListener("change", loadMovies);
});

/* ---------------- booking ---------------- */
function openBooking(movie) {
  currentMovie = movie;
  selectedSeats.clear();
  $("bookMovieMeta").textContent = `${movie.genre.toUpperCase()} · BOOK TICKETS`;
  $("bookMovieTitle").textContent = movie.title;
  $("summaryPrice").textContent = "$" + movie.ticket_price.toFixed(2);
  showView("booking");
  renderSeatMap(getSeats(movie.id));
  updateSummary();
}
function renderSeatMap(seats) {
  const bySection = { front: {}, middle: {}, back: {} };
  seats.forEach((s) => {
    bySection[s.section][s.row_label] = bySection[s.section][s.row_label] || [];
    bySection[s.section][s.row_label].push(s);
  });
  const wrap = $("seatMap");
  wrap.innerHTML = "";
  ["front", "middle", "back"].forEach((section) => {
    const rows = bySection[section];
    if (!rows || !Object.keys(rows).length) return;
    const box = document.createElement("div");
    box.className = "seat-section";
    box.innerHTML = `<h4>${section}</h4>`;
    Object.keys(rows).sort().forEach((rowLabel) => {
      const rowDiv = document.createElement("div");
      rowDiv.className = "seat-row";
      rowDiv.innerHTML = `<span class="row-label">${rowLabel}</span>`;
      rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number).forEach((seat) => {
        const btn = document.createElement("button");
        btn.className = "seat " + (seat.booked ? "booked" : "available");
        btn.textContent = seat.seat_number;
        btn.dataset.seatId = seat.id;
        if (selectedSeats.has(seat.id)) btn.classList.add("selected");
        if (!seat.booked) {
          btn.onclick = () => toggleSeat(seat, btn);
        }
        rowDiv.appendChild(btn);
      });
      box.appendChild(rowDiv);
    });
    wrap.appendChild(box);
  });
}
function toggleSeat(seat, btn) {
  if (selectedSeats.has(seat.id)) {
    selectedSeats.delete(seat.id);
    btn.classList.remove("selected");
  } else {
    selectedSeats.set(seat.id, seat.section);
    btn.classList.add("selected");
  }
  updateSummary();
}
function updateSummary() {
  const price = currentMovie ? currentMovie.ticket_price : 0;
  const n = selectedSeats.size;
  $("summarySeats").textContent = n ? `${n} seat(s) selected` : "None selected yet";
  $("summaryTotal").textContent = "$" + (price * n).toFixed(2);
}
$("confirmBooking").onclick = () => {
  const session = getSession();
  if (!session) { openAuthModal("login"); showToast("Sign in to book seats"); return; }
  if (!selectedSeats.size) { showToast("Pick at least one seat"); return; }
  try {
    bookSeats(currentMovie.id, [...selectedSeats.keys()], session);
    showToast(`Booked ${selectedSeats.size} seat(s) for ${currentMovie.title}`);
    selectedSeats.clear();
    renderSeatMap(getSeats(currentMovie.id));
    updateSummary();

    const analytics = computeAnalytics();
    window.lastAnalytics = analytics;
    broadcastEvent("seats_booked", { movie_id: currentMovie.id, seat_ids: [], booked_by: session.username });
    broadcastEvent("analytics_update", analytics);
  } catch (err) {
    showToast(err.message);
  }
};

/* ---------------- analytics + charts ---------------- */
function chartColors() {
  const dark = document.documentElement.getAttribute("data-theme") !== "light";
  return {
    text: dark ? "#9a9aa5" : "#55534d",
    grid: dark ? "#26262b" : "#e4e2dc",
    accent: "#ff3b3b",
    palette: ["#ff3b3b", "#38bdf8", "#34d399", "#facc15", "#a78bfa", "#fb923c", "#f472b6", "#94a3b8"],
  };
}
function baseOptions() {
  const c = chartColors();
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false, labels: { color: c.text } } },
    scales: {
      x: { ticks: { color: c.text }, grid: { color: c.grid } },
      y: { ticks: { color: c.text }, grid: { color: c.grid } },
    },
  };
}
function upsertChart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id).getContext("2d"), config);
}
function renderAllCharts(a) {
  if (!a || !a.genre_composition) return;
  const c = chartColors();

  upsertChart("chartGenre", { type: "bar", data: {
    labels: a.genre_composition.map((x) => x.genre),
    datasets: [{ data: a.genre_composition.map((x) => x.count), backgroundColor: c.accent, borderRadius: 6 }],
  }, options: baseOptions() });

  upsertChart("chartYear", { type: "line", data: {
    labels: a.release_timeline.map((x) => x.year),
    datasets: [{ data: a.release_timeline.map((x) => x.count), borderColor: "#facc15", backgroundColor: "#facc15", tension: 0.3 }],
  }, options: baseOptions() });

  upsertChart("chartLang", { type: "doughnut", data: {
    labels: a.language_distribution.map((x) => x.language),
    datasets: [{ data: a.language_distribution.map((x) => x.count), backgroundColor: c.palette }],
  }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { color: c.text } } } } });

  const rd = a.rating_distribution;
  upsertChart("chartRatingDist", { type: "bar", data: {
    labels: Object.keys(rd), datasets: [{ data: Object.values(rd), backgroundColor: "#38bdf8", borderRadius: 6 }],
  }, options: baseOptions() });

  upsertChart("chartBudget", { type: "scatter", data: {
    datasets: [{ data: a.budget_vs_box_office.map((x) => ({ x: x.budget, y: x.box_office })), backgroundColor: "#34d399" }],
  }, options: baseOptions() });

  upsertChart("chartGenreRating", { type: "bar", data: {
    labels: a.avg_rating_by_genre.map((x) => x.genre),
    datasets: [{ data: a.avg_rating_by_genre.map((x) => x.avg_rating), backgroundColor: "#a78bfa", borderRadius: 6 }],
  }, options: { ...baseOptions(), indexAxis: "y" } });

  const sections = ["front", "middle", "back"];
  const sold = sections.map((s) => (a.tickets_by_section[s] || {}).booked_seats || 0);
  const total = sections.map((s) => (a.tickets_by_section[s] || {}).total_seats || 0);
  upsertChart("chartSection", { type: "bar", data: {
    labels: sections.map((s) => s[0].toUpperCase() + s.slice(1)),
    datasets: [
      { label: "Booked", data: sold, backgroundColor: c.accent, borderRadius: 6 },
      { label: "Capacity", data: total, backgroundColor: c.grid, borderRadius: 6 },
    ],
  }, options: { ...baseOptions(), plugins: { legend: { display: true, labels: { color: c.text } } } } });

  upsertChart("chartTopSelling", { type: "bar", data: {
    labels: a.top_selling.map((x) => x.title),
    datasets: [{ data: a.top_selling.map((x) => x.sold), backgroundColor: "#fb923c", borderRadius: 6 }],
  }, options: { ...baseOptions(), indexAxis: "y" } });

  $("statMovies").textContent = a.movies_tracked;
  $("statRating").textContent = a.avg_rating.toFixed(2) + "/10";
  $("statBox").textContent = fmtMoney(a.total_box_office);
  $("statTickets").textContent = a.total_tickets_sold;
  $("statRevenue").textContent = fmtMoney(a.ticket_revenue) + " revenue";
}
function loadAnalytics() {
  const data = computeAnalytics();
  window.lastAnalytics = data;
  renderAllCharts(data);
}

/* ---------------- live sync across tabs/windows ----------------
   Replaces the WebSocket: a BroadcastChannel connects every tab that has
   this page open on the same browser, so booking a seat in one window
   updates the seat map and every chart in every other open window,
   instantly, with no server involved. A `storage` listener is kept as a
   fallback for browsers without BroadcastChannel support. */
let liveChannel = null;
try { liveChannel = new BroadcastChannel(CHANNEL_NAME); } catch (e) { liveChannel = null; }

function broadcastEvent(event, data) {
  if (liveChannel) liveChannel.postMessage({ event, data });
}
function handleLiveEvent(msg) {
  DB = loadDB(); // pick up the writer tab's changes
  if (msg.event === "analytics_update") {
    window.lastAnalytics = msg.data;
    if ($("view-analytics").classList.contains("active")) renderAllCharts(msg.data);
  }
  if (msg.event === "seats_booked") {
    if (currentMovie && msg.data.movie_id === currentMovie.id) {
      renderSeatMap(getSeats(currentMovie.id));
      showToast(`${msg.data.booked_by} just booked seat(s) on this movie`);
    }
  }
}
if (liveChannel) {
  liveChannel.onmessage = (evt) => handleLiveEvent(evt.data);
}
window.addEventListener("storage", (e) => {
  if (e.key === DB_KEY && e.newValue) {
    DB = JSON.parse(e.newValue);
    if (currentMovie && $("view-booking").classList.contains("active")) {
      renderSeatMap(getSeats(currentMovie.id));
    }
    if ($("view-analytics").classList.contains("active")) loadAnalytics();
  }
});

/* ---------------- init ---------------- */
(async function init() {
  DB = await ensureDB();
  initTheme();
  refreshAuthButton();
  populateFilterOptions();
  loadMovies();
  $("movieCount").textContent = `${DB.movies.length} films · one clear view`;
  $("wsStatus").textContent = "Live";
})();
