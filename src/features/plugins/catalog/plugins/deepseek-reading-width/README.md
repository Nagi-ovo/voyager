---
id: voyager.deepseek-reading-width
name: DeepSeek · Comfortable Reading Width
category: readability
version: 1.0.0
author: voyager-official
license: MIT
matches:
  - https://chat.deepseek.com/*
engine: '>=1.2.0'
settings:
  width: 'number (600-1600, default 712) - max reading width in pixels'
---

# DeepSeek - Comfortable Reading Width

Gives DeepSeek one centered, adjustable reading column. The plugin follows
DeepSeek's native --message-list-max-width variable and keeps the virtual
message-list containers within the configured width.

This is a declarative plugin: pure CSS and a typed setting interpreted by
Voyager's bundled plugin engine. It does not execute remote JavaScript or load
external resources.
