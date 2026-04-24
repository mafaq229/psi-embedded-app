(() => {
  const models = window["powerbi-client"].models;
  const powerbi = window.powerbi;

  const APP = (() => {
    try {
      return JSON.parse(document.getElementById("__APP__").textContent);
    } catch {
      return {};
    }
  })();

  const container = document.getElementById("embedContainer");
  const embedCard = document.getElementById("embedCard");
  const emptyState = document.getElementById("emptyState");
  const loader = document.getElementById("loader");
  const loaderBar = document.getElementById("loaderBar");
  const currentName = document.getElementById("currentReportName");
  const currentType = document.getElementById("currentReportType");
  const metaStrip = document.getElementById("metaStrip");
  const metaReportId = document.getElementById("metaReportId");
  const metaToken = document.getElementById("metaToken");
  const refreshBtn = document.getElementById("refreshBtn");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const copyLinkBtn = document.getElementById("copyLinkBtn");
  const openInPbi = document.getElementById("openInPbi");
  const searchInput = document.getElementById("searchInput");
  const sidebarNav = document.getElementById("sidebarNav");
  const noMatch = document.getElementById("noMatch");
  const recentsGroup = document.getElementById("recentsGroup");
  const recentsList = document.getElementById("recentsList");
  const recentsCount = document.getElementById("recentsCount");
  const jumpback = document.getElementById("jumpback");
  const jumpbackCards = document.getElementById("jumpbackCards");
  const toastMount = document.getElementById("toastMount");

  const LS_RECENTS = "pbi:recents";
  const LS_COLLAPSED = "pbi:collapsed";
  const RECENTS_MAX = 5;

  let activeItem = null;
  let activeItemData = null;
  let keyboardIndex = -1;
  let tokenMintedAt = null;
  let metaTickHandle = null;

  // -------------------- Recents --------------------

  function loadRecents() {
    try {
      return JSON.parse(localStorage.getItem(LS_RECENTS)) || [];
    } catch {
      return [];
    }
  }

  function saveRecents(list) {
    localStorage.setItem(LS_RECENTS, JSON.stringify(list.slice(0, RECENTS_MAX)));
  }

  function pushRecent(entry) {
    const list = loadRecents().filter((r) => r.id !== entry.id);
    list.unshift({ ...entry, openedAt: Date.now() });
    saveRecents(list);
    renderRecents();
    renderJumpback();
  }

  function formatRelative(ts) {
    if (!ts) return "";
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function renderRecents() {
    const list = loadRecents();
    if (!list.length) {
      recentsGroup.hidden = true;
      return;
    }
    recentsGroup.hidden = false;
    recentsCount.textContent = list.length;
    recentsList.innerHTML = "";
    list.forEach((entry, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "report-item";
      btn.dataset.embedKind = entry.kind;
      btn.dataset.embedId = entry.id;
      btn.dataset.embedName = entry.name;
      if (entry.reportType) btn.dataset.reportType = entry.reportType;
      btn.style.setProperty("--stagger", `${i * 30}ms`);

      const dot = document.createElement("span");
      dot.className = "report-item__dot";
      if (entry.kind === "dashboard") dot.classList.add("report-item__dot--dashboard");
      else if (entry.reportType === "PaginatedReport") dot.classList.add("report-item__dot--paginated");
      dot.setAttribute("aria-hidden", "true");

      const name = document.createElement("span");
      name.className = "report-item__name";
      name.textContent = entry.name;

      const arrow = document.createElement("span");
      arrow.className = "report-item__arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      btn.append(dot, name, arrow);
      btn.addEventListener("click", () => onItemClick(btn));
      li.appendChild(btn);
      recentsList.appendChild(li);
    });
  }

  function renderJumpback() {
    const list = loadRecents().slice(0, 3);
    if (!list.length) {
      jumpback.hidden = true;
      return;
    }
    jumpback.hidden = false;
    jumpbackCards.innerHTML = "";
    list.forEach((entry) => {
      const btn = document.createElement("button");
      btn.className = "jumpback__card";
      btn.dataset.embedKind = entry.kind;
      btn.dataset.embedId = entry.id;
      btn.dataset.embedName = entry.name;
      if (entry.reportType) btn.dataset.reportType = entry.reportType;

      const dot = document.createElement("span");
      dot.className = "jumpback__card-dot";
      if (entry.kind === "dashboard") dot.classList.add("jumpback__card-dot--dashboard");
      else if (entry.reportType === "PaginatedReport") dot.classList.add("jumpback__card-dot--paginated");

      const body = document.createElement("div");
      body.className = "jumpback__card-body";
      const name = document.createElement("div");
      name.className = "jumpback__card-name";
      name.textContent = entry.name;
      const meta = document.createElement("div");
      meta.className = "jumpback__card-meta";
      meta.textContent = `opened ${formatRelative(entry.openedAt)}`;
      body.append(name, meta);

      btn.append(dot, body);
      btn.addEventListener("click", () => {
        const sidebarMatch = findSidebarButton(entry.id);
        if (sidebarMatch) onItemClick(sidebarMatch);
        else embedFromEntry(entry);
      });
      jumpbackCards.appendChild(btn);
    });
  }

  // -------------------- Collapsible groups --------------------

  function loadCollapsed() {
    try {
      return new Set(JSON.parse(localStorage.getItem(LS_COLLAPSED)) || []);
    } catch {
      return new Set();
    }
  }

  function saveCollapsed(set) {
    localStorage.setItem(LS_COLLAPSED, JSON.stringify([...set]));
  }

  function wireCollapsibleGroups() {
    const collapsed = loadCollapsed();
    document.querySelectorAll(".report-group").forEach((group, i) => {
      const title = group.querySelector(".report-group__title");
      if (!title) return;
      const key = title.textContent.trim();
      if (collapsed.has(key)) group.classList.add("is-collapsed");
      const header = group.querySelector("[data-collapsible]");
      if (!header) return;
      header.addEventListener("click", () => {
        group.classList.toggle("is-collapsed");
        const set = loadCollapsed();
        if (group.classList.contains("is-collapsed")) set.add(key);
        else set.delete(key);
        saveCollapsed(set);
      });
    });
  }

  // -------------------- Topbar state --------------------

  function setActive(button) {
    if (activeItem) activeItem.classList.remove("is-active");
    activeItem = button;
    if (activeItem) activeItem.classList.add("is-active");
    // Also activate same-id button in the other group (e.g. the recents clone)
    if (button) {
      const id = button.dataset.embedId;
      document.querySelectorAll(`.report-item[data-embed-id="${CSS.escape(id)}"]`).forEach((b) => {
        if (b !== button) b.classList.add("is-active");
      });
    }
  }

  function clearActive() {
    document.querySelectorAll(".report-item.is-active").forEach((b) => b.classList.remove("is-active"));
    activeItem = null;
    activeItemData = null;
  }

  function showLoader() {
    emptyState.hidden = true;
    embedCard.classList.remove("is-ready");
    loader.hidden = false;
    // Animate progress to ~80% during fetch
    requestAnimationFrame(() => {
      loaderBar.style.width = "80%";
    });
  }

  function showReady() {
    loaderBar.style.width = "100%";
    setTimeout(() => {
      loader.hidden = true;
      loaderBar.style.width = "0%";
    }, 220);
    emptyState.hidden = true;
    embedCard.classList.add("is-ready");
  }

  function showEmpty() {
    loader.hidden = true;
    embedCard.classList.remove("is-ready");
    emptyState.hidden = false;
    renderJumpback();
    updateTopbar(null);
  }

  function showError(message) {
    loader.hidden = true;
    embedCard.classList.remove("is-ready");
    try { powerbi.reset(container); } catch {}
    toast(message || "Embed failed", { kind: "error", ttl: 6000 });
    showEmpty();
  }

  function updateTopbar(data) {
    if (!data) {
      currentName.textContent = "No report selected";
      currentType.hidden = true;
      metaStrip.hidden = true;
      openInPbi.hidden = true;
      copyLinkBtn.hidden = true;
      if (metaTickHandle) { clearInterval(metaTickHandle); metaTickHandle = null; }
      tokenMintedAt = null;
      return;
    }
    const { name, kind, reportType, id } = data;
    currentName.textContent = name;

    let label = null;
    let cls = "type-badge";
    if (kind === "dashboard") { label = "Dashboard"; cls += " type-badge--dashboard"; }
    else if (reportType === "PaginatedReport") { label = "Paginated"; cls += " type-badge--paginated"; }
    else if (reportType === "PowerBIReport") { label = "Interactive"; }
    if (label) {
      currentType.textContent = label;
      currentType.className = cls;
      currentType.hidden = false;
    } else {
      currentType.hidden = true;
    }

    metaStrip.hidden = false;
    metaReportId.textContent = `${id.slice(0, 8)}…${id.slice(-4)}`;

    if (APP.workspace_id) {
      const path = kind === "dashboard" ? "dashboards" : "reports";
      openInPbi.href = `https://app.powerbi.com/groups/${APP.workspace_id}/${path}/${id}`;
      openInPbi.hidden = false;
    }
    copyLinkBtn.hidden = false;
  }

  function startTokenTick() {
    if (metaTickHandle) clearInterval(metaTickHandle);
    const tick = () => {
      if (!tokenMintedAt) return;
      metaToken.textContent = `token minted ${formatRelative(tokenMintedAt)}`;
    };
    tick();
    metaTickHandle = setInterval(tick, 15000);
  }

  // -------------------- Embed --------------------

  function findSidebarButton(id) {
    return document.querySelector(`.sidebar__nav .report-item[data-embed-id="${CSS.escape(id)}"]`);
  }

  async function embedItem({ kind, id, name, reportType }) {
    activeItemData = { kind, id, name, reportType };
    updateTopbar(activeItemData);
    showLoader();

    try {
      const endpoint =
        kind === "dashboard"
          ? `/api/embed-info/dashboard/${encodeURIComponent(id)}`
          : `/api/embed-info/${encodeURIComponent(id)}`;
      const resp = await fetch(endpoint);
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${body.slice(0, 240)}`);
      }
      const info = await resp.json();

      tokenMintedAt = Date.now();
      startTokenTick();

      powerbi.reset(container);

      const isDashboard = info.embed_type === "dashboard";
      const isPaginated = info.report_type === "PaginatedReport";

      const config = {
        type: isDashboard ? "dashboard" : "report",
        id: info.embed_id,
        embedUrl: info.embed_url,
        accessToken: info.embed_token,
        tokenType: models.TokenType.Embed,
      };

      if (isDashboard) {
        config.pageView = "fitToWidth";
      } else if (isPaginated) {
        // Paginated reports (RDL) don't support panes, pageNavigation, or
        // BackgroundType — passing those settings causes the RDL viewer to
        // fail during cold initialization. Pass no settings for paginated.
      } else {
        config.settings = {
          panes: {
            filters: { visible: true, expanded: false },
            pageNavigation: { visible: true },
          },
          background: models.BackgroundType.Default,
        };
      }

      const embedded = powerbi.embed(container, config);

      if (isPaginated) {
        // Paginated reports (RDL) do not fire 'loaded' or 'rendered' — they
        // are explicitly unsupported per the Power BI SDK docs. Show the
        // container immediately so the RDL viewer's own loading indicator is
        // visible rather than the app's spinner blocking the content forever.
        showReady();
      } else {
        embedded.on("loaded", () => showReady());
        embedded.on("rendered", () => showReady());
      }
      embedded.on("error", (event) => {
        const detail = event.detail || {};
        showError(detail.message || "Power BI SDK reported an error. Check DevTools console.");
      });

      pushRecent({ id, name, kind, reportType: reportType || null });
    } catch (err) {
      showError(err.message || String(err));
    }
  }

  function embedFromEntry(entry) {
    embedItem({ kind: entry.kind, id: entry.id, name: entry.name, reportType: entry.reportType });
    updateHash(entry);
  }

  // -------------------- Routing --------------------

  function updateHash({ kind, id }) {
    const prefix = kind === "dashboard" ? "#/d/" : "#/r/";
    const next = prefix + id;
    if (location.hash !== next) {
      history.replaceState(null, "", next);
    }
  }

  function parseHash() {
    const m = location.hash.match(/^#\/(r|d)\/([\w-]+)/);
    if (!m) return null;
    return { kind: m[1] === "d" ? "dashboard" : "report", id: m[2] };
  }

  function embedFromHash() {
    const h = parseHash();
    if (!h) { showEmpty(); return; }
    const btn = findSidebarButton(h.id);
    if (btn) {
      setActive(btn);
      embedItem({
        kind: btn.dataset.embedKind || "report",
        id: btn.dataset.embedId,
        name: btn.dataset.embedName,
        reportType: btn.dataset.reportType,
      });
      return;
    }
    // Not in the live list — try a recent match
    const recent = loadRecents().find((r) => r.id === h.id);
    if (recent) {
      embedItem({ kind: recent.kind, id: recent.id, name: recent.name, reportType: recent.reportType });
      return;
    }
    toast("Report not found in this workspace", { kind: "error" });
    history.replaceState(null, "", location.pathname);
    showEmpty();
  }

  // -------------------- Clicks --------------------

  function onItemClick(btn) {
    setActive(btn);
    const data = {
      kind: btn.dataset.embedKind || "report",
      id: btn.dataset.embedId,
      name: btn.dataset.embedName,
      reportType: btn.dataset.reportType,
    };
    embedItem(data);
    updateHash(data);
  }

  function wireReportItems() {
    document.querySelectorAll(".sidebar__nav .report-item").forEach((btn) => {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => onItemClick(btn));
    });
  }

  // -------------------- Search --------------------

  function getVisibleItems() {
    return [...document.querySelectorAll(".sidebar__nav .report-item")].filter(
      (el) => !el.hidden && el.offsetParent !== null
    );
  }

  function applySearch(q) {
    const needle = q.trim().toLowerCase();
    let anyMatch = false;

    document.querySelectorAll(".sidebar__nav .report-group").forEach((group) => {
      if (group.hidden && group.id === "recentsGroup" && !loadRecents().length) return;
      const items = [...group.querySelectorAll(".report-item")];
      if (!items.length) return;

      let groupHasMatch = false;
      items.forEach((btn) => {
        const name = (btn.dataset.embedName || "").toLowerCase();
        const match = !needle || name.includes(needle);
        btn.hidden = !match;
        if (match) groupHasMatch = true;
      });

      if (needle) {
        group.style.display = groupHasMatch ? "" : "none";
        if (groupHasMatch) anyMatch = true;
      } else {
        group.style.display = "";
        anyMatch = true;
      }
    });

    noMatch.hidden = !needle || anyMatch;
    keyboardIndex = -1;
    clearKeyboardHighlight();
  }

  function clearKeyboardHighlight() {
    document.querySelectorAll(".report-item.is-keyboard").forEach((el) => el.classList.remove("is-keyboard"));
  }

  function moveKeyboard(delta) {
    const items = getVisibleItems();
    if (!items.length) return;
    keyboardIndex = Math.max(0, Math.min(items.length - 1, keyboardIndex + delta));
    if (keyboardIndex < 0) keyboardIndex = 0;
    clearKeyboardHighlight();
    const target = items[keyboardIndex];
    target.classList.add("is-keyboard");
    target.scrollIntoView({ block: "nearest" });
  }

  function activateKeyboard() {
    const items = getVisibleItems();
    if (keyboardIndex >= 0 && items[keyboardIndex]) onItemClick(items[keyboardIndex]);
  }

  // -------------------- Fullscreen --------------------

  function toggleFullscreen(force) {
    const on = force !== undefined ? force : !document.body.classList.contains("is-fullscreen");
    document.body.classList.toggle("is-fullscreen", on);
  }

  // -------------------- Toasts --------------------

  function toast(text, { kind = "info", ttl = 3500 } = {}) {
    const el = document.createElement("div");
    el.className = `toast toast--${kind}`;
    const iconSvg =
      kind === "success"
        ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : kind === "error"
        ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5v4M8 11.2v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.5v4M8 4.8v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    el.innerHTML = `<span class="toast__icon" aria-hidden="true">${iconSvg}</span><span class="toast__text"></span>`;
    el.querySelector(".toast__text").textContent = text;
    toastMount.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 220);
    }, ttl);
  }

  // -------------------- Topbar actions --------------------

  refreshBtn.addEventListener("click", () => window.location.reload());
  fullscreenBtn.addEventListener("click", () => toggleFullscreen());

  copyLinkBtn.addEventListener("click", async () => {
    if (!activeItemData) return;
    const prefix = activeItemData.kind === "dashboard" ? "#/d/" : "#/r/";
    const url = location.origin + location.pathname + prefix + activeItemData.id;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied to clipboard", { kind: "success" });
    } catch {
      toast("Couldn't copy link", { kind: "error" });
    }
  });

  // -------------------- Keyboard --------------------

  document.addEventListener("keydown", (e) => {
    const isInput = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";

    if (e.key === "Escape") {
      if (document.body.classList.contains("is-fullscreen")) {
        toggleFullscreen(false);
        e.preventDefault();
        return;
      }
      if (isInput && e.target === searchInput) {
        searchInput.value = "";
        applySearch("");
        searchInput.blur();
        e.preventDefault();
        return;
      }
    }

    if (isInput) {
      if (e.target === searchInput) {
        if (e.key === "ArrowDown" || e.key === "Enter") {
          if (e.key === "Enter") {
            if (keyboardIndex < 0) moveKeyboard(1);
            activateKeyboard();
          } else {
            moveKeyboard(1);
          }
          e.preventDefault();
        } else if (e.key === "ArrowUp") {
          moveKeyboard(-1);
          e.preventDefault();
        }
      }
      return;
    }

    if (e.key === "/") {
      searchInput.focus();
      e.preventDefault();
      return;
    }
    if (e.key === "f" || e.key === "F") {
      toggleFullscreen();
      e.preventDefault();
      return;
    }
    if (e.key === "?") {
      toast("/ search · j/k navigate · Enter open · F fullscreen · Esc exit", { ttl: 5000 });
      e.preventDefault();
      return;
    }
    if (e.key === "j" || e.key === "ArrowDown") { moveKeyboard(1); e.preventDefault(); return; }
    if (e.key === "k" || e.key === "ArrowUp")   { moveKeyboard(-1); e.preventDefault(); return; }
    if (e.key === "Enter") { activateKeyboard(); e.preventDefault(); }
  });

  searchInput.addEventListener("input", () => applySearch(searchInput.value));

  // -------------------- Init --------------------

  wireCollapsibleGroups();
  renderRecents();
  renderJumpback();
  wireReportItems();

  window.addEventListener("hashchange", embedFromHash);
  embedFromHash();

  window.embedItem = embedItem;
})();
