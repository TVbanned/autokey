---
version: alpha
name: autokey-design-system
description: 基于 Supabase 设计语言启发的 KeyFlow 游戏测评管理后台设计系统 —— 纯白画布搭配翡翠绿主题色，Inter 字体体系，清晰的数据密集型仪表盘界面。

colors:
  primary: "#3ecf8e"
  primary-deep: "#24b47e"
  primary-soft: "#e6f9f1"
  ink: "#171717"
  ink-secondary: "#4d4d4d"
  ink-mute: "#888888"
  ink-faint: "#b8b8b8"
  on-primary: "#171717"
  on-dark: "#ffffff"
  canvas: "#ffffff"
  canvas-soft: "#fafafa"
  canvas-soft-2: "#f5f5f5"
  shadow-canvas: "#f8f8fa"
  hairline: "#e6e6e6"
  hairline-strong: "#d4d4d4"
  brand-zhihu: "#0084ff"
  semantic-success: "#3ecf8e"
  semantic-warning: "#f5a623"
  semantic-error: "#ee0000"
  accent-purple: "#6b01c2"
  accent-blue: "#054cff"

typography:
  display-lg:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, -apple-system, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.72px
  display-md:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, -apple-system, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.4px
  heading:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, -apple-system, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: -0.2px
  body:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, -apple-system, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  body-sm:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, -apple-system, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  button:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, -apple-system, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: 0
  caption:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, -apple-system, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  micro:
    fontFamily: "Inter, 'Noto Sans SC', system-ui, -apple-system, sans-serif"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0

rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  huge: 64px

components:
  sidebar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.body-sm}"
    width: 240px
    padding: 16px 12px
  nav-item:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 10px 12px
  nav-item-active:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-deep}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 10px 12px
  topbar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    height: 56px
    padding: 0 24px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: 8px 16px
    minimum height: 36px
  button-primary-hover:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    borderColor: "{colors.hairline-strong}"
    padding: 8px 16px
    border: 1px solid
  card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    borderColor: "{colors.hairline}"
    padding: 24px
    border: 1px solid
  card-soft:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    borderColor: "{colors.hairline}"
    padding: 24px
    border: 1px solid
  metric-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    borderColor: "{colors.hairline}"
    padding: 16px
    border: 1px solid
  table:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body-sm}"
  table-header:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink-mute}"
    typography: "{typography.caption}"
  modal:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.xl}"
    padding: 24px
  modal-backdrop:
    backgroundColor: "rgba(0,0,0,0.4)"
  form-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    borderColor: "{colors.hairline}"
    padding: 8px 12px
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 12px 16px
  pill-success:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-deep}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: 2px 10px
  pill-warning:
    backgroundColor: "#fff8e6"
    textColor: "#b8860b"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: 2px 10px
  pill-muted:
    backgroundColor: "{colors.canvas-soft-2}"
    textColor: "{colors.ink-mute}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: 2px 10px
  brand-mark:
    backgroundColor: "{colors.brand-zhihu}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    width: 28px
    height: 28px
  footer-cta:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.md}"
    padding: 16px
---

## Overview

KeyFlow（autokey）是一个游戏测评活动管理后台，用于管理测评活动、答主报名、游戏 Key 分发和交付验收。设计系统基于 Supabase 的设计语言启发，采用纯白画布 + 翡翠绿主色的清晰仪表盘风格。

**Key Characteristics:**
- 翡翠绿主题色（`{colors.primary}` `#3ecf8e`）作为唯一的色彩事件，用于 CTA 按钮和活跃状态
- 纯白画布仪表盘风格，灰色阶梯从 `{colors.hairline}` 到 `{colors.ink}` 承载层次
- Inter + Noto Sans SC 字体体系，显示层级使用 600 weight + 负字间距
- 6px 方形按钮圆角 — 干净、技术感，不使用药丸形
- 指标卡片使用 8px 圆角 + 1px hairline 边框
- 数据表格清晰、信息密度高
- 知乎蓝（`#0084ff`）作为品牌标记专用色

## Colors

### Brand & Accent
- **Emerald** (`{colors.primary}` — `#3ecf8e`): 主题 CTA 颜色，用于主按钮背景和活跃状态强调
- **Emerald Deep** (`{colors.primary-deep}` — `#24b47e`): 按下状态
- **Emerald Soft** (`{colors.primary-soft}` — `#e6f9f1`): 柔和的翡翠绿背景，用于导航激活态、成功标签
- **Zhihu Blue** (`{colors.brand-zhihu}` — `#0084ff`): 知乎品牌标记专用色

