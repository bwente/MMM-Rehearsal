const $ = (selector) => document.querySelector(selector);
const views = [$("#editorView"), $("#sessionView"), $("#summaryView")];
const fallbackMessages = {
  READY_TO_REHEARSE: "Ready to rehearse", YOUR_SCRIPTS: "Your scripts", LISTENING: "Listening",
  AUTO_PACING: "Auto pacing", RUNNING: "Running", PAUSED: "Paused", READY: "Ready",
  PAUSE: "Pause", CONTINUE: "Continue", START: "Start", NICE_WORK: "Nice work.",
  WPM: "WPM", SECONDS_SHORT: "sec", MIRROR_CONNECTED: "Mirror connected", RECONNECTING: "Reconnecting"
};
let messages = { ...fallbackMessages };
let scripts = [];
let activeScript = null;
let parsed = { blocks: [], words: [] };
let state = { status: "idle", position: 0, elapsed: 0 };
let startedAt = 0;
let timer = null;
let recognition = null;
let transcriptBuffer = [];
let positionSyncPromise = null;
let queuedPosition = null;
let lastSyncedSecond = -1;
let longestPause = 0;
let lastSpeechAt = 0;
let fontSize = 54;
let paceWpm = 130;
let autoPaceAnchor = { elapsed: 0, position: 0 };
let autoEndTimer = null;
let endingSession = false;

function t(key) {
  return messages[key] || key;
}

async function loadTranslations() {
  const supported = ["bg", "da", "de", "en", "es", "fr", "hu", "nl", "ru", "th"];
  const requested = String(navigator.language || "en").toLowerCase().split("-")[0];
  const language = supported.includes(requested) ? requested : "en";
  document.documentElement.lang = language;
  messages = { ...fallbackMessages, ...await fetch(`/rehearsal/i18n/${language}`).then((response) => response.json()) };
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const value = messages[element.dataset.i18n];
    if (value) element.textContent = value;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const value = messages[element.dataset.i18nPlaceholder];
    if (value) element.placeholder = value;
  });
}

function showView(view) {
  views.forEach((item) => { item.hidden = item !== view; });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("is-visible");
  clearTimeout(element.timer);
  element.timer = setTimeout(() => element.classList.remove("is-visible"), 2200);
}

function formatTime(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function parseDuration(value) {
  const parts = String(value || "").trim().split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] || 0;
}

function normalize(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{M}\p{N}'\s]/gu, " ").split(/\s+/).map((word) => word.replace(/^'+|'+$/g, "")).filter(Boolean);
}

function parseScript(text) {
  const blocks = [];
  const words = [];
  let index = 0;
  const chunks = String(text || "").replace(/\r/g, "").replace(/^\s*(\[[^\]\n]+])\s*$/gm, "\n\n$1\n\n").split(/\n\s*\n/);
  chunks.forEach((raw) => {
    const value = raw.trim();
    if (!value) return;
    const cue = value.match(/^\s*\[([^\]]+)]\s*$/);
    if (cue) return blocks.push({ type: "cue", text: cue[1], start: index, end: index });
    (value.match(/[^.!?]+(?:[.!?]+[\"')\]]*|$)/g) || [value]).forEach((part) => {
      const sentence = part.trim();
      const tokens = normalize(sentence);
      if (!tokens.length) return;
      const blockIndex = blocks.length;
      tokens.forEach((word) => words.push({ word, block: blockIndex, index: index++ }));
      blocks.push({ type: "speech", text: sentence, words: tokens, start: index - tokens.length, end: index - 1 });
    });
  });
  return { blocks, words };
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return Math.max(0, 1 - matrix[a.length][b.length] / Math.max(a.length, b.length));
}

