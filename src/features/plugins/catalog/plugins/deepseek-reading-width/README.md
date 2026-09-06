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

Gives DeepSeek one centered, adjustable reading column (600-1600 px, default
712 px). The column shrinks to the available chat area with 20 px side gutters.
It scopes horizontal sizing to the printable virtual list containing messages,
replacing its native calculated horizontal padding while preserving vertical
padding, transforms and virtualization. Other lists and the composer stay native.

Disable the plugin to restore the native layout. Settings and enable state use
Voyager's existing plugin storage and optional host-permission flow.

This is a declarative plugin: pure CSS and a typed setting interpreted by
Voyager's bundled plugin engine. It does not execute remote JavaScript or load
external resources.
