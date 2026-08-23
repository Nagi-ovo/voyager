import type { PluginManifest } from '../types';

/**
 * Built-in (bundled-in-the-extension) plugins — first-party data, NOT from the
 * remote marketplace.
 *
 * Use this only for genuinely first-party features that need JS and so can't be
 * expressed as remote declarative data — a "native function plugin": the
 * manifest declares no styles/domOps, and the content script binds the actual
 * behaviour by calling `registerNativeHandler(<same id>, { start, stop })` (see
 * runtime/nativeHandlers). The engine runs that handler in lockstep with the
 * plugin's mount/unmount, so the feature is visible + toggleable in the plugin
 * list and scoped by `matches`, while the code stays first-party.
 *
 * Like every plugin, builtin plugins ship DISABLED by default — the user turns
 * them on in the popup.
 */
export const BUILTIN_PLUGINS: readonly PluginManifest[] = [
  {
    id: 'voyager.formula-copy',
    name: 'Formula Copy',
    version: '1.0.0',
    description: "Click an inline or block formula to copy its LaTeX; hover shows it's clickable.",
    i18n: {
      zh: {
        name: '公式复制',
        description: '点击行内或块级公式即可复制 LaTeX；悬停时会提示可点击。',
      },
      zh_TW: {
        name: '公式複製',
        description: '點擊行內或區塊公式即可複製 LaTeX；滑鼠懸停時會提示可點擊。',
      },
      ja: {
        name: '数式コピー',
        description:
          'インラインまたはブロック数式をクリックして LaTeX をコピーできます。ホバーするとクリック可能であることが分かります。',
      },
      ko: {
        name: '수식 복사',
        description:
          '인라인 또는 블록 수식을 클릭해 LaTeX를 복사합니다. 마우스를 올리면 클릭 가능함을 표시합니다.',
      },
      fr: {
        name: 'Copie de formules',
        description:
          "Cliquez sur une formule en ligne ou en bloc pour copier son LaTeX ; le survol indique qu'elle est cliquable.",
      },
      es: {
        name: 'Copia de fórmulas',
        description:
          'Haz clic en una fórmula en línea o en bloque para copiar su LaTeX; al pasar el cursor se muestra que se puede hacer clic.',
      },
      pt: {
        name: 'Cópia de fórmulas',
        description:
          'Clique em uma fórmula inline ou em bloco para copiar o LaTeX; ao passar o cursor, ela indica que pode ser clicada.',
      },
      ru: {
        name: 'Копирование формул',
        description:
          'Нажмите на строчную или блочную формулу, чтобы скопировать её LaTeX; при наведении видно, что её можно нажать.',
      },
      ar: {
        name: 'نسخ الصيغ',
        description:
          'انقر على صيغة مضمنة أو كتلية لنسخ LaTeX الخاص بها؛ ويظهر عند التحويم أنها قابلة للنقر.',
      },
    },
    author: 'voyager-official',
    category: 'productivity',
    license: 'GPL-3.0-or-later',
    engine: '>=1.1.0',
    tier: 'declarative',
    matches: ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://chat.openai.com/*'],
    contributes: {},
  },
  {
    id: 'voyager.input-vim',
    name: 'Vim Input',
    version: '1.0.0',
    description: 'Adds Vim-style modal editing and navigation to the prompt composer.',
    i18n: {
      zh: {
        name: 'Vim 输入',
        description: '为提示词输入框添加 Vim 风格的模式编辑与光标导航。',
      },
      zh_TW: {
        name: 'Vim 輸入',
        description: '為提示詞輸入框加入 Vim 風格的模式編輯與游標導覽。',
      },
      ja: {
        name: 'Vim 入力',
        description: 'プロンプト入力欄に Vim 風のモーダル編集とカーソル移動を追加します。',
      },
      ko: {
        name: 'Vim 입력',
        description: '프롬프트 입력창에 Vim 스타일 모달 편집과 커서 이동을 추가합니다.',
      },
      fr: {
        name: 'Saisie Vim',
        description:
          "Ajoute l'édition modale et la navigation du curseur de style Vim au champ de saisie.",
      },
      es: {
        name: 'Entrada Vim',
        description:
          'Añade edición modal y navegación del cursor al estilo Vim al cuadro de entrada.',
      },
      pt: {
        name: 'Entrada Vim',
        description:
          'Adiciona edição modal e navegação de cursor no estilo Vim ao campo de entrada.',
      },
      ru: {
        name: 'Vim-ввод',
        description: 'Добавляет в поле ввода модальное редактирование и навигацию в стиле Vim.',
      },
      ar: {
        name: 'إدخال Vim',
        description: 'يضيف التحرير النمطي والتنقل بالمؤشر بأسلوب Vim إلى حقل الإدخال.',
      },
    },
    author: 'voyager-official',
    category: 'productivity',
    license: 'GPL-3.0-or-later',
    engine: '>=1.1.0',
    tier: 'declarative',
    matches: ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://chat.openai.com/*'],
    contributes: {},
  },
  {
    id: 'voyager.claude-timeline',
    name: 'Claude · Timeline',
    version: '1.1.0',
    description: 'Adds a compact conversation timeline to Claude with starred messages and search.',
    i18n: {
      zh: {
        name: 'Claude · 时间线',
        description: '为 Claude 添加紧凑的对话时间线，支持星标消息和搜索。',
        settings: { compactView: { label: '使用紧凑索引' } },
      },
      zh_TW: {
        name: 'Claude · 時間線',
        description: '為 Claude 加入緊湊的對話時間線，支援星標訊息與搜尋。',
        settings: { compactView: { label: '使用精簡索引' } },
      },
      ja: {
        name: 'Claude · タイムライン',
        description:
          'Claude にコンパクトな会話タイムラインを追加し、スター付きメッセージと検索に対応します。',
        settings: { compactView: { label: 'コンパクト表示を使う' } },
      },
      ko: {
        name: 'Claude · 타임라인',
        description: 'Claude에 별표 메시지와 검색을 지원하는 간단한 대화 타임라인을 추가합니다.',
        settings: { compactView: { label: '컴팩트 타임라인 사용' } },
      },
      fr: {
        name: 'Claude · Timeline',
        description: 'Ajoute une timeline compacte à Claude avec messages favoris et recherche.',
        settings: { compactView: { label: 'Utiliser la chronologie compacte' } },
      },
      es: {
        name: 'Claude · Línea de tiempo',
        description:
          'Añade a Claude una línea de tiempo compacta con mensajes destacados y búsqueda.',
        settings: { compactView: { label: 'Usar cronología compacta' } },
      },
      pt: {
        name: 'Claude · Linha do tempo',
        description:
          'Adiciona ao Claude uma linha do tempo compacta com mensagens favoritas e busca.',
        settings: { compactView: { label: 'Usar linha do tempo compacta' } },
      },
      ru: {
        name: 'Claude · Таймлайн',
        description: 'Добавляет в Claude компактную шкалу диалога со звёздами и поиском.',
        settings: { compactView: { label: 'Использовать компактную шкалу' } },
      },
      ar: {
        name: 'Claude · المخطط الزمني',
        description: 'يضيف إلى Claude مخططًا زمنيًا موجزًا مع الرسائل المميزة والبحث.',
        settings: { compactView: { label: 'استخدام المخطط الزمني المضغوط' } },
      },
    },
    author: 'voyager-official',
    category: 'productivity',
    license: 'GPL-3.0-or-later',
    engine: '>=1.1.0',
    tier: 'declarative',
    matches: ['https://claude.ai/*'],
    contributes: {
      settings: {
        compactView: {
          type: 'boolean',
          label: 'Use compact timeline',
          default: false,
        },
      },
    },
  },
  {
    id: 'voyager.chatgpt-export',
    name: 'ChatGPT · Conversation Export',
    version: '1.0.0',
    description: 'Export the current ChatGPT conversation as Markdown, JSON, PDF, or an image.',
    i18n: {
      zh: {
        name: 'ChatGPT · 对话导出',
        description: '将当前 ChatGPT 对话导出为 Markdown、JSON、PDF 或图片。',
      },
      zh_TW: {
        name: 'ChatGPT · 對話匯出',
        description: '將目前 ChatGPT 對話匯出為 Markdown、JSON、PDF 或圖片。',
      },
      ja: {
        name: 'ChatGPT · 会話エクスポート',
        description:
          '現在の ChatGPT 会話を Markdown、JSON、PDF、または画像としてエクスポートします。',
      },
      ko: {
        name: 'ChatGPT · 대화 내보내기',
        description: '현재 ChatGPT 대화를 Markdown, JSON, PDF 또는 이미지로 내보냅니다.',
      },
      fr: {
        name: 'ChatGPT · Export de conversation',
        description:
          'Exporte la conversation ChatGPT actuelle au format Markdown, JSON, PDF ou image.',
      },
      es: {
        name: 'ChatGPT · Exportar conversación',
        description: 'Exporta la conversación actual de ChatGPT como Markdown, JSON, PDF o imagen.',
      },
      pt: {
        name: 'ChatGPT · Exportar conversa',
        description: 'Exporte a conversa atual do ChatGPT como Markdown, JSON, PDF ou imagem.',
      },
      ru: {
        name: 'ChatGPT · Экспорт диалога',
        description: 'Экспортирует текущий диалог ChatGPT в Markdown, JSON, PDF или изображение.',
      },
      ar: {
        name: 'ChatGPT · تصدير المحادثة',
        description: 'يصدّر محادثة ChatGPT الحالية بصيغة Markdown أو JSON أو PDF أو صورة.',
      },
    },
    author: 'voyager-official',
    category: 'productivity',
    license: 'GPL-3.0-or-later',
    engine: '>=1.2.0',
    tier: 'declarative',
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    contributes: {},
  },
  {
    id: 'voyager.chatgpt-temporary-handoff',
    name: 'ChatGPT · Temporary Chat Handoff',
    version: '1.0.0',
    description: 'Save a temporary ChatGPT conversation and continue it safely in a normal chat.',
    i18n: {
      zh: {
        name: 'ChatGPT · 临时对话反悔',
        description: '保存临时 ChatGPT 对话，并安全地转到普通聊天继续。',
      },
      zh_TW: {
        name: 'ChatGPT · 暫時對話反悔',
        description: '儲存暫時 ChatGPT 對話，並安全地轉到一般聊天繼續。',
      },
      ja: {
        name: 'ChatGPT · 一時チャット引き継ぎ',
        description: '一時チャットを保存し、通常のチャットへ安全に引き継ぎます。',
      },
      ko: {
        name: 'ChatGPT · 임시 채팅 이어가기',
        description: '임시 ChatGPT 대화를 저장하고 일반 채팅에서 안전하게 이어갑니다.',
      },
      fr: {
        name: 'ChatGPT · Transfert du chat temporaire',
        description:
          'Enregistre une discussion temporaire et la poursuit en toute sécurité dans un chat normal.',
      },
      es: {
        name: 'ChatGPT · Transferir chat temporal',
        description:
          'Guarda una conversación temporal y la continúa de forma segura en un chat normal.',
      },
      pt: {
        name: 'ChatGPT · Transferir chat temporário',
        description: 'Salva uma conversa temporária e continua com segurança em um chat normal.',
      },
      ru: {
        name: 'ChatGPT · Перенос временного чата',
        description: 'Сохраняет временный диалог и безопасно продолжает его в обычном чате.',
      },
      ar: {
        name: 'ChatGPT · نقل المحادثة المؤقتة',
        description: 'يحفظ محادثة مؤقتة ويتابعها بأمان في دردشة عادية.',
      },
    },
    author: 'voyager-official',
    category: 'productivity',
    license: 'GPL-3.0-or-later',
    engine: '>=1.2.0',
    tier: 'declarative',
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    contributes: {},
  },
];

/**
 * Every BUILTIN_PLUGINS entry is a native-function plugin and MUST have a
 * `registerNativeHandler(<id>, …)` call in the content script (and vice
 * versa). `verifyNativeHandlerBindings(NATIVE_BUILTIN_PLUGIN_IDS)` enforces
 * both directions after registration — adding a plugin to one side without
 * the other surfaces as a logged error instead of a dead toggle.
 */
export const NATIVE_BUILTIN_PLUGIN_IDS: readonly string[] = BUILTIN_PLUGINS.map((p) => p.id);