function locate(transcript, current) {
  const spoken = normalize(transcript).slice(-18);
  if (!spoken.length) return { position: current, confidence: 0 };
  const expectedWords = parsed.words.map((entry) => entry.word);
  const scoreAt = (start) => {
    const expected = expectedWords.slice(start, start + spoken.length + 7);
    let score = 0;
    let cursor = 0;
    spoken.forEach((word) => {
      let best = 0;
      let bestIndex = cursor;
      for (let i = cursor; i < Math.min(expected.length, cursor + 5); i += 1) {
        const candidate = similarity(word, expected[i]) - (i - cursor) * .06;
        if (candidate > best) { best = candidate; bestIndex = i; }
      }
      if (best >= .55) { score += best; cursor = bestIndex + 1; }
    });
    return { confidence: score / Math.max(spoken.length, expected.length * .65), consumed: cursor };
  };
  const evaluate = (from, to, distancePenalty) => {
    let best = { position: current, confidence: 0, weighted: -Infinity };
    for (let start = from; start <= to; start += 1) {
      const alignment = scoreAt(start);
      const confidence = alignment.confidence;
      const weighted = confidence - Math.abs(start - current) * distancePenalty;
      if (weighted > best.weighted) best = { position: Math.min(expectedWords.length - 1, start + Math.max(0, alignment.consumed - 1)), confidence, weighted };
    }
    return best;
  };
  const local = evaluate(Math.max(0, current - 90), Math.min(expectedWords.length - 1, current + 90), .0008);
  if (local.confidence >= .48) return local;
  const global = evaluate(0, expectedWords.length - 1, 0);
  return global.confidence > local.confidence + .08 ? global : local;
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Request failed");
  return response.status === 204 ? null : response.json();
}

async function send(action, extra = {}, adoptResponse = true) {
  const response = await api("/rehearsal/api/events", { method: "POST", body: JSON.stringify({ action, ...extra }) });
  if (adoptResponse) state = response;
  return response;
}

async function loadLibrary() {
  scripts = await api("/rehearsal/api/scripts");
  renderLibrary();
}

function renderLibrary() {
  const library = $("#library");
  $("#scriptCount").textContent = scripts.length;
  if (!scripts.length) { library.innerHTML = `<div class="empty">${t("YOUR_SCRIPTS")}</div>`; return; }
  library.replaceChildren(...scripts.map((script) => {
    const item = document.createElement("article");
    item.className = `library-item${script.id === $("#scriptId").value ? " is-active" : ""}`;
    const select = document.createElement("button");
    select.type = "button";
    const strong = document.createElement("strong");
    strong.textContent = script.title;
    const small = document.createElement("small");
    small.textContent = `${normalize(script.text).length} words${script.target ? ` · ${formatTime(script.target)}` : ""}`;
    select.append(strong, small);
    select.onclick = () => populateEditor(script);
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "delete"; remove.textContent = "×"; remove.ariaLabel = `Delete ${script.title}`;
    remove.onclick = async () => { if (!window.confirm(`Delete “${script.title}”?`)) return; await api(`/rehearsal/api/scripts/${script.id}`, { method: "DELETE" }); if ($("#scriptId").value === script.id) clearEditor(); await loadLibrary(); };
    item.append(select, remove);
    return item;
  }));
}

function populateEditor(script) {
  $("#scriptId").value = script.id || ""; $("#title").value = script.title || ""; $("#scriptText").value = script.text || ""; $("#target").value = script.target ? formatTime(script.target) : ""; $("#notes").value = script.notes || ""; renderLibrary();
}

function clearEditor() { $("#scriptForm").reset(); $("#scriptId").value = ""; renderLibrary(); $("#title").focus(); }

function formScript() {
  return { id: $("#scriptId").value || undefined, title: $("#title").value.trim(), text: $("#scriptText").value.trim(), target: parseDuration($("#target").value), notes: $("#notes").value.trim() };
}

async function saveCurrent() {
  if (!$("#scriptForm").reportValidity()) return null;
  const saved = await api("/rehearsal/api/scripts", { method: "POST", body: JSON.stringify(formScript()) });
  populateEditor(saved); await loadLibrary(); toast("Script saved"); return saved;
}

