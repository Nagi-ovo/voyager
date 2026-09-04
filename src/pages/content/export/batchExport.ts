// Batch Export feature implementation for Voyager
// Enables multi-select of conversations from the sidebar and sequential export to Markdown

export interface BatchConversationItem {
  id: string;
  href: string;
  title: string;
  element?: HTMLElement;
}

export function getSidebarConversations(): BatchConversationItem[] {
  const container =
    document.querySelector('[data-test-id="overflow-container"]') ||
    document.querySelector('nav, side-nav, [data-test-id="side-nav"]') ||
    document;
  const elements = Array.from(
    container.querySelectorAll('[data-test-id="conversation"], a[href*="/app/"], a[href*="/gem/"]'),
  );
  const seen = new Set<string>();
  const list: BatchConversationItem[] = [];

  const getCid = (url: string) => {
    const m = String(url || '').match(/\/(?:app|gem\/[^/]+)\/([a-f0-9]+)/i);
    return m ? m[1] : null;
  };

  for (const el of elements) {
    const a = el.matches('a[href]') ? (el as HTMLAnchorElement) : el.querySelector<HTMLAnchorElement>('a[href]');
    const href = a?.href || a?.getAttribute('href') || el.getAttribute('href');
    if (!href) continue;
    const id = getCid(href) || href;
    if (seen.has(id)) continue;
    seen.add(id);

    const titleEl = el.querySelector('.conversation-title-text, [data-test-id="conversation-title"], .title-text, h3');
    let title =
      titleEl?.textContent?.trim() ||
      el.getAttribute('aria-label') ||
      el.textContent?.trim()?.slice(0, 35) ||
      id;
    title = title.replace(/[\r\n\t]+/g, ' ').trim();
    list.push({ id, href, title, element: (a || el) as HTMLElement });
  }

  return list;
}

