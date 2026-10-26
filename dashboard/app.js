(() => {
  "use strict";

  const API = "/api/dashboard/overview";
  const REFRESH_MS = 5000;
  const HISTORY_POINTS = 60;

  const $ = (id) => document.getElementById(id);
  const history = [];
  let inFlight = false;

  const clockFormat = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${pad(minutes)}m`;
    if (minutes > 0) return `${minutes}m ${pad(seconds % 60)}s`;
    return `${seconds}s`;
  }

  function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Math.max(0, Number(bytes) || 0);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = value >= 100 || unit === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unit]}`;
  }

  function formatClock(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : clockFormat.format(date);
  }

  function percentWidth(value) {
    return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
  }

  function setStatus(online) {
    $("status-dot").className = `status-dot ${online ? "is-live" : "is-offline"}`;
    $("status-text").textContent = online ? "Live" : "Offline";
  }

  function drawSpark() {
    const path = $("memory-path");
    if (history.length === 0) {
      path.setAttribute("d", "");
      return;
    }
    if (history.length === 1) {
      const y = 58 - (history[0] / 100) * 52;
      path.setAttribute("d", `M0 ${y.toFixed(1)}L300 ${y.toFixed(1)}`);
      return;
    }
    const points = history.map((value, index) => {
      const x = (index / (history.length - 1)) * 300;
      const y = 58 - (value / 100) * 52;
      return `${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    path.setAttribute("d", `M${points.join("L")}`);
  }

  function setBar(id, percent) {
    const bar = $(id);
    bar.style.width = percentWidth(percent);
    bar.className = `bar-fill${percent >= 90 ? " is-bad" : percent >= 70 ? " is-warn" : ""}`;
  }

  function renderHost(host) {
    const rows = [
      ["Hostname", host.hostname],
      ["Platform", `${host.platform} ${host.release}`],
      ["Architecture", host.arch],
      ["Node", host.node],
      ["CPU cores", String(host.cpuCount)],
    ];
    const list = $("host-list");
    list.replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      detail.title = value;
      row.append(term, detail);
      return row;
    }));
  }

  function render(data) {
    const memory = data.memory;
    const load = data.load;
    const cores = Math.max(1, data.host.cpuCount);

    $("server-uptime").textContent = formatDuration(data.serverUptimeSeconds);
    $("started-at").textContent = `since ${formatClock(data.serverStartedAt)}`;
    $("host-uptime").textContent = formatDuration(data.host.uptimeSeconds);
    $("requests-served").textContent = new Intl.NumberFormat().format(data.requestsServed);
    $("memory-card").textContent = `${memory.percent.toFixed(1)}%`;
    $("memory-card-note").textContent = `${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)}`;
    $("load-card").textContent = load[0].toFixed(2);
    $("load-card-note").textContent = `of ${cores} ${cores === 1 ? "core" : "cores"}`;
    $("cpu-count").textContent = String(cores);
    $("node-version").textContent = data.host.node;

    $("memory-percent").textContent = `${memory.percent.toFixed(1)}%`;
    $("memory-note").textContent = `${formatBytes(memory.usedBytes)} used · ${formatBytes(memory.totalBytes - memory.usedBytes)} free of ${formatBytes(memory.totalBytes)}`;
    setBar("memory-bar", memory.percent);

    $("load-cores").textContent = `${cores} ${cores === 1 ? "core" : "cores"}`;
    load.forEach((value, index) => {
      const key = ["1", "5", "15"][index];
      $(`load-${key}-value`).textContent = value.toFixed(2);
      setBar(`load-${key}`, (value / cores) * 100);
    });

    renderHost(data.host);
    $("updated").textContent = `Updated ${formatClock(data.generatedAt)}`;
    $("updated").title = new Date(data.generatedAt).toLocaleString();

    history.push(memory.percent);
    if (history.length > HISTORY_POINTS) history.shift();
    drawSpark();
  }

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const response = await fetch(API, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      render(await response.json());
      setStatus(true);
    } catch {
      setStatus(false);
      $("updated").textContent = "Update failed · retrying";
    } finally {
      inFlight = false;
    }
  }

  function startClock() {
    const tick = () => {
      $("clock").textContent = clockFormat.format(new Date());
    };
    tick();
    setInterval(tick, 1000);
  }

  function startAppMenu() {
    const wrap = $("app-switch");
    const button = $("app-switch-button");
    const menu = $("app-menu");

    const setOpen = (open) => {
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector("a")?.focus();
    };

    button.addEventListener("click", () => setOpen(menu.hidden));

    document.addEventListener("pointerdown", (event) => {
      if (menu.hidden) return;
      if (event.target instanceof Node && wrap.contains(event.target)) return;
      setOpen(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || menu.hidden) return;
      event.preventDefault();
      setOpen(false);
      button.focus();
    });
  }

  startClock();
  startAppMenu();
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
