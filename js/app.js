(function(){
  "use strict";

  const CONFIG = {
    API_BASE_URL: "",
    ANALYZE_PATH: "/v1/analyze",
    DOWNLOAD_PATH: "/v1/download",
    PROGRESS_PATH: "/v1/progress",
    REQUEST_TIMEOUT_MS: 20000,
    POLL_INTERVAL_MS: 1200
  };

  const el = (id) => document.getElementById(id);
  const dom = {
    form: el("analyzeForm"), input: el("videoUrl"), pasteBtn: el("pasteBtn"), analyzeBtn: el("analyzeBtn"),
    errorBanner: el("errorBanner"), errorTitle: el("errorTitle"), errorMessage: el("errorMessage"),
    skeleton: el("skeleton"), result: el("resultSection"),
    thumbImg: el("thumbImg"), durationBadge: el("durationBadge"), videoTitle: el("videoTitle"),
    sourceText: el("sourceText"), formatTag: el("formatTag"), qualityGrid: el("qualityGrid"),
    downloadBtn: el("downloadBtn"), downloadBtnLabel: el("downloadBtnLabel"), estSizeNote: el("estSizeNote"),
    progressWrap: el("progressWrap"), progressStatus: el("progressStatus"), progressPct: el("progressPct"), progressFill: el("progressFill"),
    successMsg: el("successMsg"), successText: el("successText"), dlErrorMsg: el("dlErrorMsg"), dlErrorText: el("dlErrorText"),
    navToggle: el("navToggle"), primaryNav: el("primaryNav")
  };

  let state = { video: null, selectedFormatId: null, pollTimer: null, downloading: false };

  function closeNav(){
    dom.primaryNav.classList.remove("open");
    dom.navToggle.setAttribute("aria-expanded", "false");
  }
  dom.navToggle.addEventListener("click", () => {
    const open = dom.primaryNav.classList.toggle("open");
    dom.navToggle.setAttribute("aria-expanded", String(open));
  });
  dom.primaryNav.addEventListener("click", (e) => {
    if (e.target.closest("a")) closeNav();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeNav();
  });

  function fmtDuration(sec){
    if (sec == null || isNaN(sec)) return "";
    sec = Math.round(sec);
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    const pad = n => String(n).padStart(2,"0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function fmtSize(bytes){
    if (bytes == null || isNaN(bytes)) return null;
    const units = ["B","KB","MB","GB"];
    let i = 0, v = bytes;
    while (v >= 1024 && i < units.length-1){ v/=1024; i++; }
    return `${v.toFixed(v < 10 && i>0 ? 1 : 0)} ${units[i]}`;
  }
  function isLikelyUrl(str){
    try { const u = new URL(str.trim()); return u.protocol === "http:" || u.protocol === "https:"; }
    catch(e){ return false; }
  }
  function showError(title, message){
    dom.errorTitle.textContent = title;
    dom.errorMessage.textContent = message;
    dom.errorBanner.classList.add("show");
  }
  function clearError(){ dom.errorBanner.classList.remove("show"); }

  async function apiRequest(path, options = {}){
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${CONFIG.API_BASE_URL}${path}`, {
        ...options,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
      });
      clearTimeout(timeout);
      if (!res.ok){
        let detail = "";
        try {
          const body = await res.json();
          const e = body && body.error;
          if (e && typeof e === "object") detail = e.message || e.code || "";
          else if (typeof e === "string") detail = e;
          if (!detail && body && typeof body.message === "string") detail = body.message;
        } catch(e){}
        const err = new Error(detail || `Request failed with status ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err){
      clearTimeout(timeout);
      if (err.name === "AbortError") throw new Error("The request timed out. Please try again.");
      if (err instanceof TypeError) throw new Error("Couldn't reach the server. Check your connection and try again.");
      throw err;
    }
  }

  dom.pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { dom.input.value = text.trim(); dom.input.focus(); }
    } catch(e){
      showError("Clipboard unavailable", "Your browser blocked clipboard access. Paste the link manually instead.");
    }
  });

  dom.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();
    const url = dom.input.value.trim();
    if (!isLikelyUrl(url)){
      showError("Invalid URL", "Enter a full video link starting with http:// or https://.");
      return;
    }
    await analyze(url);
  });

  async function analyze(url){
    setAnalyzing(true);
    dom.result.classList.remove("show");
    dom.skeleton.classList.add("show");
    resetDownloadUI();
    try {
      const data = await apiRequest(CONFIG.ANALYZE_PATH, { method: "POST", body: JSON.stringify({ url }) });
      if (!data || !Array.isArray(data.formats) || data.formats.length === 0){
        throw new Error("This link didn't return any downloadable formats.");
      }
      state.video = data;
      state.selectedFormatId = data.bestFormatId || data.formats[0].formatId;
      renderVideo(data);
      dom.result.classList.add("show");
    } catch(err){
      showError("Couldn't analyze this link", err.message || "The source site may not be supported, or the video is unavailable.");
    } finally {
      dom.skeleton.classList.remove("show");
      setAnalyzing(false);
    }
  }

  function setAnalyzing(isLoading){
    dom.analyzeBtn.disabled = isLoading;
    dom.analyzeBtn.classList.toggle("loading", isLoading);
    dom.pasteBtn.disabled = isLoading;
  }

  function renderVideo(v){
    dom.thumbImg.src = v.thumbnailUrl || "";
    dom.thumbImg.alt = v.title ? `Thumbnail for ${v.title}` : "Video thumbnail";
    dom.durationBadge.textContent = fmtDuration(v.durationSeconds);
    dom.durationBadge.style.display = v.durationSeconds != null ? "block" : "none";
    dom.videoTitle.textContent = v.title || "Untitled video";
    dom.sourceText.textContent = v.source || "Unknown source";
    const container = v.formats.find(f => f.formatId === (v.bestFormatId || ""))?.container || v.formats[0].container;
    dom.formatTag.textContent = container ? container.toUpperCase() : "";
    dom.formatTag.style.display = container ? "inline-flex" : "none";

    dom.qualityGrid.innerHTML = "";
    v.formats.forEach(f => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "q-chip" + (f.formatId === state.selectedFormatId ? " selected" : "");
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", f.formatId === state.selectedFormatId ? "true" : "false");
      const isBest = f.formatId === v.bestFormatId;
      chip.innerHTML = `${isBest ? '<span class="best-badge">BEST</span>' : ""}
        <span class="res">${f.quality}</span>
        <span class="sz">${fmtSize(f.fileSizeBytes) || f.container?.toUpperCase() || ""}</span>`;
      chip.addEventListener("click", () => selectFormat(f.formatId));
      dom.qualityGrid.appendChild(chip);
    });
    updateSizeNote();
  }

  function selectFormat(formatId){
    state.selectedFormatId = formatId;
    [...dom.qualityGrid.children].forEach(chip => {
      const res = chip.querySelector(".res").textContent;
      const match = state.video.formats.find(f => f.quality === res && f.formatId === formatId);
      const isSel = !!match;
      chip.classList.toggle("selected", isSel);
      chip.setAttribute("aria-checked", isSel ? "true" : "false");
    });
    updateSizeNote();
  }

  function updateSizeNote(){
    const f = state.video?.formats.find(f => f.formatId === state.selectedFormatId);
    dom.estSizeNote.textContent = f && f.fileSizeBytes ? `Est. size: ${fmtSize(f.fileSizeBytes)}` : "";
  }

  dom.downloadBtn.addEventListener("click", startDownload);

  function resetDownloadUI(){
    dom.progressWrap.classList.remove("show");
    dom.progressFill.style.width = "0%";
    dom.successMsg.classList.remove("show");
    dom.dlErrorMsg.classList.remove("show");
    dom.downloadBtn.disabled = false;
    dom.downloadBtnLabel.textContent = "Download";
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    state.downloading = false;
  }

  async function startDownload(){
    if (!state.video || !state.selectedFormatId || state.downloading) return;
    resetDownloadUI();
    state.downloading = true;
    dom.downloadBtn.disabled = true;
    dom.analyzeBtn.disabled = true;
    dom.downloadBtnLabel.textContent = "Preparing…";
    dom.progressWrap.classList.add("show");
    setProgress(0, "Starting download…");

    try {
      const { jobId } = await apiRequest(CONFIG.DOWNLOAD_PATH, {
        method: "POST",
        body: JSON.stringify({ url: dom.input.value.trim(), formatId: state.selectedFormatId })
      });
      if (!jobId) throw new Error("The server didn't return a job to track.");
      pollProgress(jobId);
    } catch(err){
      failDownload(err.message || "Couldn't start the download.");
    }
  }

  function pollProgress(jobId){
    state.pollTimer = setInterval(async () => {
      try {
        const p = await apiRequest(`${CONFIG.PROGRESS_PATH}/${encodeURIComponent(jobId)}`, { method: "GET" });
        setProgress(p.percent ?? 0, p.message || statusLabel(p.status));
        if (p.status === "completed"){
          clearInterval(state.pollTimer); state.pollTimer = null;
          completeDownload(p.downloadUrl);
        } else if (p.status === "failed"){
          clearInterval(state.pollTimer); state.pollTimer = null;
          failDownload(p.error || "The download failed on the server.");
        }
      } catch(err){
        clearInterval(state.pollTimer); state.pollTimer = null;
        failDownload(err.message || "Lost connection while tracking progress.");
      }
    }, CONFIG.POLL_INTERVAL_MS);
  }

  function statusLabel(status){
    return { queued: "Queued…", processing: "Processing…" }[status] || "Working…";
  }
  function setProgress(pct, statusText){
    pct = Math.max(0, Math.min(100, pct));
    dom.progressFill.style.width = pct + "%";
    dom.progressPct.textContent = Math.round(pct) + "%";
    dom.progressStatus.textContent = statusText;
    dom.downloadBtnLabel.textContent = "Downloading…";
  }
  function completeDownload(downloadUrl){
    dom.progressWrap.classList.remove("show");
    dom.downloadBtn.disabled = false;
    dom.analyzeBtn.disabled = false;
    dom.downloadBtnLabel.textContent = "Download";
    state.downloading = false;
    if (downloadUrl){
      dom.successText.innerHTML = `Your file is ready. <a class="file-link" href="${downloadUrl}" target="_blank" rel="noopener">Download</a>.`;
    } else {
      dom.successText.textContent = "Your file is ready.";
    }
    dom.successMsg.classList.add("show");
  }
  function failDownload(message){
    dom.progressWrap.classList.remove("show");
    dom.downloadBtn.disabled = false;
    dom.analyzeBtn.disabled = false;
    dom.downloadBtnLabel.textContent = "Retry download";
    state.downloading = false;
    dom.dlErrorText.textContent = message;
    dom.dlErrorMsg.classList.add("show");
  }
})();