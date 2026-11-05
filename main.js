const obsidian = require("obsidian");
const fs = require("fs");
const path = require("path");
const os = require("os");

const VIEW_TYPE_GRAPH_SIDEBAR = "wiki-ai-explainer-view";
const VIEW_TYPE_ENTRY_TAB = "wiki-ai-entry-tab-view";

const DEFAULT_MODELS = [
  { id: "deepseek/deepseek-flash", label: "DeepSeek Flash" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

const DEFAULT_GRAPH_OPTIONS = {
  searchQuery: "",
  showTags: false,
  showAttachments: false,
  existingOnly: false,
  showOrphans: true,
  colorGroups: [],
  showArrows: false,
  textFadeThreshold: 0.0,
  nodeSizeMultiplier: 1.0,
  lineSizeMultiplier: 1.0,
  centerStrength: 0.5,
  repelStrength: 10.0,
  linkStrength: 1.0,
  linkDistance: 105,
};

const DEFAULT_SETTINGS = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  apiKeyFile: path.join(os.homedir(), ".config", "wayamac-sub2api", "api-key"),
  piModelsFile: path.join(os.homedir(), ".pi", "agent", "models.json"),
  model: "deepseek/deepseek-flash",
  models: DEFAULT_MODELS,
  temperature: 0.35,
  enableSelectionPopup: true,
  graphOptions: Object.assign({}, DEFAULT_GRAPH_OPTIONS),
  systemPrompt: `你是一个内嵌在 Obsidian 中的词条解析助手。
请结合用户当前所在的笔记语境，用简洁、清晰的 Markdown 解析该词条：

### 核心定义
用一两句话直接点破该词条的本质。

### 当前语境下的作用
结合原文段落说明它在这里解决什么问题。

### 思维链拆解
用有条理的要点拆解其底层逻辑、推导过程或落地方式（关联概念请用 [[概念名称]] 包裹，方便用户按需点击跳转）。`,
  graphStore: {
    nodes: {},
    edges: [],
    entries: {},
    lastActiveTerm: "",
  },
};

function normalizeTermId(raw) {
  return String(raw || "")
    .replace(/^[✨\s]+/, "")
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]
    .trim();
}