async function prepareSession() {
  const script = formScript();
  if (!script.title || !script.text) { $("#scriptForm").reportValidity(); return; }
  activeScript = scripts.find((item) => item.id === script.id) || script;
  parsed = parseScript(activeScript.text);
  if (!parsed.words.length) { toast("Add spoken text before starting"); return; }
  transcriptBuffer = []; longestPause = 0; lastSpeechAt = 0; lastSyncedSecond = -1; endingSession = false; cancelAutoEnd();
  state = { status: "ready", position: 0, elapsed: 0 };
  await send("load", { script: activeScript });
  $("#sessionTitle").textContent = activeScript.title;
  $("#positionSlider").max = Math.max(0, parsed.words.length - 1);
  $("#positionSlider").value = 0;
  autoPaceAnchor = { elapsed: 0, position: 0 };
  updateAutoPaceHelp();
  updateSession(); showView($("#sessionView"));
}

async function toggleSession() {
  if (["ready", "idle"].includes(state.status)) {
    startedAt = Date.now(); state.elapsed = 0; lastSyncedSecond = -1; autoPaceAnchor = { elapsed: 0, position: state.position || 0 }; await send("start"); startTimer();
  } else if (state.status === "running") {
    cancelAutoEnd(); state.elapsed = elapsed(); await send("pause", { elapsed: state.elapsed }); stopRecognition();
  } else if (state.status === "paused") {
    startedAt = Date.now() - state.elapsed * 1000; await send("resume"); if ($("#micToggle").checked) startRecognition();
  }
  updateSession();
}

function elapsed() { return state.status === "running" ? Math.floor((Date.now() - startedAt) / 1000) : Number(state.elapsed) || 0; }
function startTimer() { clearInterval(timer); timer = setInterval(() => { if (state.status === "running") { state.elapsed = elapsed(); advanceAutoPace(); updateSession(); if (state.elapsed % 2 === 0 && state.elapsed !== lastSyncedSecond) { lastSyncedSecond = state.elapsed; sendPosition(); } } }, 250); if ($("#micToggle").checked) startRecognition(); }
function stopTimer() { clearInterval(timer); timer = null; }

function updateSession() {
  const total = parsed.words.length;
  const progress = total ? state.position / Math.max(1, total - 1) : 0;
  $("#sessionTime").textContent = `${formatTime(elapsed())}${activeScript?.target ? ` / ${formatTime(activeScript.target)}` : ""}`;
  $("#progressBar").style.width = `${Math.round(progress * 100)}%`;
  $("#positionSlider").value = state.position || 0;
  const block = parsed.blocks.find((item) => item.type === "speech" && state.position >= item.start && state.position <= item.end);
  $("#currentText").textContent = block?.text || t("READY_TO_REHEARSE");
  const label = state.status === "running" ? ($("#micToggle").checked ? t("LISTENING") : $("#autoPaceToggle").checked ? t("AUTO_PACING") : t("RUNNING")) : state.status === "paused" ? t("PAUSED") : t("READY");
  $("#sessionStatus").className = `session-status${state.status === "running" ? " is-running" : ""}`;
  $("#sessionStatus").lastChild.textContent = ` ${label}`;
  $("#mainControl").textContent = state.status === "running" ? t("PAUSE") : state.status === "paused" ? t("CONTINUE") : t("START");
}

function sendPosition() {
  queuedPosition = { position: state.position, elapsed: elapsed(), metrics: { longestPause } };
  if (positionSyncPromise) return positionSyncPromise;
  positionSyncPromise = (async () => {
    while (queuedPosition) {
      const snapshot = queuedPosition;
      queuedPosition = null;
      await send("position", snapshot, false);
    }
  })().catch(() => {}).finally(() => {
    positionSyncPromise = null;
    if (queuedPosition) sendPosition();
  });
  return positionSyncPromise;
}

async function movePosition(position, resetAutoAnchor = true) {
  state.position = Math.max(0, Math.min(parsed.words.length - 1, Math.round(position)));
  if (state.position < parsed.words.length - 1) cancelAutoEnd();
  if (resetAutoAnchor) autoPaceAnchor = { elapsed: elapsed(), position: state.position };
  updateSession(); scheduleAutoEnd(); await sendPosition();
}

function autoWordsPerSecond() {
  return activeScript?.target ? parsed.words.length / activeScript.target : paceWpm / 60;
}

