# WikiGraph for Obsidian

**WikiGraph** lets you explore concepts in your notes like a living Wikipedia — with instant context-aware AI explanations, recursive `[[concept]]` rabbit-hole navigation, a native-style interactive relationship graph in the right sidebar, and one-click export to your Obsidian Vault.

## ✨ Key Features

- **Selection Floating Action**: Select any term or phrase in a note and click **AI 解析** to open a dedicated concept entry tab.
- **Recursive Wiki Exploration**: Every AI explanation highlights related concepts as `[[WikiLinks]]`. Clicking any concept dives deeper while automatically recording the directional knowledge link in your graph.
- **Single Clean Entry Tab**: Reuses a single AI entry tab in the top workspace bar while keeping all explored nodes anchored in the right-hand graph waiting for you to click.
- **Native Obsidian Graph Experience**:
  - Degree-scaled nodes and smooth zoom-out Level of Detail (LOD) where labels fade out while nodes and connecting lines remain crisp.
  - Silky-smooth cursor-centered wheel/trackpad zoom with damping interpolation.
  - Native top-right graph settings drawer (**筛选 / 颜色组 / 外观 / 力度**) plus **播放关系图谱生长动画** (timelapse physics growth animation).
- **One-Click Knowledge Base Export**: Click the Save (`💾`) button in the graph toolbar or entry header to export your entire explored knowledge base into `AI知识库/*.md` notes complete with frontmatter, upstream/downstream links, follow-up Q&A history, and a master MOC index note (`00-AI知识库全景索引（MOC）.md`).

## 🚀 Installation

### From Obsidian Community Plugins
1. Open **Settings → Community plugins → Browse** in Obsidian.
2. Search for **WikiGraph** and click **Install**, then **Enable**.

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub Release](https://github.com/Ravomi/obsidian-wikigraph/releases).
2. Place them into `<YourVault>/.obsidian/plugins/wikigraph/`.
3. Reload Obsidian and enable **WikiGraph** under **Settings → Community plugins**.

## ⚙️ Configuration

Open **Settings → WikiGraph** and configure any OpenAI-compatible API endpoint (`API Base URL`, `API Key`, and model).

## 📄 License

MIT License © Waya