function stripWikiGraphBlock(markdown) {
  if (!markdown) return "";
  return markdown
    .replace(/```wiki-graph[\s\S]*?```/gi, "")
    .replace(/```wiki-graph[\s\S]*$/gi, "")
    .trim();
}

/* ==========================================================================
   1. Right Sidebar View: Native Obsidian Graph View + Native .graph-controls
   ========================================================================== */
class WikiAiGraphSidebarView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.canvas = null;
    this.ctx = null;
    this.animFrame = null;
    this.resizeObserver = null;

    this.simNodes = [];
    this.simEdges = [];
    this.nodeMap = new Map();

    this.camX = 0;
    this.camY = 0;
    this.camScale = 1.0;
    this.targetCamX = 0;
    this.targetCamY = 0;
    this.targetCamScale = 1.0;

    this.hoveredNode = null;
    this.draggingNode = null;
    this.isPanning = false;
    this.pointerDownPos = { x: 0, y: 0 };
    this.lastPointerPos = { x: 0, y: 0 };
    this.didMoveDuringDrag = false;
    this.alpha = 1.0;
    this.isAnimatingTimelapse = false;
    this.timelapseTimer = null;
    this.timelapseStartTime = 0;
  }

  getViewType() {
    return VIEW_TYPE_GRAPH_SIDEBAR;
  }

  getDisplayText() {
    return "关系图谱";
  }

  getIcon() {
    return "lucide-sparkles";
  }

  getGraphOptions() {
    if (!this.plugin.settings.graphOptions) {
      this.plugin.settings.graphOptions = Object.assign(
        {},
        DEFAULT_GRAPH_OPTIONS
      );
    }
    return this.plugin.settings.graphOptions;
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("wiki-ai-graph-sidebar");

    this.canvas = container.createEl("canvas", {
      cls: "wiki-ai-graph-canvas",
    });
    this.ctx = this.canvas.getContext("2d");

    // Build native Obsidian Graph Controls (top-right gear + wand + collapsible drawer)
    this.buildNativeGraphControls(container);

    this.bindCanvasEvents();
    this.syncSimulationFromStore(true);

    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
    });
    this.resizeObserver.observe(container);
    setTimeout(() => {
      this.resizeCanvas();
      this.resetCamera();
    }, 30);

    this.startLoop();
  }

  buildNativeGraphControls(container) {
    const opts = this.getGraphOptions();
    const controlsEl = container.createDiv({
      cls: "wiki-ai-graph-controls is-closed",
    });
    this.controlsEl = controlsEl;

    // 1. Closed state buttons: Gear (settings) + Wand (播放动画 / Start timelapse animation) + Save KB just like native Obsidian
    const closedBtns = controlsEl.createDiv({
      cls: "wiki-ai-graph-controls-closed-btns",
    });

    const gearBtn = closedBtns.createEl("div", {
      cls: "clickable-icon",
      attr: { "aria-label": "打开图谱设置" },
    });
    obsidian.setIcon(gearBtn, "lucide-settings");
    gearBtn.addEventListener("click", () => {
      controlsEl.removeClass("is-closed");
    });

    const wandBtn = closedBtns.createEl("div", {
      cls: "clickable-icon",
      attr: { "aria-label": "播放关系图谱生长动画" },
    });
    this.wandBtn = wandBtn;
    obsidian.setIcon(wandBtn, "lucide-wand-2");
    wandBtn.addEventListener("click", () => {
      this.playTimelineAnimation();
    });
    const saveBtn = closedBtns.createEl("div", {
      cls: "clickable-icon",
      attr: { "aria-label": "保存/导出整个 AI 知识库到笔记" },
    });
    obsidian.setIcon(saveBtn, "lucide-save");
    saveBtn.addEventListener("click", async () => {
      await this.plugin.saveKnowledgeBaseToVault();
    });

    // 2. Open state body: 筛选 / 颜色组 / 外观 / 力度
    const bodyEl = controlsEl.createDiv({
      cls: "wiki-ai-graph-controls-body",
    });

    // --- Section 1: 筛选 ---
    const filterSec = this.createSection(bodyEl, "筛选", false, (actionsEl) => {
      const saveKbBtn = actionsEl.createEl("div", {
        cls: "clickable-icon",
        attr: { "aria-label": "保存整个 AI 知识库到笔记" },
      });
      obsidian.setIcon(saveKbBtn, "lucide-save");
      saveKbBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await this.plugin.saveKnowledgeBaseToVault();
      });

      const resetBtn = actionsEl.createEl("div", {
        cls: "clickable-icon",
        attr: { "aria-label": "恢复默认设置" },
      });
      obsidian.setIcon(resetBtn, "lucide-rotate-ccw");
      resetBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        this.plugin.settings.graphOptions = Object.assign(
          {},
          DEFAULT_GRAPH_OPTIONS,
          { colorGroups: [] }
        );
        await this.plugin.saveSettings();
        controlsEl.remove();
        this.buildNativeGraphControls(container);
        this.controlsEl.removeClass("is-closed");
        this.syncSimulationFromStore(true);
      });

      const clearGraphBtn = actionsEl.createEl("div", {
        cls: "clickable-icon",
        attr: { "aria-label": "清空已探索节点" },
      });
      obsidian.setIcon(clearGraphBtn, "lucide-trash-2");
      clearGraphBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await this.plugin.clearGraphStore();
        new obsidian.Notice("已清空图谱节点");
      });

      const closeBtn = actionsEl.createEl("div", {
        cls: "clickable-icon",
        attr: { "aria-label": "关闭" },
      });
      obsidian.setIcon(closeBtn, "lucide-x");
      closeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        controlsEl.addClass("is-closed");
      });
    });

    const searchWrap = filterSec.contentEl.createDiv({
      cls: "wiki-ai-search-wrap",
    });
    const sIcon = searchWrap.createSpan({ cls: "wiki-ai-search-icon" });
    obsidian.setIcon(sIcon, "lucide-search");
    const searchInput = searchWrap.createEl("input", {
      cls: "wiki-ai-search-input",
      attr: {
        type: "text",
        placeholder: "搜索文件...",
        value: opts.searchQuery || "",
      },
    });
    searchInput.addEventListener("input", async () => {
      opts.searchQuery = searchInput.value.trim();
      await this.plugin.saveSettings();
      this.syncSimulationFromStore(false);
    });

    this.createToggleRow(filterSec.contentEl, "标签", opts.showTags, async (v) => {
      opts.showTags = v;
      await this.plugin.saveSettings();
    });
    this.createToggleRow(
      filterSec.contentEl,
      "附件",
      opts.showAttachments,
      async (v) => {
        opts.showAttachments = v;
        await this.plugin.saveSettings();
      }
    );
    this.createToggleRow(
      filterSec.contentEl,
      "仅显示已创建的笔记",
      opts.existingOnly,
      async (v) => {
        opts.existingOnly = v;
        await this.plugin.saveSettings();
      }
    );
    this.createToggleRow(
      filterSec.contentEl,
      "孤立文件",
      opts.showOrphans !== false,
      async (v) => {
        opts.showOrphans = v;
        await this.plugin.saveSettings();
        this.syncSimulationFromStore(false);
      }
    );

    // --- Section 2: 颜色组 ---
    const colorSec = this.createSection(bodyEl, "颜色组", false);
    const groupListEl = colorSec.contentEl.createDiv({
      cls: "wiki-ai-color-group-list",
    });

    const renderColorGroups = () => {
      groupListEl.empty();
      const groups = opts.colorGroups || [];
      groups.forEach((grp, idx) => {
        const row = groupListEl.createDiv({ cls: "wiki-ai-color-group-item" });
        const qInput = row.createEl("input", {
          attr: {
            type: "text",
            placeholder: "关键词...",
            value: grp.query || "",
          },
        });
        qInput.addEventListener("input", async () => {
          grp.query = qInput.value.trim();
          await this.plugin.saveSettings();
        });

        const cInput = row.createEl("input", {
          attr: {
            type: "color",
            value: grp.color || "#e0a82e",
          },
        });
        cInput.addEventListener("input", async () => {
          grp.color = cInput.value;
          await this.plugin.saveSettings();
        });

        const delBtn = row.createEl("div", {
          cls: "clickable-icon",
          attr: { "aria-label": "删除颜色组" },
        });
        obsidian.setIcon(delBtn, "lucide-x");
        delBtn.addEventListener("click", async () => {
          opts.colorGroups.splice(idx, 1);
          await this.plugin.saveSettings();
          renderColorGroups();
        });
      });
    };
    renderColorGroups();

    const addGroupBtn = colorSec.contentEl.createEl("button", {
      cls: "wiki-ai-full-btn",
      text: "新建颜色组",
    });
    addGroupBtn.addEventListener("click", async () => {
      if (!Array.isArray(opts.colorGroups)) opts.colorGroups = [];
      const palette = ["#f0b40b", "#43c663", "#9b87f5", "#3bc9db", "#ff7a3d"];
      opts.colorGroups.push({
        query: "",
        color: palette[opts.colorGroups.length % palette.length],
      });
      await this.plugin.saveSettings();
      renderColorGroups();
    });

    // --- Section 3: 外观 ---
    const displaySec = this.createSection(bodyEl, "外观", false);
    this.createToggleRow(
      displaySec.contentEl,
      "箭头",
      Boolean(opts.showArrows),
      async (v) => {
        opts.showArrows = v;
        await this.plugin.saveSettings();
      }
    );

    this.createSliderRow(
      displaySec.contentEl,
      "文本透明度",
      opts.textFadeThreshold ?? 0.0,
      -3.0,
      3.0,
      0.1,
      async (val) => {
        opts.textFadeThreshold = val;
        await this.plugin.saveSettings();
      }
    );

    this.createSliderRow(
      displaySec.contentEl,
      "节点大小",
      opts.nodeSizeMultiplier ?? 1.0,
      0.4,
      2.5,
      0.05,
      async (val) => {
        opts.nodeSizeMultiplier = val;
        await this.plugin.saveSettings();
      }
    );

    this.createSliderRow(
      displaySec.contentEl,
      "连线粗细",
      opts.lineSizeMultiplier ?? 1.0,
      0.3,
      3.0,
      0.05,
      async (val) => {
        opts.lineSizeMultiplier = val;
        await this.plugin.saveSettings();
      }
    );

    const playWrap = displaySec.contentEl.createDiv({
      cls: "wiki-ai-right-btn-wrap",
    });
    const saveKbFullBtn = playWrap.createEl("button", {
      cls: "mod-cta",
      text: "保存知识库",
    });
    saveKbFullBtn.style.marginRight = "6px";
    saveKbFullBtn.addEventListener("click", async () => {
      await this.plugin.saveKnowledgeBaseToVault();
    });
    const playBtn = playWrap.createEl("button", {
      text: "播放动画",
    });
    this.playBtn = playBtn;
    playBtn.addEventListener("click", () => {
      this.playTimelineAnimation();
    });

    // --- Section 4: 力度 (Collapsed by default like native Obsidian) ---
    const forceSec = this.createSection(bodyEl, "力度", true);
    this.createSliderRow(
      forceSec.contentEl,
      "向心力",
      opts.centerStrength ?? 0.5,
      0.0,
      1.0,
      0.05,
      async (val) => {
        opts.centerStrength = val;
        this.alpha = Math.max(this.alpha, 0.8);
        await this.plugin.saveSettings();
      }
    );
    this.createSliderRow(
      forceSec.contentEl,
      "排斥力",
      opts.repelStrength ?? 10.0,
      1.0,
      20.0,
      0.5,
      async (val) => {
        opts.repelStrength = val;
        this.alpha = Math.max(this.alpha, 0.8);
        await this.plugin.saveSettings();
      }
    );
    this.createSliderRow(
      forceSec.contentEl,
      "连线强度",
      opts.linkStrength ?? 1.0,
      0.1,
      2.0,
      0.05,
      async (val) => {
        opts.linkStrength = val;
        this.alpha = Math.max(this.alpha, 0.8);
        await this.plugin.saveSettings();
      }
    );
    this.createSliderRow(
      forceSec.contentEl,
      "连线长度",
      opts.linkDistance ?? 105,
      30,
      250,
      5,
      async (val) => {
        opts.linkDistance = val;
        this.alpha = Math.max(this.alpha, 0.8);
        await this.plugin.saveSettings();
      }
    );
  }

  createSection(parentEl, title, startCollapsed = false, buildActions = null) {
    const secEl = parentEl.createDiv({
      cls: `wiki-ai-graph-Section${startCollapsed ? " is-collapsed" : ""}`,
    });
    const headerEl = secEl.createDiv({ cls: "wiki-ai-graph-Section-header" });
    const titleWrap = headerEl.createDiv({ cls: "wiki-ai-graph-Section-title" });
    const chev = titleWrap.createSpan({ cls: "wiki-ai-chevron" });
    obsidian.setIcon(chev, "lucide-chevron-down");
    titleWrap.createSpan({ text: title });

    if (buildActions) {
      const actionsEl = headerEl.createDiv({
        cls: "wiki-ai-graph-Section-actions",
      });
      buildActions(actionsEl);
    }

    titleWrap.addEventListener("click", () => {
      secEl.toggleClass("is-collapsed", !secEl.hasClass("is-collapsed"));
    });

    const contentEl = secEl.createDiv({ cls: "wiki-ai-graph-Section-content" });
    return { secEl, contentEl };
  }

  createToggleRow(parentEl, labelText, initialValue, onChange) {
    const row = parentEl.createDiv({ cls: "wiki-ai-control-row" });
    row.createSpan({ text: labelText });
    const toggle = new obsidian.ToggleComponent(row);
    toggle.setValue(Boolean(initialValue));
    toggle.onChange(onChange);
    return toggle;
  }

  createSliderRow(parentEl, labelText, value, min, max, step, onChange) {
    const group = parentEl.createDiv({ cls: "wiki-ai-slider-group" });
    group.createDiv({ cls: "wiki-ai-slider-label", text: labelText });
    const row = group.createDiv({ cls: "wiki-ai-slider-row" });
    const valSpan = row.createSpan({
      cls: "wiki-ai-slider-val",
      text: Number(value).toFixed(step >= 1 ? 0 : 2),
    });
    const input = row.createEl("input", {
      cls: "slider",
      attr: {
        type: "range",
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(value),
      },
    });
    input.addEventListener("input", () => {
      const num = parseFloat(input.value);
      valSpan.setText(num.toFixed(step >= 1 ? 0 : 2));
      onChange(num);
    });
    return group;
  }

  // Official Obsidian Timelapse Animation ("播放动画"):
  // Starts from an empty graph and adds nodes + edges one by one over time,
  // with each newly spawned node popping in near its connected parent and settling via live force physics!
  playTimelineAnimation() {
    if (this.timelapseTimer) {
      clearInterval(this.timelapseTimer);
      this.timelapseTimer = null;
      this.isAnimatingTimelapse = false;
      if (this.playBtn) this.playBtn.setText("播放动画");
      if (this.wandBtn) this.wandBtn.removeClass("is-active");
      this.syncSimulationFromStore(false);
      return;
    }

    const store = this.plugin.getGraphStore();
    const opts = this.getGraphOptions();
    const query = (opts.searchQuery || "").toLowerCase();

    let allRawNodes = Object.values(store.nodes || {}).filter(
      (n) => n && n.clicked === true
    );
    if (query) {
      allRawNodes = allRawNodes.filter((n) =>
        (n.label || n.id || "").toLowerCase().includes(query)
      );
    }
    if (!allRawNodes.length) return;

    const allEdges = (store.edges || []).filter(
      (e) => e.from && e.to && e.from !== e.to
    );

    this.simNodes = [];
    this.simEdges = [];
    this.nodeMap.clear();
    this.isAnimatingTimelapse = true;
    if (this.playBtn) this.playBtn.setText("停止动画");
    if (this.wandBtn) this.wandBtn.addClass("is-active");

    let idx = 0;
    const stepMs = Math.max(120, Math.min(360, Math.floor(2400 / Math.max(1, allRawNodes.length))));

    const spawnNext = () => {
      if (idx >= allRawNodes.length) {
        clearInterval(this.timelapseTimer);
        this.timelapseTimer = null;
        this.isAnimatingTimelapse = false;
        if (this.playBtn) this.playBtn.setText("播放动画");
        if (this.wandBtn) this.wandBtn.removeClass("is-active");
        return;
      }

      const raw = allRawNodes[idx++];
      // Find if any already-spawned node connects to this new node so it spawns near its parent
      let spawnX = (Math.random() - 0.5) * 30;
      let spawnY = (Math.random() - 0.5) * 30;
      for (const e of allEdges) {
        const parentId =
          e.from === raw.id ? e.to : e.to === raw.id ? e.from : null;
        if (parentId && this.nodeMap.has(parentId)) {
          const p = this.nodeMap.get(parentId);
          const angle = Math.random() * Math.PI * 2;
          spawnX = p.x + Math.cos(angle) * 28;
          spawnY = p.y + Math.sin(angle) * 28;
          break;
        }
      }

      const simNode = {
        id: raw.id,
        label: raw.label || raw.id,
        x: spawnX,
        y: spawnY,
        vx: 0,
        vy: 0,
        degree: 0,
        spawnTime: performance.now(),
      };
      this.simNodes.push(simNode);
      this.nodeMap.set(simNode.id, simNode);

      // Rebuild edges among currently spawned nodes
      const nextEdges = [];
      const seenPairs = new Set();
      for (const n of this.simNodes) n.degree = 0;

      for (const e of allEdges) {
        if (!this.nodeMap.has(e.from) || !this.nodeMap.has(e.to)) continue;
        const uKey =
          e.from < e.to ? `${e.from}:::${e.to}` : `${e.to}:::${e.from}`;
        if (seenPairs.has(uKey)) continue;
        seenPairs.add(uKey);
        const s = this.nodeMap.get(e.from);
        const t = this.nodeMap.get(e.to);
        if (s && t) {
          s.degree += 1;
          t.degree += 1;
          nextEdges.push({ from: e.from, to: e.to });
        }
      }
      this.simEdges = nextEdges;
      this.alpha = 0.95;
    };

    spawnNext();
    this.timelapseTimer = setInterval(spawnNext, stepMs);
  }

  async onClose() {
    if (this.timelapseTimer) clearInterval(this.timelapseTimer);
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }

  getThemeColors() {
    const style = getComputedStyle(this.containerEl || document.body);
    const getVar = (name, fallback) => {
      const v = style.getPropertyValue(name).trim();
      return v || fallback;
    };
    return {
      bg: getVar("--background-primary", "#1e1e1e"),
      nodeHub: getVar("--graph-node", "#c8c9ce"),
      nodeLeaf: getVar("--text-muted", "#8e9096"),
      nodeUnresolved: getVar("--graph-node-unresolved", "#5c5e64"),
      nodeFocused: getVar(
        "--graph-node-focused",
        getVar("--interactive-accent", "#8a5cf5")
      ),
      line: getVar("--graph-line", "#62646b"),
      lineHighlight: getVar("--interactive-accent", "#8a5cf5"),
      text: getVar("--graph-text", getVar("--text-normal", "#dcddde")),
      textMuted: getVar("--text-muted", "#888888"),
      textFaint: getVar("--text-faint", "#666666"),
    };
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, rect.width);
    const h = Math.max(200, rect.height);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.logicalWidth = w;
    this.logicalHeight = h;
    this.dpr = dpr;
  }

  resetCamera() {
    this.targetCamX = 0;
    this.targetCamY = 0;
    this.targetCamScale = 1.0;
    this.alpha = Math.max(this.alpha, 0.6);
  }

  syncSimulationFromStore(reheat = true) {
    const store = this.plugin.getGraphStore();
    const opts = this.getGraphOptions();
    const query = (opts.searchQuery || "").toLowerCase();

    // Strictly only include nodes that the user actually clicked/opened
    let rawNodes = Object.values(store.nodes || {}).filter(
      (n) => n && n.clicked === true
    );
    if (query) {
      rawNodes = rawNodes.filter((n) =>
        (n.label || n.id || "").toLowerCase().includes(query)
      );
    }

    const allowedIds = new Set(rawNodes.map((n) => n.id));
    const prevMap = new Map(this.simNodes.map((n) => [n.id, n]));
    const nextNodes = [];
    this.nodeMap.clear();

    const count = rawNodes.length || 1;
    rawNodes.forEach((n, idx) => {
      const prev = prevMap.get(n.id);
      const angle = (idx / count) * Math.PI * 2;
      const radiusSpread = Math.min(90, 25 + count * 12);
      const simNode = {
        id: n.id,
        label: n.label || n.id,
        x: prev
          ? prev.x
          : Math.cos(angle) * radiusSpread + (Math.random() - 0.5) * 15,
        y: prev
          ? prev.y
          : Math.sin(angle) * radiusSpread + (Math.random() - 0.5) * 15,
        vx: prev ? prev.vx : 0,
        vy: prev ? prev.vy : 0,
        degree: 0,
      };
      nextNodes.push(simNode);
      this.nodeMap.set(simNode.id, simNode);
    });

    // Strict single-direction edges: never allow both A->B and B->A
    const nextEdges = [];
    const seenPairs = new Set();
    for (const e of store.edges || []) {
      if (!allowedIds.has(e.from) || !allowedIds.has(e.to)) continue;
      if (e.from === e.to) continue;
      const unorderedKey =
        e.from < e.to ? `${e.from}:::${e.to}` : `${e.to}:::${e.from}`;
      if (seenPairs.has(unorderedKey)) continue;
      seenPairs.add(unorderedKey);

      const s = this.nodeMap.get(e.from);
      const t = this.nodeMap.get(e.to);
      if (s && t) {
        s.degree += 1;
        t.degree += 1;
        nextEdges.push({
          from: e.from,
          to: e.to,
        });
      }
    }

    // If "孤立文件" is turned off, hide degree-0 nodes (unless there is only 1 node total)
    if (opts.showOrphans === false && nextEdges.length > 0) {
      const connectedNodes = nextNodes.filter((n) => n.degree > 0);
      this.simNodes = connectedNodes;
      this.nodeMap.clear();
      connectedNodes.forEach((n) => this.nodeMap.set(n.id, n));
    } else {
      this.simNodes = nextNodes;
    }

    this.simEdges = nextEdges;

    if (reheat) {
      this.alpha = 1.0;
    }
  }

  screenToWorld(sx, sy) {
    const cx = (this.logicalWidth || 320) / 2;
    const cy = (this.logicalHeight || 480) / 2;
    return {
      x: (sx - cx - this.camX) / this.camScale,
      y: (sy - cy - this.camY) / this.camScale,
    };
  }

  // Native Obsidian zoom-compensated node sizing:
  // When zooming out (camScale < 1), nodes keep a crisp screen-space presence and scale up gently
  // without swallowing the connecting lines between nodes.
  getNodeRadius(node) {
    const mult = this.getGraphOptions().nodeSizeMultiplier ?? 1.0;
    const deg = node.degree || 0;
    const baseRadius = 3.6 + Math.pow(deg, 0.72) * 2.2;
    const zoomComp = Math.pow(Math.max(0.15, this.camScale), -0.62);
    return Math.min(18, baseRadius) * mult * zoomComp;
  }

  resolveNodeColor(node, theme, isFocused) {
    const groups = this.getGraphOptions().colorGroups || [];
    for (const g of groups) {
      const q = (g.query || "").replace(/^tag:#?|^path:/i, "").trim().toLowerCase();
      if (q && node.label.toLowerCase().includes(q)) {
        return g.color;
      }
    }
    if (isFocused) {
      return theme.nodeFocused;
    }
    // Native Obsidian: leaf/isolated nodes (deg <= 1) are dimmer grey (#666), connected/hub nodes are brighter light grey (#b8b9be)
    const deg = node.degree || 0;
    if (deg === 0) return theme.nodeUnresolved;
    if (deg === 1) return theme.nodeLeaf;
    return theme.nodeHub;
  }

  findNodeAt(sx, sy) {
    const world = this.screenToWorld(sx, sy);
    for (let i = this.simNodes.length - 1; i >= 0; i--) {
      const n = this.simNodes[i];
      const r = this.getNodeRadius(n) + 5 / this.camScale;
      const dx = world.x - n.x;
      const dy = world.y - n.y;
      if (dx * dx + dy * dy <= r * r) {
        return n;
      }
    }
    return null;
  }

  bindCanvasEvents() {
    const c = this.canvas;

    c.addEventListener("pointerdown", (ev) => {
      const rect = c.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      this.pointerDownPos = { x: sx, y: sy };
      this.lastPointerPos = { x: sx, y: sy };
      this.didMoveDuringDrag = false;

      const hit = this.findNodeAt(sx, sy);
      if (hit) {
        this.draggingNode = hit;
        this.alpha = Math.max(this.alpha, 0.85);
      } else {
        this.isPanning = true;
      }
      c.setPointerCapture(ev.pointerId);
    });

    c.addEventListener("pointermove", (ev) => {
      const rect = c.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;

      if (Math.hypot(sx - this.pointerDownPos.x, sy - this.pointerDownPos.y) > 4) {
        this.didMoveDuringDrag = true;
      }

      if (this.draggingNode) {
        const world = this.screenToWorld(sx, sy);
        this.draggingNode.x = world.x;
        this.draggingNode.y = world.y;
        this.draggingNode.vx = 0;
        this.draggingNode.vy = 0;
        this.alpha = Math.max(this.alpha, 0.65);
        return;
      }

      if (this.isPanning) {
        const dx = sx - this.lastPointerPos.x;
        const dy = sy - this.lastPointerPos.y;
        this.camX += dx;
        this.camY += dy;
        this.targetCamX += dx;
        this.targetCamY += dy;
        this.lastPointerPos = { x: sx, y: sy };
        return;
      }

      const hit = this.findNodeAt(sx, sy);
      if (hit !== this.hoveredNode) {
        this.hoveredNode = hit;
        c.style.cursor = hit ? "pointer" : "default";
      }
    });

    c.addEventListener("pointerup", async (ev) => {
      try {
        c.releasePointerCapture(ev.pointerId);
      } catch (e) {}

      const clickedNode = this.draggingNode;
      const wasClick = !this.didMoveDuringDrag;

      this.draggingNode = null;
      this.isPanning = false;

      // Clicking a node in the right graph ONLY switches/opens the tab, NEVER adds edges
      if (clickedNode && wasClick) {
        await this.plugin.openTermInMainTab(clickedNode.id);
      }
    });

    // Silky-smooth cursor-centered exponential wheel zoom (matches native Obsidian Pixi/Canvas feel)
    c.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const rect = c.getBoundingClientRect();
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;
        const cx = (this.logicalWidth || 320) / 2;
        const cy = (this.logicalHeight || 480) / 2;

        // Normalize deltaY across mouse wheels and trackpads
        const rawDelta =
          ev.deltaMode === 1 ? ev.deltaY * 18 : ev.deltaMode === 2 ? ev.deltaY * 120 : ev.deltaY;
        const zoomFactor = Math.exp(-rawDelta * 0.0016);
        const nextScale = Math.min(
          4.5,
          Math.max(0.15, this.targetCamScale * zoomFactor)
        );

        // Anchor zoom around the cursor position (sx, sy)
        const mx = sx - cx;
        const my = sy - cy;
        const scaleRatio = nextScale / this.targetCamScale;
        this.targetCamX = mx - (mx - this.targetCamX) * scaleRatio;
        this.targetCamY = my - (my - this.targetCamY) * scaleRatio;
        this.targetCamScale = nextScale;
      },
      { passive: false }
    );
  }

  startLoop() {
    const step = () => {
      // Smooth camera interpolation (60/120fps damping for zoom & reset)
      this.camX += (this.targetCamX - this.camX) * 0.24;
      this.camY += (this.targetCamY - this.camY) * 0.24;
      this.camScale += (this.targetCamScale - this.camScale) * 0.24;
      if (Math.abs(this.targetCamScale - this.camScale) < 0.0005) {
        this.camScale = this.targetCamScale;
      }
      this.tickPhysics();
      this.renderGraph();
      this.animFrame = requestAnimationFrame(step);
    };
    this.animFrame = requestAnimationFrame(step);
  }

  tickPhysics() {
    const nodes = this.simNodes;
    const edges = this.simEdges;
    if (!nodes.length) return;

    if (this.alpha < 0.004 && !this.draggingNode) return;
    this.alpha *= 0.985;

    const opts = this.getGraphOptions();
    const repulsion = (opts.repelStrength ?? 10.0) * 220;
    const centerGravity = (opts.centerStrength ?? 0.5) * 0.044;
    const targetLen = opts.linkDistance ?? 105;
    const linkK = (opts.linkStrength ?? 1.0) * 0.05;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 16) {
          dx = (Math.random() - 0.5) * 4;
          dy = (Math.random() - 0.5) * 4;
          distSq = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(distSq);
        const force = (repulsion / distSq) * this.alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (a !== this.draggingNode) {
          a.vx -= fx;
          a.vy -= fy;
        }
        if (b !== this.draggingNode) {
          b.vx += fx;
          b.vy += fy;
        }
      }
    }

    for (const e of edges) {
      const s = this.nodeMap.get(e.from);
      const t = this.nodeMap.get(e.to);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const force = (dist - targetLen) * linkK * this.alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (s !== this.draggingNode) {
        s.vx += fx;
        s.vy += fy;
      }
      if (t !== this.draggingNode) {
        t.vx -= fx;
        t.vy -= fy;
      }
    }

    for (const n of nodes) {
      if (n === this.draggingNode) continue;
      n.vx -= n.x * centerGravity * this.alpha;
      n.vy -= n.y * centerGravity * this.alpha;
      n.vx *= 0.8;
      n.vy *= 0.8;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  renderGraph() {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const dpr = this.dpr || 1;
    const w = this.logicalWidth || 320;
    const h = this.logicalHeight || 480;
    const theme = this.getThemeColors();
    const opts = this.getGraphOptions();

    ctx.save();
    ctx.scale(dpr, dpr);

    // Match active Obsidian background
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);

    const visibleNodes = this.simNodes;
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const now = performance.now();

    if (!visibleNodes.length) {
      ctx.fillStyle = theme.textFaint;
      ctx.font = "12px var(--font-interface, sans-serif)";
      ctx.textAlign = "center";
      ctx.fillText("选中文字点击「AI 解析」后生成节点", w / 2, h / 2);
      ctx.restore();
      return;
    }

    ctx.translate(w / 2 + this.camX, h / 2 + this.camY);
    ctx.scale(this.camScale, this.camScale);

    const activeFocus = this.hoveredNode;
    const neighborIds = new Set();
    if (activeFocus) {
      neighborIds.add(activeFocus.id);
      for (const e of this.simEdges) {
        if (e.from === activeFocus.id) neighborIds.add(e.to);
        if (e.to === activeFocus.id) neighborIds.add(e.from);
      }
    }

    const lineMult = opts.lineSizeMultiplier ?? 1.0;
    const showArrows = Boolean(opts.showArrows);

    // 1. Draw single-direction straight lines (+ optional arrowheads controlled by 外观 -> 箭头)
    for (const e of this.simEdges) {
      if (!visibleIds.has(e.from) || !visibleIds.has(e.to)) continue;
      const s = this.nodeMap.get(e.from);
      const t = this.nodeMap.get(e.to);
      if (!s || !t) continue;

      const isHighlighted =
        activeFocus && (e.from === activeFocus.id || e.to === activeFocus.id);
      const isDimmed = activeFocus && !isHighlighted;

      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 2) continue;

      const ux = dx / dist;
      const uy = dy / dist;
      const rSource = this.getNodeRadius(s);
      const rTarget = this.getNodeRadius(t);

      const startX = s.x + ux * rSource;
      const startY = s.y + uy * rSource;
      const endX = t.x - ux * (rTarget + (showArrows ? 1.2 : 0));
      const endY = t.y - uy * (rTarget + (showArrows ? 1.2 : 0));

      ctx.save();
      // Keep edges clearly visible even when zoomed out (compensate lineWidth in world space by 1 / camScale)
      ctx.globalAlpha = isDimmed ? 0.18 : isHighlighted ? 0.92 : 0.62;
      ctx.strokeStyle = isHighlighted ? theme.lineHighlight : theme.line;
      const screenLinePx = (isHighlighted ? 1.5 : 1.05) * lineMult;
      ctx.lineWidth = screenLinePx / Math.max(0.12, this.camScale);

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      if (showArrows) {
        const angle = Math.atan2(dy, dx);
        const arrowLen = (5.0 * Math.sqrt(lineMult)) / Math.max(0.18, this.camScale);
        const arrowWidth = (2.4 * Math.sqrt(lineMult)) / Math.max(0.18, this.camScale);
        ctx.fillStyle = isHighlighted ? theme.lineHighlight : theme.line;
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(
          endX - arrowLen * Math.cos(angle) + arrowWidth * Math.sin(angle),
          endY - arrowLen * Math.sin(angle) - arrowWidth * Math.cos(angle)
        );
        ctx.lineTo(
          endX - arrowLen * Math.cos(angle) - arrowWidth * Math.sin(angle),
          endY - arrowLen * Math.sin(angle) + arrowWidth * Math.cos(angle)
        );
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // 2. Draw default monochrome Obsidian nodes:
    //    - Zooming out (smaller camScale) completely hides/fades text labels below ~0.68 zoom (just like the reference screenshot)
    //    - While zoomed out, only the crisp nodes and connecting lines remain visible
    const textFade = opts.textFadeThreshold ?? 0.0;
    const fadeStartScale = 0.95 + textFade * 0.25;
    const fadeEndScale = 0.62 + textFade * 0.2;
    const zoomTextAlpha = Math.min(
      0.85,
      Math.max(
        0,
        (this.camScale - fadeEndScale) / Math.max(0.12, fadeStartScale - fadeEndScale)
      )
    );

    for (const n of visibleNodes) {
      // Pop-in scale animation when spawned during "播放动画"
      const ageMs = n.spawnTime ? now - n.spawnTime : 1000;
      const popScale = ageMs < 260 ? Math.min(1, 0.25 + (ageMs / 260) * 0.75) : 1.0;
      const r = this.getNodeRadius(n) * popScale;
      const isFocused = activeFocus && activeFocus.id === n.id;
      const isNeighbor = activeFocus ? neighborIds.has(n.id) : true;
      const deg = n.degree || 0;

      ctx.save();
      ctx.globalAlpha = isNeighbor ? 1.0 : 0.18;

      ctx.beginPath();
      ctx.arc(n.x, n.y, isFocused ? r * 1.15 : r, 0, Math.PI * 2);
      ctx.fillStyle = this.resolveNodeColor(n, theme, isFocused);
      ctx.fill();

      // Official Obsidian text behavior:
      // When zoomed out below fadeEndScale, zoomTextAlpha is 0 so labels completely disappear, leaving clean nodes + lines!
      const hubBonus = zoomTextAlpha > 0.08 ? Math.min(0.18, deg * 0.04) : 0;
      const nodeLabelAlpha = Math.min(0.88, zoomTextAlpha + hubBonus);
      if (nodeLabelAlpha > 0.03 || isFocused) {
        ctx.globalAlpha = isFocused ? 0.98 : isNeighbor ? nodeLabelAlpha : 0.08;
        const screenFontSize = Math.min(13.5, 10.5 + Math.sqrt(deg) * 0.65);
        const worldFontSize = screenFontSize / Math.pow(Math.max(0.2, this.camScale), 0.78);
        ctx.font = `${isFocused ? "500" : "400"} ${worldFontSize.toFixed(1)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = isFocused ? theme.text : theme.textMuted;
        const labelOffset = 3.5 / Math.pow(Math.max(0.2, this.camScale), 0.75);
        ctx.fillText(n.label, n.x, n.y + r + labelOffset);
      }

      ctx.restore();
    }

    ctx.restore();
  }
}