### Surface
- **Canvas** (`{colors.canvas}` — `#ffffff`): 卡片、侧边栏默认背景
- **Canvas Soft** (`{colors.canvas-soft}` — `#fafafa`): 表格表头、柔和卡片
- **Shadow Canvas** (`{colors.shadow-canvas}` — `#f8f8fa`): 页面整体背景
- **Hairline** (`{colors.hairline}` — `#e6e6e6`): 1px 边框
- **Hairline Strong** (`{colors.hairline-strong}` — `#d4d4d4`): 较深边框

### Text
- **Ink** (`{colors.ink}` — `#171717`): 主文字色
- **Ink Secondary** (`{colors.ink-secondary}` — `#4d4d4d`): 辅助文字
- **Ink Mute** (`{colors.ink-mute}` — `#888888`): 弱化文字
- **Ink Faint** (`{colors.ink-faint}` — `#b8b8b8`): 占位文字
- **On Dark** (`{colors.on-dark}` — `#ffffff`): 深色表面文字

### Semantic
- **Success** (`{colors.semantic-success}` — `#3ecf8e`): 成功状态
- **Warning** (`{colors.semantic-warning}` — `#f5a623`): 警告状态
- **Error** (`{colors.semantic-error}` — `#ee0000`): 错误状态

## Typography

### Font Family
- **Inter** — 主字体（替代 Circular），用于标题、正文、按钮。Weights: 400 / 500 / 600
- **Noto Sans SC** — 中文 fallback 字体

### Hierarchy
| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-lg}` | 24px | 600 | 1.3 | -0.72px | 页面标题 |
| `{typography.display-md}` | 20px | 600 | 1.3 | -0.4px | 弹窗标题、面板标题 |
| `{typography.heading}` | 16px | 600 | 1.4 | -0.2px | 卡片标题 |
| `{typography.body}` | 14px | 400 | 1.5 | 0 | 默认正文 |
| `{typography.body-sm}` | 13px | 400 | 1.5 | 0 | 侧边栏、导航 |
| `{typography.button}` | 13px | 500 | 1.0 | 0 | 按钮标签 |
| `{typography.caption}` | 12px | 400 | 1.45 | 0 | 辅助说明 |
| `{typography.micro}` | 11px | 400 | 1.45 | 0 | 标签、徽章 |

### Principles
- 标题使用 600 weight + 负字间距
- 正文使用 400 weight
- 按钮使用 500 weight
- 中英文混排时 Noto Sans SC 作为 CJK fallback

## Layout

### Spacing System
- **Base unit**: 4px
- **Tokens**: `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.md}` 16px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px · `{spacing.huge}` 64px
- 内容区最大宽度: 1280px
- 卡片内边距: 24px
- 按钮内边距: 8px 16px

### Grid & Container
- 侧边栏宽度: 240px
- 指标卡片: 4 列网格（桌面端）
- 表单: 2 列网格

### Responsive
| Breakpoint | Width | Key Changes |
|---|---|---|
| Desktop | ≥ 1024px | 完整侧边栏 + 4 列指标 |
| Tablet | 768–1023px | 侧边栏可见，2 列指标 |
| Mobile | < 768px | 隐藏侧边栏，1 列布局 |

## Components

### Buttons
- **button-primary**: 翡翠绿填充按钮，`{rounded.sm}` 6px
- **button-secondary**: 白色描边按钮，1px `{colors.hairline-strong}` 边框

### Cards & Containers
- **card**: 白色卡片，`{rounded.lg}` 12px，1px hairline 边框
- **metric-card**: 指标卡片，`{rounded.md}` 8px
- **modal**: 弹窗，`{rounded.xl}` 16px

### Navigation
- **sidebar**: 240px 宽，白色背景，右侧 hairline 分割线
- **nav-item**: 悬停态浅灰背景，激活态翡翠绿浅色背景
- **topbar**: 56px 高，白色背景

### Data Display
- **table**: 清晰的数据表格，表头使用 canvas-soft 背景
- **pill**: 状态标签，圆角胶囊形

## Do's and Don'ts

### Do
- 翡翠绿仅用于 CTA 按钮和激活状态 — 让它稀缺
- 使用 `{rounded.sm}` 6px 作为按钮圆角
- 显示层级使用 weight 600 + 负字间距
- 卡片使用 1px hairline 边框分隔
- 状态标签使用 `{rounded.full}` 胶囊形

### Don't
- 不要在非 CTA 区域大面积使用翡翠绿
- 不要使用药丸形按钮
- 不要使用过于饱和的强调色
- 不要在大面积背景上使用渐变
- 按钮文字不要在翡翠绿底色上使用白色（使用 near-black 墨色）