function advanceAutoPace() {
  if (!$("#autoPaceToggle").checked || $("#micToggle").checked || !parsed.words.length) return;
  const secondsSinceAnchor = Math.max(0, elapsed() - autoPaceAnchor.elapsed);
  const nextPosition = Math.min(parsed.words.length - 1, Math.floor(autoPaceAnchor.position + secondsSinceAnchor * autoWordsPerSecond()));
  if (nextPosition !== state.position) {
    state.position = nextPosition;
    updateSession();
    scheduleAutoEnd();
    sendPosition();
  }
}

function cancelAutoEnd() {
  window.clearTimeout(autoEndTimer);
  autoEndTimer = null;
}

function scheduleAutoEnd() {
  const atEnd = parsed.words.length && state.position >= parsed.words.length - 1;
  if (!$("#autoEndToggle").checked || state.status !== "running" || !atEnd || endingSession || autoEndTimer) return;
  autoEndTimer = window.setTimeout(() => {
    autoEndTimer = null;
    if ($("#autoEndToggle").checked && state.status === "running" && state.position >= parsed.words.length - 1) endSession();
  }, 2000);
}

function updateAutoPaceHelp() {
  if (activeScript?.target && parsed.words.length) {
    const targetWpm = Math.round((parsed.words.length / activeScript.target) * 60);
    $("#autoPaceHelp").textContent = `${t("TARGET_TIME")} · ${targetWpm} ${t("WPM")}`;
    $("#paceRow").classList.add("is-disabled");
  } else {
    $("#autoPaceHelp").textContent = `${t("AUTO_HELP")} · ${paceWpm} ${t("WPM")}`;
    $("#paceRow").classList.remove("is-disabled");
  }
}

async function restartSession() {
  cancelAutoEnd(); endingSession = false; stopRecognition(); state.position = 0; state.elapsed = 0; state.status = "running"; startedAt = Date.now(); transcriptBuffer = []; longestPause = 0; lastSyncedSecond = -1; autoPaceAnchor = { elapsed: 0, position: 0 }; await send("restart"); startTimer(); updateSession();
}

async function endSession() {
  if (endingSession || state.status === "complete") return;
  endingSession = true;
  cancelAutoEnd();
  stopTimer(); stopRecognition(); state.elapsed = elapsed(); state.status = "complete";
  const coverage = parsed.words.length ? Math.min(100, Math.round(((state.position + 1) / parsed.words.length) * 100)) : 0;
  const pace = state.elapsed ? Math.round(((state.position + 1) / state.elapsed) * 60) : 0;
  const summary = { duration: state.elapsed, target: activeScript?.target || 0, pace, longestPause, coverage };
  await send("stop", { elapsed: state.elapsed, summary });
  $("#summaryTitle").textContent = t("NICE_WORK");
  $("#metricDuration").textContent = formatTime(summary.duration); $("#metricTarget").textContent = summary.target ? formatTime(summary.target) : "—"; $("#metricPace").textContent = `${summary.pace} ${t("WPM")}`; $("#metricPause").textContent = `${summary.longestPause.toFixed(1)} ${t("SECONDS_SHORT")}`; $("#metricCoverage").textContent = `${summary.coverage}%`;
  showView($("#summaryView"));
}

async function enableMicrophone(enabled) {
  if (!enabled) { stopRecognition(); return; }
  $("#autoPaceToggle").checked = false;
  if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) { $("#micToggle").checked = false; toast("Microphone access needs HTTPS"); $("#micHelp").textContent = "Open this controller over HTTPS"; return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) throw new Error("Speech recognition is not supported in this browser");
    recognition = new SpeechRecognition(); recognition.continuous = true; recognition.interimResults = true; recognition.lang = navigator.language || document.documentElement.lang || "en-US";
    recognition.onresult = handleRecognition;
    recognition.onerror = (event) => { if (!["aborted", "no-speech"].includes(event.error)) toast(`Microphone: ${event.error}`); };
    recognition.onend = () => {
      if (!$("#micToggle").checked || state.status !== "running") return;
      window.setTimeout(() => {
        if ($("#micToggle").checked && state.status === "running") startRecognition();
      }, 300);
    };
    $("#micHelp").textContent = t("MIC_HELP");
    if (state.status === "running") startRecognition();
  } catch (error) { $("#micToggle").checked = false; $("#micHelp").textContent = error.message; toast(error.message); }
}

