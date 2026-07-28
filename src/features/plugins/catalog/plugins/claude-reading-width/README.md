---
id: voyager.claude-reading-width
name: Claude · Comfortable Reading Width
category: readability
version: 1.4.0
author: voyager-official
license: MIT
matches:
  - https://claude.ai/*
  - https://*.frame.claudeusercontent.com/*
engine: '>=1.2.0'
settings:
  width: 'number (600–1600, default 768) — max reading width in pixels'
---

# Claude · Comfortable Reading Width

Gives Claude one **centered, equal-width reading column**. By default Claude caps
each turn at a fixed width _and_ pins user messages to the right, so user input,
the thinking line, and the response don't line up. This plugin makes them share a
single centered column of the same width.

## The fix

- Claude caps each conversation turn at `max-w-3xl` (768px). That cap also makes
  a per-message `max-width` ineffective — the parent always wins. So the width is
  set on the **turn containers** themselves (user + assistant alike), which are
  `mx-auto` and therefore stay centered.
- The user message is flipped from its right-aligned bubble to **left-aligned**,
  matching the assistant, so the whole thread reads as one column.
- Claude document artifacts load from a cross-origin
  `*.frame.claudeusercontent.com` iframe. Their direct `.wrap` reading column is
  widened there as well, with `border-box` sizing so the configured pixel value
  remains the visible width (including the artifact's horizontal padding).

## Adjustable

Exposes a **width** setting (600–1600 px, default **768** — Claude's native
width). In the Voyager popup the plugin shows a slider; dragging it updates the
width live. The value is substituted into the CSS (`max-width: {{width}}px`) by
Voyager's engine. Push the slider right for a much wider column on big screens.

This is a **declarative** plugin: pure CSS + a typed setting, interpreted by
Voyager's bundled engine. No executable code.
