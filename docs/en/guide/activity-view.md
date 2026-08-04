---
title: Activity view
description: Sort folder conversations by real chat activity so work that is still moving appears first.
---

# Activity: keep your attention on conversations in motion

Folders answer one question: where does this conversation belong? As your archive grows, another question comes up more often: what should you look at now?

Activity is a time-based view over your folders. Click the bell beside **Folders** to replace the folder tree with conversations ordered by real chat activity. It does not change your folders, conversation assignments, or Star state.

**Design inspiration:** This view was inspired by the sidebar in OpenAI's Codex / ChatGPT Desktop. Voyager carries over the idea of surfacing conversations that are still active, then adapts it into a time-based view over Gemini folders.

<img src="/assets/activity-view.png" alt="The Activity attention view in the Gemini sidebar" style="display: block; width: 100%; max-width: 517px; margin: 24px auto; border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,0.12);"/>

## Priority follows recent activity

Priority contains conversations with a new turn in the last **three hours**. It uses the real conversation time, not the time when you opened or viewed a chat.

A conversation in Priority does not also appear in Today. When its three-hour activity window ends, Activity automatically returns it to Today or the relevant date group. You do not need to refresh the page.

Star remains available as a separate manual marker. Starring a conversation does not move it into Priority, and removing a Star does not remove an active conversation from Priority.

## A short window over recent days

Below Priority, Activity shows Today, Yesterday, and weekday headings for the preceding days. The view covers today and the previous four calendar days, keeping the list close to current work.

Older conversations and legacy entries without an activity time do not appear here. They are not hidden or deleted. Click the bell again to return to the folder tree and find them in their original location.

## One conversation, one row

A conversation can belong to more than one folder. Activity merges those references into one row and keeps the folder names below its title. Hover over the folder context to see the full paths.

This keeps one conversation from taking up several slots in Priority or Today while preserving its project context.

## Three signals with different jobs

| Signal   | Source                            | The question it answers                 |
| -------- | --------------------------------- | --------------------------------------- |
| Folders  | Projects and topics you organize  | Where does this conversation belong?    |
| Activity | The latest real conversation turn | What work has been moving recently?     |
| Star     | A manual marker                   | Which conversations should stay marked? |

Folders are useful when you need to retrieve something from the archive. Activity narrows the set of choices each time you return to Gemini. Start with a conversation that still has momentum in Priority, continue through Today or Yesterday, then switch back to the full folder tree when you need older material.