export function showBatchExportMultiSelectModal(
  conversations: BatchConversationItem[],
  onConfirm: (selected: BatchConversationItem[]) => void,
  onCancel?: () => void,
): void {
  document.querySelectorAll('.gv-batch-modal-overlay').forEach((e) => e.remove());

  const overlay = document.createElement('div');
  overlay.className = 'gv-batch-modal-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    height: '100vh',
    backgroundColor: 'rgba(0,0,0,0.5)',
    zIndex: '99999',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(4px)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    width: '540px',
    maxWidth: '92vw',
    maxHeight: '85vh',
    backgroundColor: '#ffffff',
    borderRadius: '14px',
    boxShadow: '0 20px 25px -5px rgba(0,0,0,0.2), 0 8px 10px -6px rgba(0,0,0,0.1)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    color: '#1f2937',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '16px 20px',
    borderBottom: '1px solid #e5e7eb',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  });

  const title = document.createElement('div');
  title.innerHTML = `<div style="font-size:16px;font-weight:600;color:#111827;">📦 批量导出对话 (Markdown)</div><div style="font-size:12px;color:#6b7280;margin-top:2px;">检测到 ${conversations.length} 个会话，请勾选需要导出的会话：</div>`;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    border: 'none',
    background: 'transparent',
    fontSize: '18px',
    cursor: 'pointer',
    color: '#9ca3af',
    padding: '4px 8px',
    borderRadius: '6px',
  });
  closeBtn.addEventListener('click', () => {
    overlay.remove();
    onCancel?.();
  });

  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const subBar = document.createElement('div');
  Object.assign(subBar.style, {
    padding: '10px 20px',
    background: '#f9fafb',
    borderBottom: '1px solid #e5e7eb',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  });

  const btnGroup = document.createElement('div');
  btnGroup.style.display = 'flex';
  btnGroup.style.gap = '8px';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.textContent = '全选';
  Object.assign(selectAllBtn.style, {
    padding: '4px 10px',
    fontSize: '12px',
    borderRadius: '6px',
    border: '1px solid #d1d5db',
    background: '#ffffff',
    cursor: 'pointer',
  });

  const deselectAllBtn = document.createElement('button');
  deselectAllBtn.type = 'button';
  deselectAllBtn.textContent = '取消全选';
  Object.assign(deselectAllBtn.style, {
    padding: '4px 10px',
    fontSize: '12px',
    borderRadius: '6px',
    border: '1px solid #d1d5db',
    background: '#ffffff',
    cursor: 'pointer',
  });

  btnGroup.appendChild(selectAllBtn);
  btnGroup.appendChild(deselectAllBtn);

  const countBadge = document.createElement('div');
  countBadge.style.fontSize = '12px';
  countBadge.style.color = '#4b5563';
  subBar.appendChild(btnGroup);
  subBar.appendChild(countBadge);
  modal.appendChild(subBar);

  const listContainer = document.createElement('div');
  Object.assign(listContainer.style, {
    padding: '8px 12px',
    overflowY: 'auto',
    flex: '1',
    maxHeight: '48vh',
  });

  const selectedSet = new Set<string>();
  const checkboxes: HTMLInputElement[] = [];

  const updateCount = () => {
    countBadge.innerHTML = `已选择 <b>${selectedSet.size}</b> / ${conversations.length} 个会话`;
    confirmBtn.disabled = selectedSet.size === 0;
    confirmBtn.style.opacity = selectedSet.size === 0 ? '0.5' : '1';
    confirmBtn.textContent = `开始导出 (${selectedSet.size} 个会话)`;
  };

  const currentCid = location.href.match(/\/(?:app|gem\/[^/]+)\/([a-f0-9]+)/i)?.[1] || null;

  conversations.forEach((item, index) => {
    const isCurrent = currentCid && item.id === currentCid;
    selectedSet.add(item.id);

    const row = document.createElement('label');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      padding: '8px 10px',
      borderRadius: '6px',
      cursor: 'pointer',
      userSelect: 'none',
      transition: 'background-color 0.15s',
      gap: '10px',
      marginBottom: '2px',
    });
    row.addEventListener('mouseenter', () => (row.style.backgroundColor = '#f3f4f6'));
    row.addEventListener('mouseleave', () => (row.style.backgroundColor = 'transparent'));

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.style.width = '16px';
    cb.style.height = '16px';
    cb.style.cursor = 'pointer';

    cb.addEventListener('change', () => {
      if (cb.checked) selectedSet.add(item.id);
      else selectedSet.delete(item.id);
      updateCount();
    });
    checkboxes.push(cb);

    const indexSpan = document.createElement('span');
    indexSpan.textContent = `${index + 1}.`;
    indexSpan.style.color = '#9ca3af';
    indexSpan.style.fontSize = '12px';
    indexSpan.style.minWidth = '24px';

    const titleSpan = document.createElement('span');
    titleSpan.textContent = item.title || item.id;
    Object.assign(titleSpan.style, {
      fontSize: '13px',
      color: '#111827',
      flex: '1',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });

    row.appendChild(cb);
    row.appendChild(indexSpan);
    row.appendChild(titleSpan);

    if (isCurrent) {
      const tag = document.createElement('span');
      tag.textContent = '当前';
      Object.assign(tag.style, {
        fontSize: '11px',
        padding: '2px 6px',
        borderRadius: '4px',
        backgroundColor: '#e0e7ff',
        color: '#3730a3',
        fontWeight: '500',
      });
      row.appendChild(tag);
    }

    listContainer.appendChild(row);
  });

  selectAllBtn.addEventListener('click', () => {
    conversations.forEach((c) => selectedSet.add(c.id));
    checkboxes.forEach((cb) => (cb.checked = true));
    updateCount();
  });

  deselectAllBtn.addEventListener('click', () => {
    selectedSet.clear();
    checkboxes.forEach((cb) => (cb.checked = false));
    updateCount();
  });

  modal.appendChild(listContainer);

  const footer = document.createElement('div');
  Object.assign(footer.style, {
    padding: '12px 20px',
    borderTop: '1px solid #e5e7eb',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '10px',
    backgroundColor: '#ffffff',
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = '取消';
  Object.assign(cancelBtn.style, {
    padding: '8px 16px',
    fontSize: '13px',
    borderRadius: '6px',
    border: '1px solid #d1d5db',
    backgroundColor: '#ffffff',
    cursor: 'pointer',
    color: '#374151',
  });
  cancelBtn.addEventListener('click', () => {
    overlay.remove();
    onCancel?.();
  });

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = `开始导出 (${selectedSet.size} 个会话)`;
  Object.assign(confirmBtn.style, {
    padding: '8px 18px',
    fontSize: '13px',
    borderRadius: '6px',
    border: 'none',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    fontWeight: '500',
    cursor: 'pointer',
  });

  confirmBtn.addEventListener('click', () => {
    const selectedList = conversations.filter((c) => selectedSet.has(c.id));
    overlay.remove();
    onConfirm(selectedList);
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  updateCount();
}