/* ==========================================================================
   2. Main Workspace Tab View: Native Obsidian Note Style
   ========================================================================== */
class WikiAiEntryTabView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentTerm = "";
    this.renderComponent = new obsidian.Component();
  }

  getViewType() {
    return VIEW_TYPE_ENTRY_TAB;
  }

  getDisplayText() {
    return this.currentTerm ? this.currentTerm : "词条解析";
  }

  getIcon() {
    return "lucide-sparkles";
  }

  async setState(state, result) {
    if (state && state.term) {
      this.currentTerm = normalizeTermId(state.term);
    }
    await super.setState(state, result);
    this.updateTabTitle();
    await this.renderEntry();
  }

  getState() {
    return {
      term: this.currentTerm,
    };
  }

  updateTabTitle() {
    const title = this.getDisplayText();
    if (this.leaf && this.leaf.tabHeaderInnerTitleEl) {
      this.leaf.tabHeaderInnerTitleEl.setText(title);
    }
    if (this.leaf && this.leaf.tabHeaderInnerIconEl) {
      obsidian.setIcon(this.leaf.tabHeaderInnerIconEl, "lucide-sparkles");
    }
    if (this.titleEl) {
      this.titleEl.setText(title);
    }
    if (this.leaf && typeof this.leaf.updateHeader === "function") {
      this.leaf.updateHeader();
    }
  }

  async onOpen() {
    this.renderComponent.load();
    this.updateTabTitle();
    await this.renderEntry();
  }

  async onClose() {
    this.renderComponent.unload();
  }

  async setTerm(term) {
    this.currentTerm = normalizeTermId(term);
    this.updateTabTitle();
    await this.renderEntry();
  }

  async renderEntry() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("wiki-ai-entry-tab-container");

    const store = this.plugin.getGraphStore();
    const term = this.currentTerm || store.lastActiveTerm;
    if (!term) {
      container.createDiv({
        text: "在笔记中选中任意词汇点击「AI 解析」即可在此查看。",
      });
      return;
    }

    this.currentTerm = term;
    this.updateTabTitle();

    const entry = store.entries[term] || {
      term,
      context: "",
      sourceFile: "",
      explanation: "",
      followUps: [],
      isStreaming: false,
    };

    const page = container.createDiv({ cls: "wiki-ai-entry-page" });

    // Clean native-style header
    const header = page.createDiv({ cls: "wiki-ai-entry-header" });
    const titleWrap = header.createDiv({ cls: "wiki-ai-entry-title-wrap" });
    titleWrap.createEl("h1", { cls: "wiki-ai-entry-title", text: term });

    if (entry.sourceFile) {
      const sourceEl = titleWrap.createSpan({
        cls: "wiki-ai-entry-source",
        text: entry.sourceFile.replace(/\.md$/i, ""),
      });
      sourceEl.addEventListener("click", async () => {
        const file = this.app.vault.getAbstractFileByPath(entry.sourceFile);
        if (file instanceof obsidian.TFile) {
          const leaf = this.app.workspace.getLeaf("tab");
          await leaf.openFile(file);
        }
      });
    }

    const actions = header.createDiv({ cls: "wiki-ai-entry-actions" });

    const saveKbBtn = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "保存整个 AI 知识库到笔记文件夹" },
    });
    obsidian.setIcon(saveKbBtn, "lucide-save");
    saveKbBtn.addEventListener("click", async () => {
      await this.plugin.saveKnowledgeBaseToVault();
    });

    const regenBtn = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "重新生成" },
    });
    obsidian.setIcon(regenBtn, "lucide-refresh-cw");
    regenBtn.addEventListener("click", async () => {
      await this.plugin.generateEntryExplanation(
        term,
        entry.context,
        entry.sourceFile,
        true
      );
    });

    if (entry.isStreaming) {
      page.createDiv({
        cls: "wiki-ai-streaming-hint",
        text: "正在生成...",
      });
    }

    const mdBox = page.createDiv({ cls: "wiki-ai-explanation-box" });
    const cleanMd = stripWikiGraphBlock(entry.explanation || "");
    if (cleanMd) {
      await obsidian.MarkdownRenderer.render(
        this.app,
        cleanMd,
        mdBox,
        entry.sourceFile || "",
        this.renderComponent
      );
      this.bindInternalConceptLinks(mdBox, term, cleanMd, entry.sourceFile);
    }

    if (!entry.isStreaming && cleanMd) {
      const followSection = page.createDiv({ cls: "wiki-ai-followup-section" });
      if (Array.isArray(entry.followUps) && entry.followUps.length > 0) {
        for (const item of entry.followUps) {
          const card = followSection.createDiv({ cls: "wiki-ai-followup-item" });
          card.createDiv({
            cls: "wiki-ai-followup-q",
            text: item.q,
          });
          const ansEl = card.createDiv({ cls: "wiki-ai-followup-a" });
          await obsidian.MarkdownRenderer.render(
            this.app,
            item.a || "...",
            ansEl,
            entry.sourceFile || "",
            this.renderComponent
          );
          this.bindInternalConceptLinks(
            ansEl,
            term,
            item.a || "",
            entry.sourceFile
          );
        }
      }

      const bar = followSection.createDiv({ cls: "wiki-ai-followup-bar" });
      const input = bar.createEl("input", {
        cls: "wiki-ai-followup-input",
        attr: {
          type: "text",
          placeholder: `继续追问「${term}」...`,
        },
      });
      const sendBtn = bar.createEl("button", {
        cls: "mod-cta",
        text: "追问",
      });

      const submitFollowUp = async () => {
        const q = input.value.trim();
        if (!q) return;
        input.value = "";
        await this.plugin.askFollowUpQuestion(term, q);
      };

      sendBtn.addEventListener("click", submitFollowUp);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") submitFollowUp();
      });
    }
  }

  bindInternalConceptLinks(containerEl, parentTerm, contextText, sourceFile) {
    const links = containerEl.querySelectorAll("a.internal-link");
    links.forEach((linkEl) => {
      const rawHref =
        linkEl.getAttribute("data-href") || linkEl.textContent || "";
      const targetTerm = normalizeTermId(rawHref);
      if (!targetTerm) return;

      const freshLink = linkEl.cloneNode(true);
      linkEl.parentNode.replaceChild(freshLink, linkEl);

      freshLink.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await this.plugin.openTermInMainTab(
          targetTerm,
          `由「${parentTerm}」引申：\n${contextText.slice(0, 500)}`,
          sourceFile,
          parentTerm
        );
      });
    });
  }
}

