"use strict";

const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const QRCode = require("qrcode");

module.exports = NodeHelper.create({
  start() {
    this.state = { status: "idle", position: 0, elapsed: 0, target: 0, script: null, updatedAt: Date.now() };
    this.clients = new Set();
    this.dataDir = path.join(__dirname, "data");
    this.scriptsFile = path.join(this.dataDir, "scripts.json");
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.registerRoutes();
  },

  registerRoutes() {
    const app = this.expressApp;
    app.use("/rehearsal/assets", require("express").static(path.join(__dirname, "controller")));
    app.get("/rehearsal/i18n/:language", (req, res) => {
      const language = String(req.params.language || "en").toLowerCase();
      const supported = ["bg", "da", "de", "en", "es", "fr", "hu", "nl", "ru", "th"];
      res.sendFile(path.join(__dirname, "translations", `${supported.includes(language) ? language : "en"}.json`));
    });
    app.get("/rehearsal", (_req, res) => res.sendFile(path.join(__dirname, "controller", "index.html")));
    app.get("/rehearsal/api/scripts", (_req, res) => res.json(this.readScripts()));
    app.post("/rehearsal/api/scripts", this.jsonParser(), (req, res) => {
      const scripts = this.readScripts();
      const now = new Date().toISOString();
      const incoming = req.body || {};
      if (!String(incoming.title || "").trim() || !String(incoming.text || "").trim()) {
        return res.status(400).json({ error: "A title and script text are required." });
      }
      const existing = scripts.find((item) => item.id === incoming.id);
      const script = {
        id: existing ? existing.id : crypto.randomUUID(),
        title: String(incoming.title).trim().slice(0, 160),
        text: String(incoming.text).slice(0, 250000),
        notes: String(incoming.notes || "").slice(0, 20000),
        target: Math.max(0, Number(incoming.target) || 0),
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        lastRehearsedAt: existing ? existing.lastRehearsedAt || null : null
      };
      if (existing) scripts[scripts.indexOf(existing)] = script;
      else scripts.unshift(script);
      this.writeScripts(scripts);
      return res.json(script);
    });
    app.delete("/rehearsal/api/scripts/:id", (req, res) => {
      const scripts = this.readScripts();
      this.writeScripts(scripts.filter((item) => item.id !== req.params.id));
      res.status(204).end();
    });
    app.get("/rehearsal/api/state", (_req, res) => res.json(this.state));
    app.post("/rehearsal/api/events", this.jsonParser(), (req, res) => {
      this.applyEvent(req.body || {});
      res.json(this.state);
    });
    app.get("/rehearsal/api/events", (req, res) => {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.flushHeaders();
      this.clients.add(res);
      res.write(`data: ${JSON.stringify(this.state)}\n\n`);
      req.on("close", () => this.clients.delete(res));
    });
    app.get("/rehearsal/qr", async (req, res) => {
      try {
        const url = this.getControllerUrl(req);
        res.type("svg").send(await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#FFFFFF", light: "#00000000" } }));
      } catch (error) {
        res.status(500).send(error.message);
      }
    });
  },

  jsonParser() {
    return require("express").json({ limit: "1mb" });
  },

  getControllerUrl(req) {
    if (this.controllerUrl) {
      const configured = this.controllerUrl.replace(/\/$/, "");
      return configured.endsWith("/rehearsal") ? configured : `${configured}/rehearsal`;
    }
    const requestHost = req.get("x-forwarded-host") || req.get("host") || "";
    const hostname = requestHost.split(":")[0].replace(/^\[|]$/g, "");
    const protocol = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
    if (hostname && !["localhost", "127.0.0.1", "::1"].includes(hostname)) return `${protocol}://${requestHost}/rehearsal`;
    const addresses = Object.values(os.networkInterfaces()).flat().filter((entry) => entry && (entry.family === "IPv4" || entry.family === 4) && !entry.internal).map((entry) => entry.address);
    const address = addresses.find((value) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value)) || addresses[0];
    const port = requestHost.match(/:(\d+)$/)?.[1] || req.socket.localPort;
    return `${protocol}://${address || `${os.hostname()}.local`}${port ? `:${port}` : ""}/rehearsal`;
  },

  readScripts() {
    try { return JSON.parse(fs.readFileSync(this.scriptsFile, "utf8")); }
    catch (_error) { return []; }
  },

  writeScripts(scripts) {
    const temporary = `${this.scriptsFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(scripts, null, 2));
    fs.renameSync(temporary, this.scriptsFile);
  },

  applyEvent(event) {
    const allowed = ["load", "start", "pause", "resume", "restart", "position", "stop", "settings"];
    if (!allowed.includes(event.action)) return;
    const now = Date.now();
    if (event.action === "load") {
      this.state = { ...this.state, status: "ready", position: 0, elapsed: 0, target: Number(event.script?.target) || 0, script: event.script || null };
    } else if (event.action === "start") {
      this.state.status = "running";
      this.state.startedAt = now - (Number(this.state.elapsed) || 0) * 1000;
      this.markRehearsed();
    } else if (event.action === "pause") {
      this.state.status = "paused";
      this.state.elapsed = Number(event.elapsed) || this.state.elapsed;
    } else if (event.action === "resume") {
      this.state.status = "running";
      this.state.startedAt = now - (Number(this.state.elapsed) || 0) * 1000;
    } else if (event.action === "restart") {
      this.state = { ...this.state, status: "running", position: 0, elapsed: 0, startedAt: now };
    } else if (event.action === "position") {
      this.state.position = Math.max(0, Number(event.position) || 0);
      this.state.elapsed = Math.max(0, Number(event.elapsed) || 0);
      if (event.metrics) this.state.metrics = event.metrics;
    } else if (event.action === "stop") {
      this.state.status = "complete";
      this.state.elapsed = Math.max(0, Number(event.elapsed) || this.state.elapsed);
      this.state.summary = event.summary || null;
    } else if (event.action === "settings") {
      this.state.displaySettings = { ...(this.state.displaySettings || {}), ...(event.settings || {}) };
    }
    this.state.updatedAt = now;
    this.sendSocketNotification("REHEARSAL_STATE", this.state);
    this.broadcast();
  },

  markRehearsed() {
    if (!this.state.script?.id) return;
    const scripts = this.readScripts();
    const script = scripts.find((item) => item.id === this.state.script.id);
    if (script) {
      script.lastRehearsedAt = new Date().toISOString();
      this.writeScripts(scripts);
    }
  },

  broadcast() {
    const message = `data: ${JSON.stringify(this.state)}\n\n`;
    for (const client of this.clients) client.write(message);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "REHEARSAL_READY") {
      this.controllerUrl = String(payload?.controllerUrl || "").trim();
      this.sendSocketNotification("REHEARSAL_STATE", this.state);
    } else if (notification === "REHEARSAL_COMMAND") {
      this.applyEvent(payload || {});
    }
  }
});
