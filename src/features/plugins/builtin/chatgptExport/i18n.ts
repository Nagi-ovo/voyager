export interface ChatGptExportCopy {
  readonly button: string;
  readonly menu: string;
  readonly whole: string;
  readonly selected: string;
  readonly tempRegret: string;
  readonly collectTitle: string;
  readonly collectProgress: (count: number) => string;
  readonly cancel: string;
  readonly selectionTitle: string;
  readonly selectionHint: string;
  readonly selectAll: string;
  readonly selectNone: string;
  readonly onlyUser: string;
  readonly onlyAssistant: string;
  readonly selectedCount: (count: number) => string;
  readonly loadedCount: (count: number) => string;
  readonly next: string;
  readonly emptyConversation: string;
  readonly emptySelection: string;
  readonly formatTitle: string;
  readonly formatHint: string;
  readonly export: string;
  readonly exporting: string;
  readonly exportFailed: string;
  readonly formats: Readonly<
    Record<'markdown' | 'json' | 'pdf', { label: string; description: string }>
  >;
  readonly fontSize: string;
  readonly tempTitle: string;
  readonly tempBody: string;
  readonly tempConfirm: string;
  readonly tempNotActive: string;
  readonly tempLeaveFailed: string;
  readonly tempComposerFailed: string;
  readonly tempDeliveryFailed: string;
  readonly tempAccountChanged: string;
  readonly tempReady: string;
}

const EN: ChatGptExportCopy = {
  button: 'Export conversation',
  menu: 'Conversation export',
  whole: 'Export entire conversation',
  selected: 'Select messages to export',
  tempRegret: 'Save & continue temporary chat',
  collectTitle: 'Collecting the conversation',
  collectProgress: (count) => `${count} messages collected`,
  cancel: 'Cancel',
  selectionTitle: 'Select messages',
  selectionHint:
    'Tick messages in the conversation. Scroll up normally and newly loaded messages will get checkboxes automatically.',
  selectAll: 'All loaded',
  selectNone: 'None',
  onlyUser: 'Loaded: only you',
  onlyAssistant: 'Loaded: only ChatGPT',
  selectedCount: (count) => `${count} selected`,
  loadedCount: (count) => `${count} loaded`,
  next: 'Choose format',
  emptyConversation: 'No exportable messages were found in this conversation.',
  emptySelection: 'Select at least one message.',
  formatTitle: 'Choose export format',
  formatHint: 'The same formats are available for the whole conversation and a selected subset.',
  export: 'Export',
  exporting: 'Preparing export…',
  exportFailed: 'Export failed',
  formats: {
    markdown: {
      label: 'Markdown',
      description: 'Portable text with code, links, tables and math.',
    },
    json: { label: 'JSON', description: 'Structured archive with message ids and roles.' },
    pdf: {
      label: 'PDF',
      description: 'Prints rich message layout with code, tables, math and available images.',
    },
  },
  fontSize: 'Font size',
  tempTitle: 'Save and continue this temporary chat?',
  tempBody:
    'Voyager will first download a Markdown backup, leave temporary mode, and place a hand-off prompt in a normal chat. It will not send the prompt.',
  tempConfirm: 'Save & continue',
  tempNotActive: 'This action is only available in a temporary chat.',
  tempLeaveFailed: 'The backup was saved, but ChatGPT did not leave temporary mode.',
  tempComposerFailed:
    'The backup was saved, but the new composer was not found. The hand-off remains available for this tab for one minute.',
  tempDeliveryFailed:
    'The backup was saved, but ChatGPT did not accept the attachment. Your existing draft was not changed.',
  tempAccountChanged:
    'The backup was saved, but the active ChatGPT account changed. The hand-off was not inserted.',
  tempReady: 'Backup saved. Review the hand-off prompt, then send it when ready.',
};

const ZH: ChatGptExportCopy = {
  button: '导出对话',
  menu: '对话导出',
  whole: '导出整个对话',
  selected: '选择消息后导出',
  tempRegret: '保存并反悔临时对话',
  collectTitle: '正在收集完整对话',
  collectProgress: (count) => `已收集 ${count} 条消息`,
  cancel: '取消',
  selectionTitle: '选择要导出的消息',
  selectionHint: '直接勾选对话里的消息；正常向上翻，新加载的消息会自动出现选择框。',
  selectAll: '全选已加载',
  selectNone: '全不选',
  onlyUser: '已加载：只选我',
  onlyAssistant: '已加载：只选 ChatGPT',
  selectedCount: (count) => `已选择 ${count} 条`,
  loadedCount: (count) => `已加载 ${count} 条`,
  next: '选择格式',
  emptyConversation: '当前对话里没有找到可导出的消息。',
  emptySelection: '请至少选择一条消息。',
  formatTitle: '选择导出格式',
  formatHint: '整体导出和选择导出使用同一套格式。',
  export: '导出',
  exporting: '正在生成导出文件…',
  exportFailed: '导出失败',
  formats: {
    markdown: { label: 'Markdown', description: '便携文本，保留代码、链接、表格和公式。' },
    json: { label: 'JSON', description: '保留消息 ID、角色和内容的结构化归档。' },
    pdf: {
      label: 'PDF',
      description: '保留代码、表格、公式和可读取图片的富文本排版，再打开打印窗口。',
    },
  },
  fontSize: '字号',
  tempTitle: '保存并继续这个临时对话？',
  tempBody:
    'Voyager 会先下载 Markdown 备份，再退出临时模式，并把交接提示填入普通对话。不会自动发送。',
  tempConfirm: '保存并继续',
  tempNotActive: '该操作只在临时对话中可用。',
  tempLeaveFailed: '备份已经保存，但 ChatGPT 没有成功退出临时模式。',
  tempComposerFailed: '备份已经保存，但没有找到新对话输入框；交接内容会在本标签页保留一分钟。',
  tempDeliveryFailed: '备份已经保存，但 ChatGPT 没有接受附件；现有输入草稿未被修改。',
  tempAccountChanged: '备份已经保存，但当前 ChatGPT 账号发生了变化；交接内容没有写入。',
  tempReady: '备份已保存。请检查交接提示，确认后再手动发送。',
};

export function getChatGptExportCopy(): ChatGptExportCopy {
  return /^zh(?:-|_|$)/i.test(navigator.language) ? ZH : EN;
}