/* ==========================================================================
   3. Main Plugin Controller
   ========================================================================== */
class WikiAiExplainerPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.syncExternalApiKeyAndModels();

    this.floatingBtn = null;
    this.pendingSelection = null;

    this.registerView(
      VIEW_TYPE_GRAPH_SIDEBAR,
      (leaf) => new WikiAiGraphSidebarView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_ENTRY_TAB,
      (leaf) => new WikiAiEntryTabView(leaf, this)
    );

    this.addRibbonIcon("lucide-sparkles", "打开关系图谱", () => {
      this.activateGraphSidebar();
    });

    this.addCommand({
      id: "explain-selected-text",
      name: "AI 解析选中词条",
      editorCallback: (editor, view) => {
        const sel = editor.getSelection().trim();
        if (!sel) {
          new obsidian.Notice("请先选中需要解析的词条");
          return;
        }
        const ctx = this.extractEditorContext(editor);
        const filePath = view && view.file ? view.file.path : "";
        const baseTitle = view && view.file ? view.file.basename : "";
        const store = this.getGraphStore();
        const parentTerm =
          baseTitle && store.nodes && store.nodes[baseTitle] ? baseTitle : "";
        this.openTermInMainTab(sel, ctx, filePath, parentTerm);
      },
    });

    this.setupSelectionFloatingButton();
    this.addSettingTab(new WikiAiSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      await this.activateGraphSidebar();

      const rebindEntryLeaves = async () => {
        const allEntryLeaves = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
          const vType =
            leaf.view && typeof leaf.view.getViewType === "function"
              ? leaf.view.getViewType()
              : "";
          const sType =
            leaf.getViewState && leaf.getViewState()
              ? leaf.getViewState().type
              : "";
          const hType =
            leaf.tabHeaderEl && leaf.tabHeaderEl.getAttribute("data-type");
          const titleText =
            (leaf.tabHeaderInnerTitleEl &&
              leaf.tabHeaderInnerTitleEl.textContent) ||
            "";
          if (
            vType === VIEW_TYPE_ENTRY_TAB ||
            sType === VIEW_TYPE_ENTRY_TAB ||
            hType === VIEW_TYPE_ENTRY_TAB ||
            titleText.includes(VIEW_TYPE_ENTRY_TAB)
          ) {
            allEntryLeaves.push(leaf);
          }
        });

        if (allEntryLeaves.length > 1) {
          for (let i = 1; i < allEntryLeaves.length; i++) {
            allEntryLeaves[i].detach();
          }
        }

        const store = this.getGraphStore();
        const singleLeaf = allEntryLeaves[0];
        if (singleLeaf) {
          const prevState =
            (singleLeaf.getViewState && singleLeaf.getViewState().state) || {};
          const term = normalizeTermId(
            store.lastActiveTerm ||
              prevState.term ||
              (singleLeaf.view && singleLeaf.view.currentTerm) ||
              ""
          );
          await singleLeaf.setViewState({
            type: VIEW_TYPE_ENTRY_TAB,
            active: false,
            state: { term },
          });
          if (singleLeaf.view instanceof WikiAiEntryTabView) {
            await singleLeaf.view.setTerm(term);
          }
        }
      };

      await rebindEntryLeaves();
      setTimeout(() => rebindEntryLeaves(), 150);
    });
  }

  onunload() {
    this.removeFloatingButton();
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
    this.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
    this.settings.graphOptions = Object.assign(
      {},
      DEFAULT_GRAPH_OPTIONS,
      (loaded && loaded.graphOptions) || {}
    );
    if (!this.settings.graphStore) {
      this.settings.graphStore = {
        nodes: {},
        edges: [],
        entries: {},
        lastActiveTerm: "",
      };
    }
    this.migrateAndCleanStore();
  }

  migrateAndCleanStore() {
    const store = this.settings.graphStore;
    if (!store) return;
    if (!store.entries) store.entries = {};
    if (!store.nodes) store.nodes = {};
    if (!store.edges) store.edges = [];

    for (const [termKey, entry] of Object.entries(store.entries)) {
      const cleanTerm = normalizeTermId(termKey);
      if (entry.answer && !entry.explanation) {
        entry.explanation = stripWikiGraphBlock(entry.answer);
      }
      if (
        entry.explanation &&
        entry.explanation.trim().startsWith("> 请求失败：")
      ) {
        entry.explanation = "";
      }
      if (cleanTerm !== termKey) {
        store.entries[cleanTerm] = entry;
        delete store.entries[termKey];
      }
    }

    const nextNodes = {};
    for (const term of Object.keys(store.entries)) {
      nextNodes[term] = {
        id: term,
        label: term,
        clicked: true,
      };
    }
    store.nodes = nextNodes;

    // Validate edges: only keep single-direction edges where `to` actually appears in `from`'s text/explanation!
    const cleanEdges = [];
    const seenUnordered = new Set();
    for (const e of store.edges) {
      const from = normalizeTermId(e.from);
      const to = normalizeTermId(e.to);
      if (!nextNodes[from] || !nextNodes[to] || from === to) continue;
      const fromEntry = store.entries[from];
      const fromText =
        (fromEntry && (fromEntry.explanation || fromEntry.answer || "")) || "";
      if (!fromText.includes(to)) {
        continue;
      }
      const uKey = from < to ? `${from}:::${to}` : `${to}:::${from}`;
      if (seenUnordered.has(uKey)) continue;
      seenUnordered.add(uKey);
      cleanEdges.push({ from, to });
    }
    store.edges = cleanEdges;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getGraphStore() {
    if (!this.settings.graphStore) {
      this.settings.graphStore = {
        nodes: {},
        edges: [],
        entries: {},
        lastActiveTerm: "",
      };
    }
    return this.settings.graphStore;
  }

  async clearGraphStore() {
    this.settings.graphStore = {
      nodes: {},
      edges: [],
      entries: {},
      lastActiveTerm: "",
    };
    await this.saveSettings();
    this.refreshGraphViews(true);
  }

  // Save/export the entire explored AI knowledge base into Vault Markdown notes + MOC index
  async saveKnowledgeBaseToVault() {
    const store = this.getGraphStore();
    const terms = Object.keys(store.entries || {}).filter(
      (t) => store.entries[t] && store.entries[t].explanation
    );
    if (!terms.length) {
      new obsidian.Notice("当前知识库还没有已生成的词条可保存");
      return;
    }

    const folderPath = "AI知识库";
    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    const sanitizeFileName = (name) =>
      String(name)
        .replace(/[\\/:*?"<>|]/g, "-")
        .trim();

    // 1. Write each term as a standalone Markdown note with frontmatter & outgoing/incoming links
    for (const term of terms) {
      const entry = store.entries[term];
      const cleanBody = stripWikiGraphBlock(entry.explanation || "");
      const outgoing = (store.edges || [])
        .filter((e) => e.from === term)
        .map((e) => `[[${e.to}]]`);
      const incoming = (store.edges || [])
        .filter((e) => e.to === term)
        .map((e) => `[[${e.from}]]`);

      const lines = [
        "---",
        `title: "${term.replace(/"/g, '\\"')}"`,
        `tags: [AI知识库]`,
        entry.sourceFile ? `source: "[[${entry.sourceFile.replace(/\.md$/i, "")}]]"` : null,
        `updated: "${new Date().toISOString().slice(0, 19).replace("T", " ")}"`,
        "---",
        "",
        cleanBody,
      ].filter((x) => x !== null);

      if (outgoing.length || incoming.length) {
        lines.push("", "---", "### 图谱关联");
        if (incoming.length) {
          lines.push(`- **上游词条**：${incoming.join(" 、 ")}`);
        }
        if (outgoing.length) {
          lines.push(`- **衍生词条**：${outgoing.join(" 、 ")}`);
        }
      }

      if (Array.isArray(entry.followUps) && entry.followUps.length > 0) {
        lines.push("", "---", "### 追问记录");
        for (const item of entry.followUps) {
          lines.push(`\n#### Q: ${item.q}\n\n${item.a || ""}`);
        }
      }

      const filePath = `${folderPath}/${sanitizeFileName(term)}.md`;
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      const content = lines.join("\n") + "\n";
      if (existing instanceof obsidian.TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(filePath, content);
      }
    }

    // 2. Write a master MOC index note (`00-AI知识库全景索引（MOC）.md`) so all links also show in Obsidian's global graph
    const mocPath = `${folderPath}/00-AI知识库全景索引（MOC）.md`;
    const mocLines = [
      "---",
      "tags: [MOC, AI知识库]",
      `updated: "${new Date().toISOString().slice(0, 19).replace("T", " ")}"`,
      "---",
      "",
      "# AI 知识库全景索引（MOC）",
      "",
      `> 共收录 **${terms.length}** 个已探索词条，**${(store.edges || []).length}** 条知识链路。`,
      "",
      "## 已收录词条",
      ...terms.map((t) => `- [[${sanitizeFileName(t)}|${t}]]`),
      "",
      "## 知识关联脉络",
      ...((store.edges || []).length
        ? store.edges.map((e) => `- [[${sanitizeFileName(e.from)}|${e.from}]] → [[${sanitizeFileName(e.to)}|${e.to}]]`)
        : ["- 暂无词条间连线"]),
      "",
    ];
    const mocExisting = this.app.vault.getAbstractFileByPath(mocPath);
    const mocContent = mocLines.join("\n");
    if (mocExisting instanceof obsidian.TFile) {
      await this.app.vault.modify(mocExisting, mocContent);
    } else {
      await this.app.vault.create(mocPath, mocContent);
    }

    // Also persist plugin store
    await this.saveSettings();
    new obsidian.Notice(
      `已保存知识库：共导出 ${terms.length} 篇词条笔记至「${folderPath}/」文件夹`
    );
  }

  syncExternalApiKeyAndModels() {
    try {
      if (
        this.settings.piModelsFile &&
        fs.existsSync(this.settings.piModelsFile)
      ) {
        const rawModels = JSON.parse(
          fs.readFileSync(this.settings.piModelsFile, "utf8")
        );
        const wayamac =
          rawModels && rawModels.providers && rawModels.providers.wayamac;
        if (wayamac && wayamac.baseUrl) {
          this.settings.baseUrl = wayamac.baseUrl.trim().replace(/\/+$/, "");
        }
      }
      if (
        this.settings.apiKeyFile &&
        fs.existsSync(this.settings.apiKeyFile)
      ) {
        const keyFromFile = fs
          .readFileSync(this.settings.apiKeyFile, "utf8")
          .trim();
        if (keyFromFile) {
          this.settings.apiKey = keyFromFile;
        }
      }
    } catch (e) {}
  }

  extractEditorContext(editor) {
    try {
      const cursor = editor.getCursor("from");
      const startLine = Math.max(0, cursor.line - 6);
      const endLine = Math.min(editor.lineCount() - 1, cursor.line + 6);
      const lines = [];
      for (let i = startLine; i <= endLine; i++) {
        lines.push(editor.getLine(i));
      }
      return lines.join("\n").trim();
    } catch (e) {
      return editor.getSelection();
    }
  }

  setupSelectionFloatingButton() {
    const onMouseUp = (ev) => {
      if (!this.settings.enableSelectionPopup) return;
      if (this.floatingBtn && this.floatingBtn.contains(ev.target)) return;

      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : "";
        if (!text || text.length < 1 || text.length > 90) {
          this.removeFloatingButton();
          return;
        }

        let contextText = text;
        let sourceFile = "";
        let parentTerm = "";

        const activeLeaf = this.app.workspace.activeLeaf;
        if (activeLeaf && activeLeaf.view instanceof WikiAiEntryTabView) {
          parentTerm = activeLeaf.view.currentTerm || "";
          contextText = activeLeaf.view.containerEl.innerText.slice(0, 600);
        } else {
          const activeView =
            this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
          if (activeView && activeView.editor) {
            const editorSel = activeView.editor.getSelection().trim();
            if (editorSel) {
              contextText = this.extractEditorContext(activeView.editor);
              sourceFile = activeView.file ? activeView.file.path : "";
              const baseTitle = activeView.file ? activeView.file.basename : "";
              const store = this.getGraphStore();
              if (baseTitle && store.nodes && store.nodes[baseTitle]) {
                parentTerm = baseTitle;
              }
            }
          }
        }

        this.showFloatingButton(ev.clientX, ev.clientY, {
          term: text,
          context: contextText,
          sourceFile,
          parentTerm,
        });
      }, 20);
    };

    const onMouseDown = (ev) => {
      if (this.floatingBtn && !this.floatingBtn.contains(ev.target)) {
        this.removeFloatingButton();
      }
    };

    this.registerDomEvent(document, "mouseup", onMouseUp);
    this.registerDomEvent(document, "mousedown", onMouseDown);
  }

  showFloatingButton(clientX, clientY, payload) {
    this.removeFloatingButton();
    this.pendingSelection = payload;

    const btn = document.body.createDiv({ cls: "wiki-ai-floating-btn" });
    const iconSpan = btn.createSpan({ cls: "wiki-ai-btn-icon" });
    obsidian.setIcon(iconSpan, "lucide-sparkles");
    btn.createSpan({ text: "AI 解析" });

    const left = Math.min(window.innerWidth - 110, Math.max(12, clientX + 10));
    const top = Math.min(window.innerHeight - 48, Math.max(12, clientY - 36));
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;

    btn.addEventListener("mousedown", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const target = this.pendingSelection;
      this.removeFloatingButton();
      if (target && target.term) {
        await this.openTermInMainTab(
          target.term,
          target.context,
          target.sourceFile,
          target.parentTerm || ""
        );
      }
    });

    this.floatingBtn = btn;
  }

  removeFloatingButton() {
    if (this.floatingBtn) {
      this.floatingBtn.remove();
      this.floatingBtn = null;
    }
  }

  deduplicateGraphSidebarLeaves() {
    const { workspace } = this.app;
    const leaves = [];
    workspace.iterateAllLeaves((l) => {
      const vt =
        l.view && typeof l.view.getViewType === "function"
          ? l.view.getViewType()
          : "";
      const st =
        l.getViewState && l.getViewState() ? l.getViewState().type : "";
      const headerType =
        l.tabHeaderEl && l.tabHeaderEl.getAttribute("data-type");
      if (
        vt === VIEW_TYPE_GRAPH_SIDEBAR ||
        st === VIEW_TYPE_GRAPH_SIDEBAR ||
        headerType === VIEW_TYPE_GRAPH_SIDEBAR
      ) {
        leaves.push(l);
      }
    });
    if (leaves.length > 1) {
      for (let i = 1; i < leaves.length; i++) {
        leaves[i].detach();
      }
    }
    return leaves[0] || null;
  }

  async activateGraphSidebar() {
    const { workspace } = this.app;
    let leaf = this.deduplicateGraphSidebarLeaves();
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({
        type: VIEW_TYPE_GRAPH_SIDEBAR,
        active: true,
      });
    } else {
      await leaf.setViewState({
        type: VIEW_TYPE_GRAPH_SIDEBAR,
        active: true,
      });
      if (leaf.tabHeaderInnerIconEl) {
        obsidian.setIcon(leaf.tabHeaderInnerIconEl, "lucide-sparkles");
      }
      if (typeof leaf.updateHeader === "function") {
        leaf.updateHeader();
      }
    }
    this.deduplicateGraphSidebarLeaves();
    setTimeout(() => this.deduplicateGraphSidebarLeaves(), 150);
    workspace.revealLeaf(leaf);
    return leaf;
  }

  refreshGraphViews(reheat = true) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GRAPH_SIDEBAR);
    for (const leaf of leaves) {
      if (leaf.view instanceof WikiAiGraphSidebarView) {
        leaf.view.syncSimulationFromStore(reheat);
      }
    }
  }

  refreshEntryTabs(term) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ENTRY_TAB);
    for (const leaf of leaves) {
      if (
        leaf.view instanceof WikiAiEntryTabView &&
        (!term || leaf.view.currentTerm === term)
      ) {
        leaf.view.renderEntry();
      }
    }
  }

  addSingleDirectionEdge(from, to) {
    const store = this.getGraphStore();
    if (!from || !to || from === to) return;
    const existsEitherWay = store.edges.some(
      (e) =>
        (e.from === from && e.to === to) || (e.from === to && e.to === from)
    );
    if (!existsEitherWay) {
      store.edges.push({ from, to });
    }
  }

  // Open or focus a main workspace tab for `term`
  // Edges are ONLY created when `parentTerm` is explicitly passed from clicking a keyword inside a document/entry!
  async openTermInMainTab(rawTerm, context = "", sourceFile = "", parentTerm = "") {
    const term = normalizeTermId(rawTerm);
    if (!term) return;

    const store = this.getGraphStore();
    store.lastActiveTerm = term;

    store.nodes[term] = {
      id: term,
      label: term,
      clicked: true,
    };

    const linkFrom = normalizeTermId(parentTerm || "");
    if (linkFrom && linkFrom !== term && store.nodes[linkFrom]) {
      this.addSingleDirectionEdge(linkFrom, term);
    }

    await this.saveSettings();
    await this.activateGraphSidebar();

    // Strictly reuse a SINGLE AI entry tab in the top tab bar (never spawn multiple ✨ tabs)
    const allEntryLeaves = [];
    this.app.workspace.iterateAllLeaves((l) => {
      const vt =
        l.view && typeof l.view.getViewType === "function"
          ? l.view.getViewType()
          : "";
      const st =
        l.getViewState && l.getViewState() ? l.getViewState().type : "";
      const ht = l.tabHeaderEl && l.tabHeaderEl.getAttribute("data-type");
      if (
        vt === VIEW_TYPE_ENTRY_TAB ||
        st === VIEW_TYPE_ENTRY_TAB ||
        ht === VIEW_TYPE_ENTRY_TAB
      ) {
        allEntryLeaves.push(l);
      }
    });

    if (allEntryLeaves.length > 1) {
      for (let i = 1; i < allEntryLeaves.length; i++) {
        allEntryLeaves[i].detach();
      }
    }

    let targetLeaf = allEntryLeaves[0] || null;
    if (!targetLeaf) {
      targetLeaf = this.app.workspace.getLeaf("tab");
    }

    await targetLeaf.setViewState({
      type: VIEW_TYPE_ENTRY_TAB,
      active: true,
      state: { term },
    });
    this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });

    if (targetLeaf.view instanceof WikiAiEntryTabView) {
      await targetLeaf.view.setTerm(term);
    }

    this.refreshGraphViews(true);

    const existingEntry = store.entries[term];
    if (
      !existingEntry ||
      !existingEntry.explanation ||
      !existingEntry.explanation.trim()
    ) {
      await this.generateEntryExplanation(term, context, sourceFile, true);
    }
  }

  async generateEntryExplanation(term, context = "", sourceFile = "", force = false) {
    const store = this.getGraphStore();
    if (!force && store.entries[term] && store.entries[term].explanation) {
      return;
    }

    store.entries[term] = {
      term,
      context: context || (store.entries[term] ? store.entries[term].context : ""),
      sourceFile:
        sourceFile || (store.entries[term] ? store.entries[term].sourceFile : ""),
      explanation: "",
      followUps: store.entries[term] ? store.entries[term].followUps || [] : [],
      isStreaming: true,
    };

    this.refreshEntryTabs(term);

    const userPrompt = `请解析词条：【${term}】
${sourceFile ? `所属笔记：${sourceFile}\n` : ""}${
      context ? `上下文段落：\n"""\n${context}\n"""` : ""
    }`;

    try {
      let fullText = "";
      await this.streamChatCompletion(
        [
          { role: "system", content: this.settings.systemPrompt },
          { role: "user", content: userPrompt },
        ],
        (chunk) => {
          fullText += chunk;
          store.entries[term].explanation = fullText;
          this.refreshEntryTabs(term);
        }
      );

      store.entries[term].isStreaming = false;
      await this.saveSettings();
      this.refreshEntryTabs(term);
    } catch (err) {
      store.entries[term].isStreaming = false;
      store.entries[term].explanation = `> 请求失败：${err.message || err}`;
      this.refreshEntryTabs(term);
    }
  }

  async askFollowUpQuestion(term, question) {
    const store = this.getGraphStore();
    const entry = store.entries[term];
    if (!entry) return;

    if (!Array.isArray(entry.followUps)) entry.followUps = [];
    const followItem = { q: question, a: "..." };
    entry.followUps.push(followItem);
    this.refreshEntryTabs(term);

    const messages = [
      { role: "system", content: this.settings.systemPrompt },
      {
        role: "user",
        content: `词条：【${term}】\n前文解析：\n${stripWikiGraphBlock(
          entry.explanation
        )}`,
      },
      {
        role: "user",
        content: `追问：${question}`,
      },
    ];

    try {
      let ans = "";
      await this.streamChatCompletion(messages, (chunk) => {
        ans += chunk;
        followItem.a = stripWikiGraphBlock(ans);
        this.refreshEntryTabs(term);
      });
      await this.saveSettings();
    } catch (e) {
      followItem.a = `请求出错：${e.message || e}`;
      this.refreshEntryTabs(term);
    }
  }

  async streamChatCompletion(messages, onDelta) {
    this.syncExternalApiKeyAndModels();
    const baseUrl = (this.settings.baseUrl || "").replace(/\/+$/, "");
    const urlStr = `${baseUrl}/chat/completions`;
    const bodyObj = {
      model: this.settings.model || "deepseek/deepseek-flash",
      messages,
      temperature: this.settings.temperature ?? 0.35,
      stream: true,
    };
    const payload = JSON.stringify(bodyObj);

    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let receivedAnyDelta = false;
      try {
        await this._streamViaFetchOrNode(urlStr, payload, (delta) => {
          receivedAnyDelta = true;
          onDelta(delta);
        });
        return;
      } catch (err) {
        lastError = err;
        if (
          receivedAnyDelta &&
          /ECONNRESET|aborted|premature/i.test(String(err && err.message))
        ) {
          return;
        }
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 350 * attempt));
        }
      }
    }

    try {
      const nonStreamPayload = JSON.stringify({
        ...bodyObj,
        stream: false,
      });
      const resp = await obsidian.requestUrl({
        url: urlStr,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.settings.apiKey}`,
        },
        body: nonStreamPayload,
      });
      const data = resp.json || JSON.parse(resp.text);
      const content =
        data &&
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content;
      if (content) {
        onDelta(content);
        return;
      }
    } catch (fallbackErr) {
      lastError = lastError || fallbackErr;
    }

    throw lastError || new Error("请求失败");
  }

  async _streamViaFetchOrNode(urlStr, payload, onDelta) {
    if (typeof window !== "undefined" && typeof window.fetch === "function") {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);
      try {
        const res = await window.fetch(urlStr, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${this.settings.apiKey}`,
          },
          body: payload,
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }

        if (!res.body || typeof res.body.getReader !== "function") {
          const fullText = await res.text();
          const parsed = JSON.parse(fullText);
          const content =
            parsed?.choices?.[0]?.message?.content ||
            parsed?.choices?.[0]?.delta?.content ||
            "";
          if (content) onDelta(content);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const dataStr = line.slice(5).trim();
            if (dataStr === "[DONE]") return;
            try {
              const parsed = JSON.parse(dataStr);
              const delta =
                parsed.choices &&
                parsed.choices[0] &&
                parsed.choices[0].delta &&
                parsed.choices[0].delta.content;
              if (delta) onDelta(delta);
            } catch (e) {}
          }
        }
        return;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    const parsedUrl = new URL(urlStr);
    const transport =
      parsedUrl.protocol === "https:" ? require("https") : require("http");

    return new Promise((resolve, reject) => {
      const req = transport.request(
        parsedUrl,
        {
          method: "POST",
          agent: false,
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Connection: "close",
            Authorization: `Bearer ${this.settings.apiKey}`,
            "Content-Length": Buffer.byteLength(payload, "utf8"),
          },
        },
        (res) => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            let errBody = "";
            res.on("data", (d) => (errBody += d.toString()));
            res.on("end", () =>
              reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`))
            );
            return;
          }

          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith("data:")) continue;
              const dataStr = line.slice(5).trim();
              if (dataStr === "[DONE]") continue;
              try {
                const parsed = JSON.parse(dataStr);
                const delta =
                  parsed.choices &&
                  parsed.choices[0] &&
                  parsed.choices[0].delta &&
                  parsed.choices[0].delta.content;
                if (delta) onDelta(delta);
              } catch (e) {}
            }
          });
          res.on("end", () => resolve());
          res.on("error", (err) => reject(err));
        }
      );

      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }
}

class WikiAiSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new obsidian.Setting(containerEl)
      .setName("API base URL")
      .setDesc("OpenAI 兼容接口地址（如 https://api.openai.com/v1）")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.baseUrl || "")
          .onChange(async (val) => {
            this.plugin.settings.baseUrl = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName("API Key")
      .setDesc("OpenAI 兼容接口密钥")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey || "")
          .onChange(async (val) => {
            this.plugin.settings.apiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    new obsidian.Setting(containerEl)
      .setName("默认模型")
      .addDropdown((drop) => {
        for (const m of DEFAULT_MODELS) {
          drop.addOption(m.id, m.label);
        }
        drop.setValue(this.plugin.settings.model);
        drop.onChange(async (val) => {
          this.plugin.settings.model = val;
          await this.plugin.saveSettings();
        });
      });
  }
}

module.exports = WikiAiExplainerPlugin;
