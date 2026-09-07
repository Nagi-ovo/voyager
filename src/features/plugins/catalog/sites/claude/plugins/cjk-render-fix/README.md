---
id: voyager.claude-cjk-render-fix
name: Claude · CJK Render Fix
category: render-fix
version: 1.1.0
author: voyager-official
license: MIT
matches:
  - https://claude.ai/*
engine: '>=1.2.0'
---

# Claude · CJK Render Fix

Fixes uneven **CJK (Chinese · Japanese · Korean)** rendering in Claude responses
**on macOS**, where some characters look noticeably thinner than the rest.

## The problem

Two issues compound on macOS:

1. **Font fallback jumps.** Claude's font stack lists Japanese / Traditional
   fonts (`Hiragino Sans`, `PingFang TC`) _before_ `PingFang SC`. Some Simplified
   characters (这 / 些 / 术 / 语 …) exist in those earlier fonts, so they get
   rendered by them — visibly thinner — while the rest fall through to PingFang
   SC. The result is the "some thin, some normal" look within a single sentence.
2. **Non-standard weight.** Body text is set to `font-weight: 360`, a value the
   CJK fallback fonts don't provide, so macOS synthesizes an uneven faux weight.

## The fix

- Pull **`PingFang SC` to the front** of the CJK font stack, so all Simplified
  text renders in one consistent font.
- Normalize plain body text to a real **`400`** weight.
- Disable weight synthesis (`font-synthesis-weight: none`).

`<strong>` carries its own heavier weight, so the bold / normal contrast is
preserved — bold stays bold, normal text is now even.

This is a **declarative** plugin: pure CSS data, interpreted by Voyager's bundled
engine. No executable code.
