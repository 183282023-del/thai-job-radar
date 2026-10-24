(() => {
  "use strict";

  const DATA = window.PUBLIC_SECTOR_DATA || { jobs: [], monitors: [], registration: {} };
  const jobs = Array.isArray(DATA.jobs) ? DATA.jobs : [];
  const state = {
    type: "all",
    city: "all",
    search: "",
    sort: "priority",
    saved: new Set(readSaved()),
  };

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    alertTitle: $("#alertTitle"),
    deadlineCountdown: $("#deadlineCountdown"),
    officialTopButton: $("#officialTopButton"),
    countdown: $("#countdown"),
    nextRun: $("#nextRun"),
    fileCount: $("#fileCount"),
    matchMetric: $("#matchMetric"),
    cityMetric: $("#cityMetric"),
    openMetric: $("#openMetric"),
    checkedTime: $("#checkedTime"),
    resultSummary: $("#resultSummary"),
    visibleCount: $("#visibleCount"),
    positionList: $("#positionList"),
    emptyState: $("#emptyState"),
    emptyMessage: $("#emptyMessage"),
    searchInput: $("#searchInput"),
    typeFilters: $("#typeFilters"),
    cityFilters: $("#cityFilters"),
    sortSelect: $("#sortSelect"),
    exportButton: $("#exportButton"),
    resetButton: $("#resetButton"),
    monitorList: $("#monitorList"),
    settingsButton: $("#settingsButton"),
    settingsDialog: $("#settingsDialog"),
    settingsClose: $("#settingsClose"),
    jobDialog: $("#jobDialog"),
    dialogContent: $("#dialogContent"),
    dialogClose: $("#dialogClose"),
    toast: $("#toast"),
  };

  let toastTimer = 0;

  function readSaved() {
    try {
      return JSON.parse(localStorage.getItem("public-sector-saved") || "[]");
    } catch {
      return [];
    }
  }

  function persistSaved() {
    localStorage.setItem("public-sector-saved", JSON.stringify([...state.saved]));
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
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 3000);
  }

  function formatDateTime(value, fallback = "待公告") {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function formatDeadline(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "待公告";
    const now = new Date();
    const sameDay = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date) === new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    const time = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
    return sameDay ? `今天 ${time}` : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }

  function durationText(milliseconds) {
    if (milliseconds <= 0) return "已截止";
    const total = Math.floor(milliseconds / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (days > 0) return `${days}天 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return [hours, minutes, seconds].map((n) => String(n).padStart(2, "0")).join(":");
  }

  function chinaNowParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  }

  function nextEightAm() {
    const parts = chinaNowParts();
    let target = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
    if (Date.now() >= target) target += 86400000;
    return target;
  }

  function isJobOpen(job) {
    return job.status === "open" && Date.now() < new Date(job.deadline).getTime();
  }

  function isPriority(job) {
    return job.city === "昆明" || job.city === "西安";
  }

  function tickTimes() {
    const registrationDeadline = new Date(DATA.registration.deadline).getTime();
    const deadlineDiff = registrationDeadline - Date.now();
    elements.deadlineCountdown.textContent = deadlineDiff > 0
      ? `剩余 ${durationText(deadlineDiff)}`
      : "报名已截止";
    elements.alertTitle.textContent = deadlineDiff > 0
      ? "2027 国考报名今日 18:00 截止"
      : "国考报名已截止，继续监测事业编与省考公告";

    const nextDiff = Math.max(0, nextEightAm() - Date.now());
    elements.countdown.textContent = durationText(nextDiff);
    const nextDate = new Date(nextEightAm());
    elements.nextRun.textContent =
      `${new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "long",
        day: "numeric",
        weekday: "short",
      }).format(nextDate)} · 08:00 · Asia/Shanghai`;
    renderSummary();
  }

  function matchesFilters(job) {
    if (state.type !== "all" && job.category !== state.type) return false;
    if (state.city === "priority" && !isPriority(job)) return false;
    if (state.city === "昆明" && job.city !== "昆明") return false;
    if (state.city === "西安" && job.city !== "西安") return false;
    const query = state.search.trim().toLowerCase();
    if (!query) return true;
    return `${job.title} ${job.department} ${job.employer} ${job.majors} ${job.city}`
      .toLowerCase()
      .includes(query);
  }

  function filteredJobs() {
    return jobs.filter((job) => isJobOpen(job) && matchesFilters(job)).sort((a, b) => {
      if (state.sort === "less-competition") {
        return (a.applicants / a.openings) - (b.applicants / b.openings) || a.priority - b.priority;
      }
      if (state.sort === "quota") {
        return b.openings - a.openings || a.priority - b.priority;
      }
      return a.priority - b.priority || b.openings - a.openings || a.applicants - b.applicants;
    });
  }

  function renderSummary() {
    const openJobs = jobs.filter(isJobOpen);
    const priorityOpen = openJobs.filter(isPriority);
    elements.matchMetric.textContent = String(jobs.length);
    elements.cityMetric.textContent = String(priorityOpen.filter((job) => job.city === "昆明").length);
    elements.openMetric.textContent = String(openJobs.length);
    elements.fileCount.textContent = String(jobs.length);
    elements.checkedTime.textContent = formatDateTime(DATA.checkedAt);
    elements.resultSummary.textContent =
      `当前 ${openJobs.length} 个职位仍在报名；昆明 ${priorityOpen.filter((job) => job.city === "昆明").length} 个，西安 ${priorityOpen.filter((job) => job.city === "西安").length} 个。`;
  }

  function renderMonitorList() {
    elements.monitorList.innerHTML = DATA.monitors.map((item) => `
      <div class="monitor-item">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="monitor-status ${item.status === "等待公告" ? "waiting" : ""}">${escapeHtml(item.status)}</span>
        <p>${escapeHtml(item.latest)}</p>
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" aria-label="打开${escapeHtml(item.sourceName)}">↗</a>
      </div>
    `).join("");
  }

  function renderCard(job) {
    const priority = isPriority(job);
    const deadline = new Date(job.deadline).getTime() - Date.now();
    const urgent = deadline > 0 && deadline < 8 * 3600000;
    const saved = state.saved.has(job.id);
    return `
      <article class="position-card ${priority ? "priority" : ""}" data-id="${escapeHtml(job.id)}">
        ${priority ? `<span class="priority-ribbon">★ 优先城市</span>` : ""}
        <div class="card-top">
          <div class="category-seal">${escapeHtml(job.category === "公务员" ? "公" : job.category === "参公" ? "参" : "事")}</div>
          <div class="position-title-wrap">
            <div class="card-kicker">
              <span>${escapeHtml(job.category)} · ${escapeHtml(job.exam)}</span>
              <span class="code">${escapeHtml(job.code)}</span>
            </div>
            <h3 title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</h3>
            <p class="employer" title="${escapeHtml(job.employer)}">${escapeHtml(job.employer)}</p>
          </div>
          <span class="open-badge ${isJobOpen(job) ? "" : "closed"}">${isJobOpen(job) ? "报名中" : "已截止"}</span>
        </div>

        <div class="card-tags">
          <span class="tag major">泰语 / 亚非语言文学</span>
          <span class="tag education">${escapeHtml(job.education)}</span>
          <span class="tag">${escapeHtml(job.examType)}</span>
          <span class="tag">${escapeHtml(job.political)}</span>
          ${job.gender !== "不限" ? `<span class="tag">限${escapeHtml(job.gender)}</span>` : ""}
        </div>

        <div class="fact-grid">
          <div class="fact">
            <span>工作地点</span>
            <strong title="${escapeHtml(job.location)}">${escapeHtml(job.location)}</strong>
          </div>
          <div class="fact">
            <span>招录 / 报名</span>
            <strong>${job.openings} 人 · ${job.applicants} 人</strong>
          </div>
          <div class="fact">
            <span>报名截止</span>
            <strong class="${urgent ? "urgency" : ""}">${escapeHtml(formatDeadline(job.deadline))}</strong>
          </div>
        </div>

        <div class="apply-row">
          <div class="apply-hint">
            <strong>报名方式：官方专题网站在线申请</strong>
            <span>凭职位代码 ${escapeHtml(job.code)} 检索并提交</span>
          </div>
          <div class="card-actions">
            <button class="bookmark-button ${saved ? "saved" : ""}" type="button" data-action="save" aria-label="${saved ? "取消收藏" : "收藏职位"}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.6L6 21V4.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
            </button>
            <button class="detail-button" type="button" data-action="detail">查看条件与入口</button>
          </div>
        </div>
        <div class="card-footer">
          <span>${escapeHtml(job.source)}</span>
          <span>${job.approved} 人已通过审核</span>
        </div>
      </article>
    `;
  }

  function updateEmptyMessage(list) {
    if (state.city === "西安") {
      elements.emptyMessage.textContent = "西安当前未发现泰语 / 亚非语言文学、本科及以上的开放职位。系统会继续监测官方公告。";
    } else if (state.type === "事业单位") {
      elements.emptyMessage.textContent = "当前没有已核验、仍在报名期内的泰语相关事业单位岗位。新增公告会在每日检索后出现。";
    } else if (state.type === "参公") {
      elements.emptyMessage.textContent = "当前没有已核验、仍在报名期内的泰语相关参公岗位。省考及参公公告发布后会自动纳入。";
    } else {
      elements.emptyMessage.textContent = "当前没有符合筛选条件且仍在报名期内的职位。可重置筛选或等待下一次自动检索。";
    }
  }

  function render() {
    const list = filteredJobs();
    elements.positionList.innerHTML = list.map(renderCard).join("");
    elements.emptyState.hidden = list.length > 0;
    elements.visibleCount.textContent = `${list.length} 个可报职位 · ${state.saved.size} 个已收藏`;
    if (!list.length) updateEmptyMessage(list);
    document.querySelectorAll("[data-type]").forEach((button) => {
      button.classList.toggle("active", button.dataset.type === state.type);
    });
    document.querySelectorAll("[data-city]").forEach((button) => {
      button.classList.toggle("active", button.dataset.city === state.city);
    });
    renderSummary();
  }

  function findJob(button) {
    const card = button.closest(".position-card");
    return card ? jobs.find((job) => job.id === card.dataset.id) : null;
  }

  function openDialog(job) {
    elements.dialogContent.innerHTML = `
      <div class="dialog-body">
        <div class="dialog-head">
          <div class="category-seal">${escapeHtml(job.category === "公务员" ? "公" : job.category === "参公" ? "参" : "事")}</div>
          <div>
            <h2>${escapeHtml(job.title)}</h2>
            <p>${escapeHtml(job.department)} · ${escapeHtml(job.employer)}</p>
            <span class="dialog-code">职位代码 ${escapeHtml(job.code)}</span>
          </div>
        </div>
        <div class="notice-box">
          <strong>报名截止：${escapeHtml(formatDeadline(job.deadline))}</strong><br />
          当前页面用于辅助筛选。专业名称、资格证书、应届身份和政治面貌等必须以官方职位表、招录单位审核结果为准。
        </div>
        <div class="dialog-facts">
          <div class="dialog-fact"><span>工作地点</span><strong>${escapeHtml(job.location)}</strong></div>
          <div class="dialog-fact"><span>学历 / 学位</span><strong>${escapeHtml(job.education)} · ${escapeHtml(job.degree)}</strong></div>
          <div class="dialog-fact"><span>专业要求</span><strong>${escapeHtml(job.majors)}</strong></div>
          <div class="dialog-fact"><span>政治面貌 / 基层经历</span><strong>${escapeHtml(job.political)} · ${escapeHtml(job.experience)}</strong></div>
          <div class="dialog-fact"><span>招录人数</span><strong>${job.openings} 人</strong></div>
          <div class="dialog-fact"><span>当前报名 / 合格</span><strong>${job.applicants} / ${job.approved} 人</strong></div>
        </div>
        <div class="dialog-section">
          <h3>附加条件</h3>
          <ul class="condition-list">
            ${job.restrictions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </div>
        <div class="dialog-section">
          <h3>报名步骤</h3>
          <ol class="application-steps">
            <li>进入国家公务员考试专题网站，完成注册与实名认证</li>
            <li>按部门代码和职位代码 ${escapeHtml(job.code)} 检索职位</li>
            <li>逐项核对专业、学历、政治面貌及备注限制后提交</li>
            <li>持续查看资格审查状态；通过后按时完成报名确认</li>
          </ol>
        </div>
        <div class="dialog-actions">
          <a class="primary-button" href="${escapeHtml(job.officialUrl)}" target="_blank" rel="noopener noreferrer">进入官方报名入口</a>
          <button class="secondary-button" id="copyCodeButton" type="button">复制职位代码</button>
        </div>
      </div>
    `;
    elements.jobDialog.showModal();
    $("#copyCodeButton").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(job.code);
        showToast("职位代码已复制");
      } catch {
        showToast(`职位代码：${job.code}`);
      }
    });
  }

  function toggleSaved(id) {
    if (state.saved.has(id)) {
      state.saved.delete(id);
      showToast("已取消收藏");
    } else {
      state.saved.add(id);
      showToast("已收藏职位");
    }
    persistSaved();
    render();
  }

  function exportCsv() {
    const list = filteredJobs();
    if (!list.length) {
      showToast("当前没有可导出的职位");
      return;
    }
    const header = ["类型", "职位代码", "职位", "招录机关", "用人单位", "工作地点", "招录人数", "报名人数", "合格人数", "学历", "专业", "报名截止", "官方入口"];
    const rows = list.map((job) => [
      job.category, job.code, job.title, job.department, job.employer, job.location,
      job.openings, job.applicants, job.approved, job.education, job.majors,
      formatDeadline(job.deadline), job.officialUrl,
    ]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `编制岗位清单-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast(`已导出 ${list.length} 个职位`);
  }

  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
  });
  elements.typeFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-type]");
    if (!button) return;
    state.type = button.dataset.type;
    render();
  });
  elements.cityFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-city]");
    if (!button) return;
    state.city = button.dataset.city;
    render();
  });
  elements.sortSelect.addEventListener("change", (event) => {
    state.sort = event.target.value;
    render();
  });
  elements.positionList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const job = findJob(button);
    if (!job) return;
    if (button.dataset.action === "save") toggleSaved(job.id);
    if (button.dataset.action === "detail") openDialog(job);
  });
  elements.exportButton.addEventListener("click", exportCsv);
  elements.resetButton.addEventListener("click", () => {
    state.type = "all";
    state.city = "all";
    state.search = "";
    state.sort = "priority";
    elements.searchInput.value = "";
    elements.sortSelect.value = "priority";
    render();
  });
  elements.settingsButton.addEventListener("click", () => elements.settingsDialog.showModal());
  elements.settingsClose.addEventListener("click", () => elements.settingsDialog.close());
  elements.dialogClose.addEventListener("click", () => elements.jobDialog.close());
  elements.jobDialog.addEventListener("click", (event) => {
    if (event.target === elements.jobDialog) elements.jobDialog.close();
  });
  elements.settingsDialog.addEventListener("click", (event) => {
    if (event.target === elements.settingsDialog) elements.settingsDialog.close();
  });

  renderMonitorList();
  render();
  tickTimes();
  window.setInterval(tickTimes, 1000);
})();
