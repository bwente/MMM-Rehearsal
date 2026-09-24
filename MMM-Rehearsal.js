Module.register("MMM-Rehearsal", {
  defaults: {
    focusLines: 3,
    fontSize: 54,
    showProgress: true,
    showTargetTime: true,
    showCues: true,
    focusPosition: 48,
    textAlign: "center",
    lineSpacing: 1.35,
    contrast: "high",
    hideOtherModules: true,
    controllerUrl: ""
  },

  start() {
    this.state = { status: "idle", position: 0, elapsed: 0, target: 0, script: null };
    this.parsed = { blocks: [], wordCount: 0 };
    this.visibilityLocked = false;
    this.timer = setInterval(() => {
      if (this.state.status === "running" && this.state.startedAt) {
        this.state.elapsed = Math.floor((Date.now() - this.state.startedAt) / 1000);
        this.updateLiveDom();
      }
    }, 1000);
    const animate = () => {
      this.updateClassicScroll();
      this.animationFrame = requestAnimationFrame(animate);
    };
    this.animationFrame = requestAnimationFrame(animate);
    this.sendSocketNotification("REHEARSAL_READY", { controllerUrl: this.config.controllerUrl });
  },

  getStyles() {
    return ["MMM-Rehearsal.css"];
  },

  getTranslations() {
    return {
      bg: "translations/bg.json", da: "translations/da.json", de: "translations/de.json",
      en: "translations/en.json", es: "translations/es.json", fr: "translations/fr.json",
      hu: "translations/hu.json", nl: "translations/nl.json", ru: "translations/ru.json",
      th: "translations/th.json"
    };
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== "REHEARSAL_STATE") return;
    const previous = this.state;
    const scriptChanged = payload.script?.text !== previous.script?.text;
    const statusChanged = payload.status !== previous.status;
    const modeChanged = payload.displaySettings?.mode !== previous.displaySettings?.mode;
    const fontChanged = payload.displaySettings?.fontSize !== previous.displaySettings?.fontSize;
    if (scriptChanged) this.parsed = this.parseScript(payload.script?.text || "");
    this.state = payload;
    this.updateVisibilityLock();
    this.sendNotification("REHEARSAL_STATE", payload);

    if (scriptChanged || statusChanged || modeChanged || !this.getRenderedRoot()) {
      this.updateDom(0);
      return;
    }

    const root = this.getRenderedRoot();
    root.style.setProperty("--rehearsal-font-size", `${this.getFontSize()}px`);
    if (fontChanged && this.getPresentationMode() === "classic") requestAnimationFrame(() => this.measureClassicScroll());
    if (this.getPresentationMode() !== "classic" && this.getActiveBlockIndex(payload.position) !== this.getActiveBlockIndex(previous.position)) {
      this.renderStage(root.querySelector(".rehearsal__stage"));
    }
    this.updateLiveDom(root);
  },

  notificationReceived(notification, payload, sender) {
    if (sender?.name === this.name || !notification.startsWith("REHEARSAL_")) return;
    const actions = {
      REHEARSAL_LOAD: "load", REHEARSAL_START: "start", REHEARSAL_PAUSE: "pause",
      REHEARSAL_RESUME: "resume", REHEARSAL_RESTART: "restart", REHEARSAL_POSITION: "position",
      REHEARSAL_STOP: "stop", REHEARSAL_SETTINGS: "settings"
    };
    const action = actions[notification];
    if (action) this.sendSocketNotification("REHEARSAL_COMMAND", { action, ...(payload || {}) });
  },

  getRenderedRoot() {
    return document.getElementById(this.identifier)?.querySelector(".rehearsal") || null;
  },

  updateVisibilityLock() {
    const shouldLock = Boolean(this.config.hideOtherModules) && ["ready", "running", "paused"].includes(this.state.status);
    if (shouldLock === this.visibilityLocked) return;
    MM.getModules().exceptModule(this).enumerate((module) => {
      if (shouldLock) module.hide(0, { lockString: this.identifier });
      else module.show(0, { lockString: this.identifier });
    });
    this.visibilityLocked = shouldLock;
  },

  suspend() {
    if (!this.visibilityLocked) return;
    MM.getModules().exceptModule(this).enumerate((module) => module.show(0, { lockString: this.identifier }));
    this.visibilityLocked = false;
  },

  resume() {
    this.updateVisibilityLock();
  },

  getFontSize() {
    return Math.max(28, Math.min(72, Number(this.state.displaySettings?.fontSize || this.config.fontSize) || 54));
  },

  getActiveBlockIndex(position) {
    return this.parsed.blocks.findIndex((block) => block.type === "speech" && position >= block.start && position <= block.end);
  },

  getPresentationMode() {
    return ["focus", "auto", "classic"].includes(this.state.displaySettings?.mode) ? this.state.displaySettings.mode : "focus";
  },

  parseScript(text) {
    const blocks = [];
    let index = 0;
    const chunks = String(text).replace(/\r/g, "").replace(/^\s*(\[[^\]\n]+])\s*$/gm, "\n\n$1\n\n").split(/\n\s*\n/);
    chunks.forEach((raw) => {
      const value = raw.trim();
      if (!value) return;
      const cue = value.match(/^\s*\[([^\]]+)]\s*$/);
      if (cue) {
        blocks.push({ type: "cue", text: cue[1], start: index, end: index });
        return;
      }
      (value.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [value]).forEach((part) => {
        const sentence = part.trim();
        const count = (sentence.toLowerCase().match(/[\p{L}\p{M}\p{N}']+/gu) || []).length;
        if (!count) return;
        blocks.push({ type: "speech", text: sentence, start: index, end: index + count - 1 });
        index += count;
      });
    });
    return { blocks, wordCount: index };
  },

  getDom() {
    const root = document.createElement("section");
    root.className = `rehearsal rehearsal--${this.state.status} rehearsal--${this.config.contrast}`;
    root.style.setProperty("--rehearsal-font-size", `${this.getFontSize()}px`);
    root.style.setProperty("--rehearsal-line-height", this.config.lineSpacing);
    root.style.setProperty("--rehearsal-focus", `${this.config.focusPosition}%`);
    root.style.textAlign = this.config.textAlign;

    if (["idle", "ready"].includes(this.state.status)) return this.getReadyDom(root);
    if (this.state.status === "complete") return this.getCompleteDom(root);

    const stage = document.createElement("div");
    stage.className = `rehearsal__stage rehearsal__stage--${this.getPresentationMode()}`;
    this.renderStage(stage);
    root.appendChild(stage);
    root.appendChild(this.getProgressDom());
    if (this.state.status === "paused") {
      const paused = document.createElement("div");
      paused.className = "rehearsal__paused";
      paused.textContent = this.translate("PAUSED");
      root.appendChild(paused);
    }
    return root;
  },

  renderStage(stage) {
    if (!stage) return;
    if (this.getPresentationMode() === "classic") {
      const content = document.createElement("div");
      content.className = "rehearsal__scroll-content";
      this.parsed.blocks.forEach((block) => {
        if (block.type === "cue" && !this.config.showCues) return;
        const line = document.createElement("div");
        line.className = block.type === "cue" ? "rehearsal__cue" : "rehearsal__line";
        line.textContent = block.type === "cue" ? block.text.toUpperCase() : block.text;
        content.appendChild(line);
      });
      stage.replaceChildren(content);
      requestAnimationFrame(() => {
        this.measureClassicScroll();
        this.updateClassicScroll();
      });
      return;
    }
    const activeIndex = this.getActiveBlockIndex(this.state.position);
    const visibleCount = Math.max(1, Math.min(5, Number(this.config.focusLines) || 3));
    const speechIndices = this.parsed.blocks.reduce((indices, block, index) => {
      if (block.type === "speech") indices.push(index);
      return indices;
    }, []);
    const activeSpeechIndex = Math.max(0, speechIndices.indexOf(activeIndex));
    const before = Math.floor((visibleCount - 1) / 2);
    let firstSpeech = Math.max(0, activeSpeechIndex - before);
    let lastSpeech = Math.min(speechIndices.length, firstSpeech + visibleCount);
    firstSpeech = Math.max(0, lastSpeech - visibleCount);
    const from = speechIndices[firstSpeech] ?? 0;
    const to = (speechIndices[lastSpeech - 1] ?? activeIndex) + 1;
    const fragment = document.createDocumentFragment();
    this.parsed.blocks.slice(from, to).forEach((block, offset) => {
      if (block.type === "cue" && !this.config.showCues) return;
      const absoluteIndex = from + offset;
      const line = document.createElement("div");
      line.className = block.type === "cue" ? "rehearsal__cue" : "rehearsal__line";
      if (absoluteIndex === activeIndex) line.classList.add("is-active");
      else if (absoluteIndex < activeIndex) line.classList.add("is-past");
      else line.classList.add("is-upcoming");
      line.textContent = block.type === "cue" ? block.text.toUpperCase() : block.text;
      fragment.appendChild(line);
    });
    stage.replaceChildren(fragment);
  },

  getReadyDom(root) {
    root.classList.add("rehearsal--ready");
    const content = document.createElement("div");
    content.className = "rehearsal__ready";
    const heading = document.createElement("div");
    heading.className = "rehearsal__ready-title";
    heading.textContent = this.state.status === "ready" ? this.state.script?.title || this.translate("READY_TO_REHEARSE") : this.translate("READY_TO_REHEARSE");
    content.appendChild(heading);
    const qr = document.createElement("img");
    qr.className = "rehearsal__qr";
    qr.src = "/rehearsal/qr";
    qr.alt = this.translate("OPEN_CONTROLLER");
    content.appendChild(qr);
    const hint = document.createElement("div");
    hint.className = "rehearsal__ready-hint";
    hint.textContent = this.state.status === "ready" ? this.translate("START_FROM_CONTROLLER") : this.translate("SCAN_TO_OPEN");
    content.appendChild(hint);
    root.appendChild(content);
    return root;
  },

  getCompleteDom(root) {
    const content = document.createElement("div");
    content.className = "rehearsal__complete";
    const summary = this.state.summary || {};
    content.innerHTML = `<div class="rehearsal__complete-mark">✓</div><div>${this.translate("REHEARSAL_COMPLETE")}</div>`;
    const metrics = document.createElement("div");
    metrics.className = "rehearsal__results";
    [
      ["DURATION", this.formatTime(summary.duration ?? this.state.elapsed)],
      ["TARGET", summary.target ? this.formatTime(summary.target) : "—"],
      ["AVERAGE_PACE", summary.voiceAnalyzed ? `${Math.round(summary.pace || 0)} ${this.translate("WPM")}` : "—"],
      ["LONGEST_PAUSE", summary.voiceAnalyzed ? `${Number(summary.longestPause || 0).toFixed(1)} ${this.translate("SECONDS_SHORT")}` : "—"],
      ["SCRIPT_COVERED", summary.voiceAnalyzed ? `${Math.round(summary.coverage || 0)}%` : "—"],
      ["ANALYSIS", this.translate(summary.voiceAnalyzed ? "VOICE" : "TIMING_ONLY")]
    ].forEach(([label, value]) => {
      const metric = document.createElement("div");
      metric.innerHTML = `<span>${this.translate(label)}</span><strong>${value}</strong>`;
      metrics.appendChild(metric);
    });
    content.appendChild(metrics);
    root.appendChild(content);
    return root;
  },

  getProgressDom() {
    const footer = document.createElement("footer");
    footer.className = "rehearsal__footer";
    const progress = this.parsed.wordCount ? Math.min(1, this.state.position / Math.max(1, this.parsed.wordCount - 1)) : 0;
    if (this.config.showProgress) {
      const track = document.createElement("div");
      track.className = "rehearsal__progress";
      track.innerHTML = `<span style="width:${Math.round(progress * 100)}%"></span>`;
      footer.appendChild(track);
    }
    const timing = document.createElement("div");
    timing.className = "rehearsal__timing";
    const target = Number(this.state.target) || 0;
    timing.textContent = `${this.formatTime(this.state.elapsed)}${this.config.showTargetTime && target ? ` / ${this.formatTime(target)}` : ""}`;
    if (target) {
      const expected = Math.min(1, this.state.elapsed / target);
      timing.dataset.pace = progress > expected + 0.08 ? "ahead" : progress < expected - 0.08 ? "behind" : "on";
    }
    footer.appendChild(timing);
    return footer;
  },

  updateLiveDom(root = this.getRenderedRoot()) {
    if (!root) return;
    const progress = this.parsed.wordCount ? Math.min(1, this.state.position / Math.max(1, this.parsed.wordCount - 1)) : 0;
    const progressBar = root.querySelector(".rehearsal__progress span");
    if (progressBar) progressBar.style.width = `${Math.round(progress * 100)}%`;
    const timing = root.querySelector(".rehearsal__timing");
    if (!timing) return;
    const target = Number(this.state.target) || 0;
    timing.textContent = `${this.formatTime(this.state.elapsed)}${this.config.showTargetTime && target ? ` / ${this.formatTime(target)}` : ""}`;
    if (target) {
      const expected = Math.min(1, this.state.elapsed / target);
      timing.dataset.pace = progress > expected + 0.08 ? "ahead" : progress < expected - 0.08 ? "behind" : "on";
    } else {
      delete timing.dataset.pace;
    }
  },

  updateClassicScroll() {
    if (this.getPresentationMode() !== "classic" || !["running", "paused"].includes(this.state.status)) return;
    const root = this.getRenderedRoot();
    const stage = root?.querySelector(".rehearsal__stage--classic");
    const content = stage?.querySelector(".rehearsal__scroll-content");
    if (!stage || !content) return;
    if (!content.dataset.scrollDistance) this.measureClassicScroll();
    const target = Number(this.state.target) || 0;
    const pace = Math.max(60, Math.min(220, Number(this.state.displaySettings?.paceWpm) || 130));
    const wordsPerSecond = target ? this.parsed.wordCount / target : pace / 60;
    const anchor = this.state.displaySettings?.classicAnchor || { position: this.state.position, elapsed: this.state.elapsed };
    const liveElapsed = this.state.status === "running" && this.state.startedAt
      ? Math.max(0, (Date.now() - this.state.startedAt) / 1000)
      : Math.max(0, Number(this.state.elapsed) || 0);
    const secondsSinceAnchor = Math.max(0, liveElapsed - (Number(anchor.elapsed) || 0));
    const livePosition = (Number(anchor.position) || 0) + secondsSinceAnchor * wordsPerSecond;
    const progress = this.parsed.wordCount ? Math.min(1, livePosition / Math.max(1, this.parsed.wordCount - 1)) : 0;
    const distance = Number(content.dataset.scrollDistance) || 0;
    content.style.transform = `translate3d(0, ${-distance * progress}px, 0)`;
  },

  measureClassicScroll() {
    const content = this.getRenderedRoot()?.querySelector(".rehearsal__scroll-content");
    if (!content) return;
    const lineHeight = this.getFontSize() * Number(this.config.lineSpacing || 1.35);
    content.dataset.scrollDistance = String(Math.max(0, content.scrollHeight - lineHeight));
  },

  formatTime(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  }
});
