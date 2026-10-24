(() => {
  "use strict";

  const seed = window.SEED_DATA || { jobs: [], meta: {} };
  const root = document.documentElement;
  const state = {
    data: seed,
    search: "",
    city: "all",
    openOnly: true,
    sort: "priority",
    view: "cards",
    saved: new Set(readSaved()),
    isServer: false,
    isHosted: false,
    refreshing: false,
    lastNotifiedDate: "",
  };

  const elements = {
    jobList: document.querySelector("#jobList"),
    emptyState: document.querySelector("#emptyState"),
    visibleCount: document.querySelector("#visibleCount"),
    resultDescription: document.querySelector("#resultDescription"),
    matchedMetric: document.querySelector("#matchedMetric"),
    priorityMetric: document.querySelector("#priorityMetric"),
    recentMetric: document.querySelector("#recentMetric"),
    sourceMetric: document.querySelector("#sourceMetric"),
    lastCheckedMetric: document.querySelector("#lastCheckedMetric"),
    searchInput: document.querySelector("#searchInput"),
    cityFilters: document.querySelector("#cityFilters"),
    openOnly: document.querySelector("#openOnly"),
    sortSelect: document.querySelector("#sortSelect"),
    refreshButton: document.querySelector("#refreshButton"),
    exportButton: document.querySelector("#exportButton"),
    resetFiltersButton: document.querySelector("#resetFiltersButton"),
    countdown: document.querySelector("#countdown"),
    nextRunDate: document.querySelector("#nextRunDate"),
    heroUpdateText: document.querySelector("#heroUpdateText"),
    footerStatus: document.querySelector("#footerStatus"),
    notificationButton: document.querySelector("#notificationButton"),
    settingsButton: document.querySelector("#settingsButton"),
    settingsDialog: document.querySelector("#settingsDialog"),
    settingsDialogClose: document.querySelector("#settingsDialogClose"),
    applyDialog: document.querySelector("#applyDialog"),
    applyDialogContent: document.querySelector("#applyDialogContent"),
    applyDialogClose: document.querySelector("#applyDialogClose"),
    serverNote: document.querySelector("#serverNote"),
    toast: document.querySelector("#toast"),
  };

  let toastTimer = 0;

  function readSaved() {
    try {
      return JSON.parse(localStorage.getItem("thai-job-radar-saved") || "[]");
    } catch {
      return [];
    }
  }

  function persistSaved() {
    localStorage.setItem("thai-job-radar-saved", JSON.stringify([...state.saved]));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 3200);
  }

  function formatShortTime(iso) {
    if (!iso) return "尚未成功核验";
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(value);
  }

  function chinaNowParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    return Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
    );
  }

  function nextEightAm() {
    const now = Date.now();
    const parts = chinaNowParts();
    // 08:00 in UTC+8 is 00:00 UTC on the same calendar date.
    let target = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
    if (now >= target) target += 24 * 60 * 60 * 1000;
    return target;
  }

  function tickCountdown() {
    const diff = Math.max(0, nextEightAm() - Date.now());
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    elements.countdown.textContent = [hours, minutes, seconds]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
    const nextDate = new Date(nextEightAm());
    const label = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(nextDate);
    elements.nextRunDate.textContent = `${label} · 08:00 · Asia/Shanghai`;
  }

  function normalizeSalary(job) {
    if (!job.salary_min || !job.salary_max) return escapeHtml(job.salary_text || "薪资面议");
    const minimum = `${Math.round(job.salary_min / 100) / 10}K`;
    const maximum = `${Math.round(job.salary_max / 100) / 10}K`;
    const same = job.salary_min === job.salary_max;
    return `¥${same ? minimum : `${minimum}–${maximum}`}`;
  }

  function salarySuffix(job) {
    return /13薪/.test(job.salary_text || "") ? "包含 13 薪" : "月薪区间";
  }

  function priorityLabel(job) {
    if (job.city === "西安" || job.city === "昆明") return "优先城市";
    if (job.city?.startsWith("海外")) return "海外岗位";
    return "";
  }

  function jobMatches(job) {
    if (state.openOnly && job.freshness !== "recent") return false;
    if (state.city === "priority" && job.city_priority !== 1) return false;
    if (state.city === "其他" && job.city_priority === 1) return false;
    if (!["all", "priority", "其他"].includes(state.city) && job.city !== state.city) {
      return false;
    }
    const query = state.search.trim().toLowerCase();
    if (!query) return true;
    return `${job.title} ${job.company} ${job.city} ${job.industry}`
      .toLowerCase()
      .includes(query);
  }

  function filteredJobs() {
    const filtered = state.data.jobs.filter(jobMatches);
    return filtered.sort((a, b) => {
      if (state.sort === "fresh") {
        return (
          (a.age_days ?? 999) - (b.age_days ?? 999) ||
          a.city_priority - b.city_priority
        );
      }
      if (state.sort === "salary") {
        return (b.salary_max ?? 0) - (a.salary_max ?? 0) || a.city_priority - b.city_priority;
      }
      return (
        a.city_priority - b.city_priority ||
        (a.freshness === "recent" ? 0 : 1) - (b.freshness === "recent" ? 0 : 1) ||
        (b.salary_max ?? 0) - (a.salary_max ?? 0)
      );
    });
  }

  function locationIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s7-5.2 7-12a7 7 0 1 0-14 0c0 6.8 7 12 7 12Z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9" r="2.2" stroke="currentColor" stroke-width="1.8"/></svg>`;
  }

  function calendarIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M8 3v4M16 3v4M3 10h18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  }

  function sendIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m21 3-7.5 18-3.2-7.3L3 10.5 21 3Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m10.3 13.7 4.1-4.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  }

  function arrowIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M14 7l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function renderJob(job) {
    const saved = state.saved.has(job.id);
    const priority = priorityLabel(job);
    const tags = [
      `<span class="job-tag thai">泰语相关</span>`,
      `<span class="job-tag">${escapeHtml(job.experience)}</span>`,
      `<span class="job-tag">${escapeHtml(job.degree)}</span>`,
      `<span class="job-tag">${escapeHtml(job.industry)}</span>`,
    ].filter(Boolean);

    return `
      <article class="job-card ${job.city_priority === 1 ? "is-priority" : ""}" data-job-id="${escapeHtml(job.id)}">
        ${priority ? `<span class="priority-ribbon">★ ${escapeHtml(priority)}</span>` : ""}
        <div class="job-card-top">
          <div class="company-logo" aria-hidden="true">${escapeHtml((job.company || "职").trim().charAt(0))}</div>
          <div class="job-heading">
            <div class="job-title-line">
              <h3 title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</h3>
              <span class="fresh-dot ${job.freshness === "recent" ? "" : "verify"}">${job.freshness === "recent" ? "近期索引" : "待确认"}</span>
            </div>
            <p class="company-name" title="${escapeHtml(job.company)}">${escapeHtml(job.company)}</p>
          </div>
          <div class="salary-block">
            <strong>${normalizeSalary(job)}</strong>
            <span>${salarySuffix(job)}</span>
          </div>
        </div>

        <div class="job-tags">${tags.join("")}</div>

        <div class="job-info-row">
          <div class="info-cell">
            <span class="info-label">工作地点</span>
            <span class="info-value" title="${escapeHtml(job.location)}">${locationIcon()}${escapeHtml(job.city)} · ${escapeHtml(job.location)}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">招聘状态</span>
            <span class="info-value" title="近 30 天更新，投递前请在目标平台确认">${calendarIcon()}${escapeHtml(job.freshness === "recent" ? "近 30 天更新 · 投递前确认" : job.freshness_label)}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">公司信息</span>
            <span class="info-value">${escapeHtml(job.company_size)} · ${escapeHtml(job.industry)}</span>
          </div>
        </div>

        <div class="apply-panel">
          <div class="apply-method">
            <span class="apply-icon">${sendIcon()}</span>
            <div>
              <strong>投递方式：平台内在线申请 / 沟通</strong>
              <span title="请搜索公司名称和岗位名称，确认仍在招聘">搜索同公司、同岗位后在线投递</span>
            </div>
          </div>
          <div class="apply-actions">
            <button class="bookmark-button ${saved ? "saved" : ""}" type="button" data-action="save" aria-label="${saved ? "取消收藏" : "收藏岗位"}" title="${saved ? "取消收藏" : "收藏岗位"}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.6L6 21V4.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
            </button>
            <button class="apply-button" type="button" data-action="apply">查看投递 ${arrowIcon()}</button>
          </div>
        </div>

        <div class="job-card-footer">
          <span class="source-label">${escapeHtml(job.source)} · ${escapeHtml(job.published_text)}</span>
          <span class="footer-right">
            <span>${escapeHtml(job.company_views || job.company_size)}</span>
            ${saved ? `<span class="saved-count">已收藏</span>` : ""}
          </span>
        </div>
      </article>
    `;
  }

  function render() {
    const jobs = filteredJobs();
    const all = state.data.jobs;
    const meta = state.data.meta || {};
    elements.jobList.innerHTML = jobs.map(renderJob).join("");
    elements.jobList.classList.toggle("list-view", state.view === "list");
    elements.emptyState.hidden = jobs.length > 0;
    elements.visibleCount.textContent = `${jobs.length} 个结果 · ${state.saved.size} 个已收藏`;
    elements.matchedMetric.textContent = String(meta.matched ?? all.length);
    elements.priorityMetric.textContent = String(
      meta.priority_count ?? all.filter((job) => job.city_priority === 1).length,
    );
    elements.recentMetric.textContent = String(
      meta.recent_count ?? all.filter((job) => job.freshness === "recent").length,
    );
    elements.sourceMetric.textContent = String(meta.total_seen ?? all.length);
    elements.lastCheckedMetric.textContent = `${formatShortTime(meta.last_success)} 核验`;
    elements.resultDescription.textContent =
      `今日共 ${all.length} 个达标岗位，优先城市 ${all.filter((job) => job.city_priority === 1).length} 个。` +
      "薪资按岗位最低月薪判断；“近期”表示最近 30 天有更新，投递前请再次确认招聘状态。";
    elements.footerStatus.textContent = `最近核验：${formatShortTime(meta.last_success)}`;
    elements.heroUpdateText.textContent = state.isServer
      ? "实时检索服务已连接"
      : state.isHosted
        ? "在线数据已同步"
        : "当前为离线预览数据";
    elements.refreshButton.querySelector(".button-label").textContent =
      state.isHosted && !state.isServer ? "同步最新数据" : "立即检索";
    if (state.isHosted && !state.isServer && elements.serverNote) {
      elements.serverNote.innerHTML = `
        <strong>在线自动更新</strong>
        <p>当前网页读取的是已发布的岗位数据。自动任务每天北京时间 08:00 运行，完成后会直接更新此页面。</p>
        <p>若某次招聘站限流，系统会保留最近一次成功结果。</p>
      `;
    }

    document.querySelectorAll("[data-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === state.view);
      button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
    });
    document.querySelectorAll("[data-city]").forEach((button) => {
      button.classList.toggle("active", button.dataset.city === state.city);
      button.setAttribute("aria-pressed", String(button.dataset.city === state.city));
    });
  }

  function openApplyDialog(job) {
    const platformLinks = platformSearches(job);
    const primaryPlatform = platformLinks[0];
    elements.applyDialogContent.innerHTML = `
      <div class="dialog-job-header">
        <div class="company-logo">${escapeHtml((job.company || "职").trim().charAt(0))}</div>
        <div>
          <h2>${escapeHtml(job.title)}</h2>
          <p>${escapeHtml(job.company)}</p>
        </div>
        <span class="dialog-salary">${normalizeSalary(job)}</span>
      </div>
      <div class="dialog-notice">
        <strong>先确认，再投递。</strong>
        聚合站详情页可能已失效。请到招聘平台搜索“${escapeHtml(job.company)} ${escapeHtml(job.title)}”，找到同一岗位并确认仍开放后再投递。
      </div>
      <ol class="apply-steps">
        <li>在 BOSS直聘等平台搜索公司名称和岗位名称</li>
        <li>找到同一岗位，确认仍显示“申请 / 沟通”入口</li>
        <li>登录平台并上传或发送中泰文简历</li>
      </ol>
      <div class="platform-fallback">
        <span>其他招聘平台搜索：</span>
        <div class="platform-link-grid">
          ${platformLinks.slice(1)
            .map(
              (item) =>
                `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)} ↗</a>`,
            )
            .join("")}
        </div>
      </div>
      <div class="dialog-actions">
        <a class="primary-button" href="${escapeHtml(primaryPlatform.url)}" target="_blank" rel="noopener noreferrer">
          去 BOSS 搜索岗位 ${arrowIcon()}
        </a>
        <button class="secondary-button" type="button" id="dialogCopy">复制岗位信息</button>
      </div>
    `;
    elements.applyDialog.showModal();
    document.querySelector("#dialogCopy").addEventListener("click", async () => {
      const value = `${job.company} ${job.title}\n${job.city} · ${job.salary_text}`;
      try {
        await navigator.clipboard.writeText(value);
        showToast("公司名称和岗位信息已复制");
      } catch {
        showToast(`请搜索：${value}`);
      }
    });
  }

  function platformSearches(job) {
    const keyword = encodeURIComponent(`${job.company} ${job.title}`);
    return [
      {
        label: "BOSS直聘",
        url: `https://www.zhipin.com/web/geek/job?query=${keyword}`,
      },
      {
        label: "猎聘",
        url: `https://www.liepin.com/zhaopin/?key=${keyword}`,
      },
      {
        label: "前程无忧",
        url: `https://we.51job.com/pc/search?keyword=${keyword}`,
      },
      {
        label: "智联招聘",
        url: `https://sou.zhaopin.com/?kw=${keyword}`,
      },
    ];
  }

  function toggleSaved(id) {
    if (state.saved.has(id)) {
      state.saved.delete(id);
      showToast("已取消收藏");
    } else {
      state.saved.add(id);
      showToast("已收藏，可随清单一并导出");
    }
    persistSaved();
    render();
  }

  function currentJobFromEvent(event) {
    const card = event.target.closest(".job-card");
    if (!card) return null;
    return state.data.jobs.find((job) => job.id === card.dataset.jobId) || null;
  }

  function resetFilters() {
    state.search = "";
    state.city = "all";
    state.sort = "priority";
    state.openOnly = true;
    elements.searchInput.value = "";
    elements.sortSelect.value = "priority";
    elements.openOnly.checked = true;
    render();
  }

  function exportCsv() {
    const jobs = filteredJobs();
    if (!jobs.length) {
      showToast("当前筛选下没有可导出的岗位");
      return;
    }
    const header = [
      "职位",
      "公司",
      "月薪",
      "城市",
      "地点",
      "经验",
      "学历",
      "招聘状态",
      "投递方式",
      "职位链接",
      "收藏",
    ];
    const rows = jobs.map((job) => [
      job.title,
      job.company,
      job.salary_text,
      job.city,
      job.location,
      job.experience,
      job.degree,
      job.freshness_label,
      job.apply_method,
      job.source_url,
      state.saved.has(job.id) ? "是" : "否",
    ]);
    const csv = [header, ...rows]
      .map((row) =>
        row
          .map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\r\n");
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `泰语工作清单-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    showToast(`已导出 ${jobs.length} 个岗位`);
  }

  async function refreshJobs() {
    if (state.refreshing) return;
    if (location.protocol === "file:") {
      showToast("这是离线预览。运行 python3 server.py 后可实时检索。");
      return;
    }
    if (state.isHosted && !state.isServer) {
      try {
        const response = await fetch(`data/jobs.json?v=${Date.now()}`, {
          cache: "no-store",
        });
        if (response.ok) {
          state.data = await response.json();
          render();
        }
        showToast("已重新加载在线数据；自动检索时间为每天 08:00");
      } catch {
        showToast("数据连接暂时不可用，请稍后刷新页面");
      }
      return;
    }
    state.refreshing = true;
    elements.refreshButton.classList.add("loading");
    elements.refreshButton.querySelector(".button-label").textContent = "正在检索…";
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 95000);
      const response = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (result.state) {
        state.data = result.state;
        state.isServer = true;
        render();
      }
      showToast(result.message || "检索完成");
    } catch (error) {
      const message =
        error.name === "AbortError"
          ? "检索耗时较长，后台仍会继续保留上次结果"
          : "暂时无法连接检索服务，已保留本地结果";
      showToast(message);
    } finally {
      state.refreshing = false;
      elements.refreshButton.classList.remove("loading");
      elements.refreshButton.querySelector(".button-label").textContent = "立即检索";
    }
  }

  async function loadServerState() {
    if (location.protocol === "file:") return;
    try {
      const published = await fetch(`data/jobs.json?v=${Date.now()}`, {
        cache: "no-store",
      });
      if (published.ok) {
        const result = await published.json();
        if (result.jobs?.length) {
          state.data = result;
          state.isHosted = true;
          render();
        }
      }
    } catch {
      // A local server can still provide the API below.
    }
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json();
      if (!result.state?.jobs) return;
      state.data = result.state;
      state.isServer = true;
      render();
    } catch {
      // The static build remains fully usable with its published JSON.
    }
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      showToast("当前浏览器不支持桌面通知");
      return;
    }
    const permission = await Notification.requestPermission();
    elements.notificationButton.classList.toggle("enabled", permission === "granted");
    if (permission === "granted") {
      showToast("已开启提醒：网页打开时将在 08:00 提醒");
    } else {
      showToast("未获得通知权限，你仍可查看每日更新结果");
    }
  }

  function checkNotificationTime() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const parts = chinaNowParts();
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    if (
      parts.hour === 8 &&
      parts.minute === 0 &&
      state.lastNotifiedDate !== today
    ) {
      state.lastNotifiedDate = today;
      new Notification("泰语工作雷达", {
        body: "08:00 到了。打开页面查看今天的高薪泰语岗位。",
        tag: "thai-job-radar-daily",
      });
    }
  }

  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
  });
  elements.cityFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-city]");
    if (!button) return;
    state.city = button.dataset.city;
    render();
  });
  elements.openOnly.addEventListener("change", (event) => {
    state.openOnly = event.target.checked;
    render();
  });
  elements.sortSelect.addEventListener("change", (event) => {
    state.sort = event.target.value;
    render();
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    });
  });
  elements.jobList.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const job = currentJobFromEvent(event);
    if (!job) return;
    if (actionButton.dataset.action === "save") toggleSaved(job.id);
    if (actionButton.dataset.action === "apply") openApplyDialog(job);
  });
  elements.refreshButton.addEventListener("click", refreshJobs);
  elements.exportButton.addEventListener("click", exportCsv);
  elements.resetFiltersButton.addEventListener("click", resetFilters);
  elements.notificationButton.addEventListener("click", enableNotifications);
  elements.settingsButton.addEventListener("click", () => elements.settingsDialog.showModal());
  elements.settingsDialogClose.addEventListener("click", () => elements.settingsDialog.close());
  elements.applyDialogClose.addEventListener("click", () => elements.applyDialog.close());
  elements.applyDialog.addEventListener("click", (event) => {
    if (event.target === elements.applyDialog) elements.applyDialog.close();
  });
  elements.settingsDialog.addEventListener("click", (event) => {
    if (event.target === elements.settingsDialog) elements.settingsDialog.close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (elements.applyDialog.open) elements.applyDialog.close();
      if (elements.settingsDialog.open) elements.settingsDialog.close();
    }
  });

  if ("Notification" in window && Notification.permission === "granted") {
    elements.notificationButton.classList.add("enabled");
  }

  render();
  tickCountdown();
  window.setInterval(tickCountdown, 1000);
  window.setInterval(checkNotificationTime, 15000);
  loadServerState();
})();