function startRecognition() { if (!recognition) return enableMicrophone(true); try { recognition.start(); } catch (_error) {} }
function stopRecognition() { if (recognition) { try { recognition.abort(); } catch (_error) {} } }

function handleRecognition(event) {
  let interimWords = [];
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const words = normalize(event.results[i][0].transcript);
    if (event.results[i].isFinal) transcriptBuffer.push(...words);
    else interimWords = interimWords.concat(words);
  }
  transcriptBuffer = transcriptBuffer.slice(-24);
  const matchingWords = interimWords.length >= 3
    ? transcriptBuffer.slice(-4).concat(interimWords).slice(-18)
    : transcriptBuffer.slice(-14);
  const heard = transcriptBuffer.slice(-14).concat(interimWords).slice(-18).join(" ");
  $("#transcript").textContent = heard || "Waiting for speech…";
  const match = locate(matchingWords.join(" "), state.position);
  $("#confidence").style.width = `${Math.round(match.confidence * 100)}%`;
  const now = performance.now();
  if (heard && lastSpeechAt) longestPause = Math.max(longestPause, (now - lastSpeechAt) / 1000);
  if (heard) lastSpeechAt = now;
  const threshold = match.position < state.position ? .62 : .30;
  if (match.confidence >= threshold && match.position !== state.position) movePosition(match.position);
}

$("#scriptForm").addEventListener("submit", async (event) => { event.preventDefault(); try { await saveCurrent(); } catch (error) { toast(error.message); } });
$("#startFromEditor").onclick = prepareSession;
$("#newScript").onclick = clearEditor;
$("#mainControl").onclick = toggleSession;
$("#jumpBack").onclick = () => movePosition(state.position - 10);
$("#jumpForward").onclick = () => movePosition(state.position + 10);
$("#restart").onclick = restartSession;
$("#positionSlider").oninput = (event) => movePosition(Number(event.target.value));
$("#micToggle").onchange = (event) => enableMicrophone(event.target.checked);
$("#autoPaceToggle").onchange = (event) => {
  if (event.target.checked) {
    $("#micToggle").checked = false;
    stopRecognition();
    autoPaceAnchor = { elapsed: elapsed(), position: state.position };
  }
  updateSession();
};
$("#autoEndToggle").onchange = (event) => {
  if (event.target.checked) scheduleAutoEnd();
  else cancelAutoEnd();
};
$("#paceDown").onclick = () => changePace(-5);
$("#paceUp").onclick = () => changePace(5);
$("#fontDown").onclick = () => changeFont(-4);
$("#fontUp").onclick = () => changeFont(4);
$("#endSession").onclick = endSession;
$("#rehearseAgain").onclick = () => { cancelAutoEnd(); endingSession = false; state.status = "ready"; state.position = 0; state.elapsed = 0; send("load", { script: activeScript }); updateSession(); showView($("#sessionView")); };
$("#backToScripts").onclick = () => { showView($("#editorView")); loadLibrary(); };

function changeFont(delta) { fontSize = Math.max(28, Math.min(72, fontSize + delta)); $("#fontSize").value = fontSize; send("settings", { settings: { fontSize } }, false); }

function changePace(delta) {
  if (activeScript?.target) return;
  paceWpm = Math.max(60, Math.min(220, paceWpm + delta));
  $("#paceWpm").value = paceWpm;
  autoPaceAnchor = { elapsed: elapsed(), position: state.position };
  updateAutoPaceHelp();
}

function connectEvents() {
  const events = new EventSource("/rehearsal/api/events");
  events.onopen = () => { $(".connection").classList.add("is-online"); $("#connectionText").textContent = t("MIRROR_CONNECTED"); };
  events.onerror = () => { $(".connection").classList.remove("is-online"); $("#connectionText").textContent = t("RECONNECTING"); };
}

async function initialize() {
  try { await loadTranslations(); } catch (_error) { messages = { ...fallbackMessages }; }
  await loadLibrary();
  connectEvents();
}

initialize().catch((error) => toast(error.message));
