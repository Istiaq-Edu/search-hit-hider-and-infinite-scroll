window.__mockCalls = 0;
// GUI-test mock for the WebExtension `browser` API.
// Mirrors the message semantics of src/background/service-worker.ts so the
// real popup/options bundles run unmodified outside the extension host.
(function () {
  const now = Date.now();
  let seq = 0;
  const mk = (domain, mode, enabled, ageMin) => ({
    domain, mode, enabled, createdAt: now - (ageMin ?? seq++) * 60000,
  });

  let entries = [
    mk("pinterest.com", "block", true, 240),
    mk("quora.com", "block", true, 200),
    mk("medium.com", "block", true, 180),
    mk("geeksforgeeks.org", "block", true, 170),
    mk("stackoverflow.com", "block", true, 160),
    mk("w3schools.com", "block", true, 150),
    mk("speedylook.com", "pban", true, 140),
    mk("mathwarehouse.com", "pban", true, 130),
    mk("dictionary.com", "block", true, 120),
    mk("merriam-webster.com", "block", true, 110),
    mk("wikitech.net", "pban", true, 100),
    mk("answers.com", "pban", true, 95),
    mk("coursehero.com", "block", true, 90),
    mk("chegg.com", "block", true, 85),
    mk("scribd.com", "block", true, 80),
    mk("slideshare.net", "block", true, 75),
    mk("researchgate.net", "block", true, 70),
    mk("academia.edu", "block", true, 65),
    mk("yandex.ru", "block", true, 60),
    mk("aliexpress.com", "block", true, 55),
    mk("amazon.com", "block", false, 50), // disabled entry
    mk("facebook.com", "block", false, 45), // disabled entry
    mk("wiki.example-vectors.co.uk", "block", true, 40),
    mk("cdn.jsdelivr.net", "block", true, 35),
    mk("superlongdomainname-to-test-layout-overflow-and-ellipsis-in-the-list-rows.example.org", "block", true, 30),
    mk("münchen.de", "block", true, 25), // IDN
    mk("hello world", "block", true, 20), // junk (validation gap demo)
    mk("example.com.", "block", true, 15), // trailing dot
    mk("nomatchaaaa.com", "pban", false, 10), // disabled pban
    mk("zzz-last-alphabetical.net", "block", true, 5),
  ];

  const DEFAULT_PREFS = {
    engineToggles: { google: true, duckduckgo: true, bing: true, yandex: true, baidu: true, brave: true },
    showNotices: true,
    oneClick: false,
    oneClickTarget: "block",
    domainChoiceMode: "ask",
    stripWww: true,
    addPosition: "end",
    buttonStyle: "text",
    showOnHover: false,
    aggressiveBlock: "none",
    mutationObserver: true,
    debugMode: false,
    pausedGlobally: false,
    pausedEngines: [],
    subdomainWildcard: true,
    theme: "system",
    infiniteScroll: true,
    infiniteScrollThreshold: 800,
    infiniteScrollMaxPages: 20,
    infiniteScrollPersist: true,
  };
  let prefs = structuredClone(DEFAULT_PREFS);

  // Same semantics as list-utils addEntry
  function addEntry(list, domain, mode, position) {
    const d = String(domain).trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
    if (!d || d.length < 2) return { entries: list, added: null, duplicate: false };
    if (list.some((e) => e.domain === d)) return { entries: list, added: null, duplicate: true };
    const entry = { domain: d, mode, enabled: true, createdAt: Date.now() };
    let out;
    if (position === "top") out = [entry, ...list];
    else if (position === "sort") out = [...list, entry].sort((a, b) => a.domain.localeCompare(b.domain));
    else out = [...list, entry];
    return { entries: out, added: entry, duplicate: false };
  }

  let undoSlot = null;
  const changeListeners = [];

  window.__shhMock = {
    get entries() { return entries; },
    get prefs() { return prefs; },
    reset() { prefs = structuredClone(DEFAULT_PREFS); },
  };

  window.browser = {
    runtime: {
      getManifest: () => ({ version: "1.6.1", name: "Search Hit Hider and Infinite Scroll" }),
      sendMessage: (msg) => {
    // COLD EVENT PAGE SIM: first two calls hang 4s each, then respond normally
    const callNum = ++window.__mockCalls;
    if (callNum <= 2) {
      return new Promise((resolve) => setTimeout(() => resolve(handle(msg)), 4000));
    }
        const reply = handle(msg);
        return Promise.resolve(reply);
      },
      onMessage: { addListener() {}, removeListener() {} },
    },
    storage: {
      onChanged: {
        addListener(cb) { changeListeners.push(cb); },
        removeListener() {},
      },
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      sync: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    },
    tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.reject(new Error("no tabs in harness")) },
  };

  function handle(msg) {
    switch (msg.type) {
      case "GET_LIST":
        return { entries };
      case "ADD_ENTRY": {
        const r = addEntry(entries, msg.domain, msg.mode, prefs.addPosition);
        entries = r.entries;
        if (r.added) undoSlot = r.added;
        return { entry: r.added, duplicate: r.duplicate };
      }
      case "REMOVE_ENTRY": {
        const idx = entries.findIndex((e) => e.domain === msg.domain);
        if (idx === -1) return { removed: null };
        const removed = entries[idx];
        entries = entries.filter((e) => e.domain !== msg.domain);
        undoSlot = removed;
        for (const cb of changeListeners) cb({ shh_entries: {} }, "local");
        return { removed };
      }
      case "UPDATE_ENTRY":
        entries = entries.map((e) => (e.domain === msg.domain ? { ...e, ...msg.patch } : e));
        for (const cb of changeListeners) cb({ shh_entries: {} }, "local");
        return { ok: true };
      case "BULK_OP": {
        const targets = new Set(msg.domains ?? entries.map((e) => e.domain));
        switch (msg.op) {
          case "delete": entries = entries.filter((e) => !targets.has(e.domain)); break;
          case "disable": entries = entries.map((e) => (targets.has(e.domain) ? { ...e, enabled: false } : e)); break;
          case "enable": entries = entries.map((e) => (targets.has(e.domain) ? { ...e, enabled: true } : e)); break;
          case "to_pban": entries = entries.map((e) => (targets.has(e.domain) ? { ...e, mode: "pban" } : e)); break;
          case "to_block": entries = entries.map((e) => (targets.has(e.domain) ? { ...e, mode: "block" } : e)); break;
          case "normalize_www": entries = entries.map((e) => (targets.has(e.domain) ? { ...e, domain: e.domain.replace(/^www\./, "") } : e)); break;
          case "dedup": {
            const seen = new Set();
            entries = entries.filter((e) => (seen.has(e.domain) ? false : (seen.add(e.domain), true)));
            break;
          }
          case "sort_date": entries = [...entries].sort((a, b) => b.createdAt - a.createdAt); break;
        }
        for (const cb of changeListeners) cb({ shh_entries: {} }, "local");
        return { count: entries.length };
      }
      case "BULK_IMPORT": {
        let added = 0, duplicates = 0, invalid = 0;
        for (const item of msg.entries) {
          const r = addEntry(entries, item.domain, item.mode, prefs.addPosition);
          if (r.added) { entries = r.entries; added++; }
          else if (r.duplicate) duplicates++;
          else invalid++;
        }
        for (const cb of changeListeners) cb({ shh_entries: {} }, "local");
        return { added, duplicates, invalid };
      }
      case "GET_PREFS":
        return { prefs };
      case "SET_PREFS":
        prefs = { ...prefs, ...msg.patch, engineToggles: { ...prefs.engineToggles, ...(msg.patch.engineToggles ?? {}) } };
        return { prefs };
      case "UNDO_LAST": {
        const entry = undoSlot;
        undoSlot = null;
        if (!entry) return { restored: null };
        if (!entries.some((e) => e.domain === entry.domain)) entries = [...entries, entry];
        for (const cb of changeListeners) cb({ shh_entries: {} }, "local");
        return { restored: entry };
      }
      default:
        return { error: "Unknown message type (harness mock)" };
    }
  }
})();
