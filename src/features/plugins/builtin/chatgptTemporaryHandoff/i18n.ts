import type { AppLanguage } from '@/utils/language';

export interface TemporaryHandoffCopy {
  readonly button: string;
  readonly confirmTitle: string;
  readonly confirmBody: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly collecting: string;
  readonly emptyConversation: string;
  readonly notTemporary: string;
  readonly leaveFailed: string;
  readonly composerMissing: string;
  readonly deliveryFailed: string;
  readonly accountChanged: string;
  readonly ready: string;
  readonly failed: string;
  readonly handoffTitle: string;
  readonly inlineInstruction: string;
  readonly attachmentInstruction: string;
  readonly transcriptStart: string;
  readonly transcriptEnd: string;
  readonly userRole: string;
  readonly unsentDraftHeading: string;
  readonly attachmentDraftUnsupported: string;
}

const EN: TemporaryHandoffCopy = {
  button: 'Save & continue',
  confirmTitle: 'Continue this temporary chat?',
  confirmBody:
    'Voyager will download a Markdown backup, leave temporary mode, and place the conversation in a normal chat. Long conversations are uploaded as a draft attachment; no message is sent automatically.',
  confirm: 'Save & continue',
  cancel: 'Cancel',
  collecting: 'Collecting conversation…',
  emptyConversation: 'No messages were found in this temporary chat.',
  notTemporary: 'This action is only available in a temporary chat.',
  leaveFailed: 'The backup was saved, but ChatGPT did not leave temporary mode.',
  composerMissing:
    'The backup was saved. The handoff will resume when the normal-chat composer appears.',
  deliveryFailed:
    'The backup was saved, but ChatGPT did not accept the handoff. Your draft was preserved.',
  accountChanged: 'The active ChatGPT account changed, so the handoff was not inserted.',
  ready: 'Backup saved. Review the handoff, then send it when ready.',
  failed: 'Temporary chat handoff failed.',
  handoffTitle: '[Continue from a temporary chat]',
  inlineInstruction:
    'The complete temporary-chat transcript follows. Treat it as the existing context for this chat, preserve its tone, constraints and task state, and continue naturally from the last message.',
  attachmentInstruction:
    'The attached Markdown file contains the complete temporary chat. Read it first, treat it as the existing context, and continue naturally from its final message.',
  transcriptStart: '--- TRANSCRIPT START ---',
  transcriptEnd: '--- TRANSCRIPT END ---',
  userRole: 'User',
  unsentDraftHeading: 'Unsent draft',
  attachmentDraftUnsupported:
    'This draft has an attached file or image. Remove it before continuing so ChatGPT does not discard it when temporary mode closes.',
};

const ZH: TemporaryHandoffCopy = {
  button: '保存并继续',
  confirmTitle: '把这个临时对话继续下去？',
  confirmBody:
    'Voyager 会下载 Markdown 备份、退出临时模式，并把对话交接到普通聊天中。较长对话会上传为附件草稿；不会自动发送消息。',
  confirm: '保存并继续',
  cancel: '取消',
  collecting: '正在收集对话…',
  emptyConversation: '这个临时对话里没有找到消息。',
  notTemporary: '该操作只在临时对话中可用。',
  leaveFailed: '备份已保存，但 ChatGPT 没有退出临时模式。',
  composerMissing: '备份已保存；普通聊天输入框出现后会继续交接。',
  deliveryFailed: '备份已保存，但 ChatGPT 没有接受交接内容；原有草稿未被破坏。',
  accountChanged: '当前 ChatGPT 账号发生了变化，因此没有写入交接内容。',
  ready: '备份已保存。请检查交接内容，确认后再发送。',
  failed: '临时对话交接失败。',
  handoffTitle: '[从临时对话继续]',
  inlineInstruction:
    '下面是刚才临时对话的完整记录。请把它当作当前对话的既有上下文，保持原来的语气、约束和任务状态，从最后一条消息自然继续。',
  attachmentInstruction:
    '已附上刚才临时对话的 Markdown 记录。请先完整读取附件，把它当作当前对话的既有上下文，再从最后一条消息自然继续。',
  transcriptStart: '--- 对话记录开始 ---',
  transcriptEnd: '--- 对话记录结束 ---',
  userRole: '用户',
  unsentDraftHeading: '未发送草稿',
  attachmentDraftUnsupported:
    '当前草稿中有附件或图片。请先移除再继续，避免退出临时模式时被 ChatGPT 丢弃。',
};

const COPIES: Record<AppLanguage, TemporaryHandoffCopy> = {
  en: EN,
  zh: ZH,
  zh_TW: {
    ...ZH,
    button: '儲存並繼續',
    confirmTitle: '要繼續這個暫時對話嗎？',
    confirmBody:
      'Voyager 會下載 Markdown 備份、離開暫時模式，並把對話交接到一般聊天中。較長對話會上傳為附件草稿；不會自動傳送訊息。',
    confirm: '儲存並繼續',
    cancel: '取消',
    collecting: '正在收集對話…',
    emptyConversation: '這個暫時對話中找不到訊息。',
    notTemporary: '此操作只適用於暫時對話。',
    leaveFailed: '備份已儲存，但 ChatGPT 未離開暫時模式。',
    composerMissing: '備份已儲存；一般聊天輸入框出現後會繼續交接。',
    deliveryFailed: '備份已儲存，但 ChatGPT 未接受交接內容；原有草稿已保留。',
    accountChanged: '目前的 ChatGPT 帳號已變更，因此未插入交接內容。',
    ready: '備份已儲存。請檢查交接內容，確認後再傳送。',
    failed: '暫時對話交接失敗。',
    handoffTitle: '[從暫時對話繼續]',
    inlineInstruction:
      '以下是剛才暫時對話的完整記錄。請把它視為目前對話的既有上下文，保留原本的語氣、限制與任務狀態，並從最後一則訊息自然接續。',
    attachmentInstruction:
      '已附上剛才暫時對話的 Markdown 記錄。請先完整閱讀附件，把它視為目前對話的既有上下文，再從最後一則訊息自然接續。',
    transcriptStart: '--- 對話記錄開始 ---',
    transcriptEnd: '--- 對話記錄結束 ---',
    userRole: '使用者',
    unsentDraftHeading: '未傳送草稿',
    attachmentDraftUnsupported:
      '目前草稿中有附件或圖片。請先移除再繼續，以免離開暫時模式時被 ChatGPT 捨棄。',
  },
  ja: {
    ...EN,
    button: '保存して続ける',
    confirmTitle: 'この一時チャットを続けますか？',
    confirmBody:
      'Voyager は Markdown のバックアップを保存し、一時モードを終了して通常のチャットへ会話を引き継ぎます。長い会話は下書きの添付ファイルとしてアップロードされ、メッセージは自動送信されません。',
    confirm: '保存して続ける',
    cancel: 'キャンセル',
    collecting: '会話を収集中…',
    emptyConversation: 'この一時チャットにメッセージがありません。',
    notTemporary: 'この操作は一時チャットでのみ利用できます。',
    leaveFailed: 'バックアップは保存されましたが、一時モードを終了できませんでした。',
    composerMissing: 'バックアップを保存しました。通常チャットの入力欄が表示されたら再開します。',
    deliveryFailed:
      'バックアップは保存されましたが、引き継ぎに失敗しました。下書きは保持されています。',
    accountChanged: 'ChatGPT アカウントが変更されたため、引き継ぎ内容を挿入しませんでした。',
    ready: 'バックアップを保存しました。内容を確認してから送信してください。',
    failed: '一時チャットの引き継ぎに失敗しました。',
    handoffTitle: '[一時チャットから続ける]',
    inlineInstruction:
      '以下は先ほどの一時チャットの完全な記録です。現在のチャットの既存コンテキストとして扱い、元の口調、制約、タスクの状態を保ったまま、最後のメッセージから自然に続けてください。',
    attachmentInstruction:
      '先ほどの一時チャットの Markdown 記録を添付しました。まず添付ファイルをすべて読み、現在のチャットの既存コンテキストとして扱って、最後のメッセージから自然に続けてください。',
    transcriptStart: '--- 会話記録 開始 ---',
    transcriptEnd: '--- 会話記録 終了 ---',
    userRole: 'ユーザー',
    unsentDraftHeading: '未送信の下書き',
    attachmentDraftUnsupported:
      'この下書きには添付ファイルまたは画像があります。一時モードを終了したときに失われないよう、続行する前に添付を削除してください。',
  },
  ko: {
    ...EN,
    button: '저장하고 계속',
    confirmTitle: '이 임시 채팅을 계속할까요?',
    confirmBody:
      'Voyager가 Markdown 백업을 저장하고 임시 모드를 종료한 뒤 일반 채팅으로 대화를 이어 줍니다. 긴 대화는 초안 첨부 파일로 업로드되며 메시지는 자동 전송되지 않습니다.',
    confirm: '저장하고 계속',
    cancel: '취소',
    collecting: '대화 수집 중…',
    emptyConversation: '이 임시 채팅에서 메시지를 찾지 못했습니다.',
    notTemporary: '이 작업은 임시 채팅에서만 사용할 수 있습니다.',
    leaveFailed: '백업은 저장했지만 ChatGPT가 임시 모드를 종료하지 못했습니다.',
    composerMissing: '백업을 저장했습니다. 일반 채팅 입력창이 나타나면 이어서 전달합니다.',
    deliveryFailed: '백업은 저장했지만 전달하지 못했습니다. 기존 초안은 보존되었습니다.',
    accountChanged: 'ChatGPT 계정이 변경되어 전달 내용을 삽입하지 않았습니다.',
    ready: '백업을 저장했습니다. 내용을 확인한 뒤 준비되면 전송하세요.',
    failed: '임시 채팅 전달에 실패했습니다.',
    handoffTitle: '[임시 채팅에서 계속]',
    inlineInstruction:
      '아래는 방금 전 임시 채팅의 전체 기록입니다. 현재 채팅의 기존 맥락으로 취급하고 원래의 어조, 제약 조건, 작업 상태를 유지한 채 마지막 메시지부터 자연스럽게 이어 주세요.',
    attachmentInstruction:
      '방금 전 임시 채팅의 Markdown 기록을 첨부했습니다. 먼저 첨부 파일을 모두 읽고 현재 채팅의 기존 맥락으로 취급한 다음 마지막 메시지부터 자연스럽게 이어 주세요.',
    transcriptStart: '--- 대화 기록 시작 ---',
    transcriptEnd: '--- 대화 기록 끝 ---',
    userRole: '사용자',
    unsentDraftHeading: '보내지 않은 초안',
    attachmentDraftUnsupported:
      '현재 초안에 첨부 파일이나 이미지가 있습니다. 임시 모드를 종료할 때 ChatGPT가 이를 버리지 않도록 계속하기 전에 첨부 항목을 제거하세요.',
  },
  fr: {
    ...EN,
    button: 'Enregistrer et continuer',
    confirmTitle: 'Continuer cette discussion temporaire ?',
    confirmBody:
      'Voyager téléchargera une sauvegarde Markdown, quittera le mode temporaire et transférera la discussion vers un chat normal. Les longues discussions seront téléversées comme pièce jointe au brouillon ; aucun message ne sera envoyé automatiquement.',
    confirm: 'Enregistrer et continuer',
    cancel: 'Annuler',
    collecting: 'Collecte de la discussion…',
    emptyConversation: 'Aucun message trouvé dans cette discussion temporaire.',
    notTemporary: "Cette action n'est disponible que dans une discussion temporaire.",
    leaveFailed: "La sauvegarde est enregistrée, mais ChatGPT n'a pas quitté le mode temporaire.",
    composerMissing:
      "La sauvegarde est enregistrée. Le transfert reprendra lorsque l'éditeur normal apparaîtra.",
    deliveryFailed:
      'La sauvegarde est enregistrée, mais le transfert a échoué. Votre brouillon est intact.',
    accountChanged: "Le compte ChatGPT actif a changé ; le transfert n'a pas été inséré.",
    ready: "Sauvegarde enregistrée. Vérifiez le transfert avant de l'envoyer.",
    failed: 'Échec du transfert de la discussion temporaire.',
    handoffTitle: '[Continuer depuis une discussion temporaire]',
    inlineInstruction:
      'Voici la transcription complète de la discussion temporaire. Considérez-la comme le contexte existant de cette discussion, conservez son ton, ses contraintes et l’état de la tâche, puis reprenez naturellement après le dernier message.',
    attachmentInstruction:
      'Le fichier Markdown joint contient la discussion temporaire complète. Lisez-le d’abord, considérez-le comme le contexte existant, puis reprenez naturellement après son dernier message.',
    transcriptStart: '--- DÉBUT DE LA TRANSCRIPTION ---',
    transcriptEnd: '--- FIN DE LA TRANSCRIPTION ---',
    userRole: 'Utilisateur',
    unsentDraftHeading: 'Brouillon non envoyé',
    attachmentDraftUnsupported:
      'Ce brouillon contient un fichier ou une image en pièce jointe. Retirez-le avant de continuer afin que ChatGPT ne le supprime pas en quittant le mode temporaire.',
  },
  es: {
    ...EN,
    button: 'Guardar y continuar',
    confirmTitle: '¿Continuar este chat temporal?',
    confirmBody:
      'Voyager descargará una copia Markdown, saldrá del modo temporal y pasará la conversación a un chat normal. Las conversaciones largas se subirán como archivo adjunto del borrador; no se enviará ningún mensaje automáticamente.',
    confirm: 'Guardar y continuar',
    cancel: 'Cancelar',
    collecting: 'Recopilando conversación…',
    emptyConversation: 'No se encontraron mensajes en este chat temporal.',
    notTemporary: 'Esta acción solo está disponible en un chat temporal.',
    leaveFailed: 'La copia se guardó, pero ChatGPT no salió del modo temporal.',
    composerMissing:
      'La copia se guardó. La transferencia continuará cuando aparezca el editor normal.',
    deliveryFailed: 'La copia se guardó, pero falló la transferencia. Tu borrador se conservó.',
    accountChanged: 'La cuenta activa de ChatGPT cambió; no se insertó la transferencia.',
    ready: 'Copia guardada. Revisa la transferencia antes de enviarla.',
    failed: 'Falló la transferencia del chat temporal.',
    handoffTitle: '[Continuar desde un chat temporal]',
    inlineInstruction:
      'A continuación aparece la transcripción completa del chat temporal. Trátala como el contexto existente de este chat, conserva su tono, sus restricciones y el estado de la tarea, y continúa de forma natural desde el último mensaje.',
    attachmentInstruction:
      'El archivo Markdown adjunto contiene el chat temporal completo. Léelo primero, trátalo como el contexto existente y continúa de forma natural desde su último mensaje.',
    transcriptStart: '--- INICIO DE LA TRANSCRIPCIÓN ---',
    transcriptEnd: '--- FIN DE LA TRANSCRIPCIÓN ---',
    userRole: 'Usuario',
    unsentDraftHeading: 'Borrador sin enviar',
    attachmentDraftUnsupported:
      'Este borrador tiene un archivo o una imagen adjuntos. Elimínalos antes de continuar para que ChatGPT no los descarte al cerrar el modo temporal.',
  },
  pt: {
    ...EN,
    button: 'Salvar e continuar',
    confirmTitle: 'Continuar este chat temporário?',
    confirmBody:
      'O Voyager baixará um backup em Markdown, sairá do modo temporário e levará a conversa para um chat normal. Conversas longas serão enviadas como anexo do rascunho; nenhuma mensagem será enviada automaticamente.',
    confirm: 'Salvar e continuar',
    cancel: 'Cancelar',
    collecting: 'Coletando conversa…',
    emptyConversation: 'Nenhuma mensagem foi encontrada neste chat temporário.',
    notTemporary: 'Esta ação só está disponível em um chat temporário.',
    leaveFailed: 'O backup foi salvo, mas o ChatGPT não saiu do modo temporário.',
    composerMissing:
      'O backup foi salvo. A transferência continuará quando o editor normal aparecer.',
    deliveryFailed: 'O backup foi salvo, mas a transferência falhou. Seu rascunho foi preservado.',
    accountChanged: 'A conta ativa do ChatGPT mudou; a transferência não foi inserida.',
    ready: 'Backup salvo. Revise a transferência antes de enviar.',
    failed: 'Falha ao transferir o chat temporário.',
    handoffTitle: '[Continuar de um chat temporário]',
    inlineInstruction:
      'A seguir está a transcrição completa do chat temporário. Trate-a como o contexto existente deste chat, preserve o tom, as restrições e o estado da tarefa e continue naturalmente a partir da última mensagem.',
    attachmentInstruction:
      'O arquivo Markdown anexado contém todo o chat temporário. Leia-o primeiro, trate-o como o contexto existente e continue naturalmente a partir da última mensagem.',
    transcriptStart: '--- INÍCIO DA TRANSCRIÇÃO ---',
    transcriptEnd: '--- FIM DA TRANSCRIÇÃO ---',
    userRole: 'Usuário',
    unsentDraftHeading: 'Rascunho não enviado',
    attachmentDraftUnsupported:
      'Este rascunho tem um arquivo ou uma imagem anexados. Remova-os antes de continuar para que o ChatGPT não os descarte ao sair do modo temporário.',
  },
  ru: {
    ...EN,
    button: 'Сохранить и продолжить',
    confirmTitle: 'Продолжить этот временный чат?',
    confirmBody:
      'Voyager скачает резервную копию Markdown, выйдет из временного режима и перенесёт разговор в обычный чат. Длинные разговоры будут загружены как вложение черновика; сообщения не отправляются автоматически.',
    confirm: 'Сохранить и продолжить',
    cancel: 'Отмена',
    collecting: 'Сбор диалога…',
    emptyConversation: 'Во временном чате не найдено сообщений.',
    notTemporary: 'Это действие доступно только во временном чате.',
    leaveFailed: 'Копия сохранена, но ChatGPT не вышел из временного режима.',
    composerMissing: 'Копия сохранена. Перенос продолжится после появления обычного поля ввода.',
    deliveryFailed: 'Копия сохранена, но перенос не удался. Черновик сохранён.',
    accountChanged: 'Активная учётная запись ChatGPT изменилась; перенос не вставлен.',
    ready: 'Копия сохранена. Проверьте перенос перед отправкой.',
    failed: 'Не удалось перенести временный чат.',
    handoffTitle: '[Продолжить из временного чата]',
    inlineInstruction:
      'Ниже приведена полная запись временного чата. Считайте её существующим контекстом этого чата, сохраните исходный тон, ограничения и состояние задачи и естественно продолжите с последнего сообщения.',
    attachmentInstruction:
      'Во вложенном файле Markdown находится полная запись временного чата. Сначала прочитайте её целиком, считайте существующим контекстом и естественно продолжите с последнего сообщения.',
    transcriptStart: '--- НАЧАЛО ЗАПИСИ ---',
    transcriptEnd: '--- КОНЕЦ ЗАПИСИ ---',
    userRole: 'Пользователь',
    unsentDraftHeading: 'Неотправленный черновик',
    attachmentDraftUnsupported:
      'К этому черновику прикреплён файл или изображение. Удалите вложение перед продолжением, чтобы ChatGPT не отбросил его при выходе из временного режима.',
  },
  ar: {
    ...EN,
    button: 'حفظ ومتابعة',
    confirmTitle: 'هل تريد متابعة هذه المحادثة المؤقتة؟',
    confirmBody:
      'سيحمّل Voyager نسخة Markdown احتياطية، ثم يغادر الوضع المؤقت وينقل المحادثة إلى دردشة عادية. تُرفع المحادثات الطويلة كمرفق في المسودة، ولن تُرسل أي رسالة تلقائيًا.',
    confirm: 'حفظ ومتابعة',
    cancel: 'إلغاء',
    collecting: 'جارٍ جمع المحادثة…',
    emptyConversation: 'لم يتم العثور على رسائل في هذه المحادثة المؤقتة.',
    notTemporary: 'هذا الإجراء متاح فقط في محادثة مؤقتة.',
    leaveFailed: 'تم حفظ النسخة الاحتياطية، لكن ChatGPT لم يغادر الوضع المؤقت.',
    composerMissing: 'تم حفظ النسخة. سيُستأنف النقل عند ظهور محرر المحادثة العادية.',
    deliveryFailed: 'تم حفظ النسخة، لكن النقل فشل. تم الحفاظ على مسودتك.',
    accountChanged: 'تغيّر حساب ChatGPT النشط، لذلك لم يُدرج محتوى النقل.',
    ready: 'تم حفظ النسخة. راجع محتوى النقل قبل الإرسال.',
    failed: 'فشل نقل المحادثة المؤقتة.',
    handoffTitle: '[المتابعة من محادثة مؤقتة]',
    inlineInstruction:
      'فيما يلي السجل الكامل للمحادثة المؤقتة. تعامل معه بوصفه السياق السابق لهذه المحادثة، وحافظ على النبرة والقيود وحالة المهمة، ثم تابع بصورة طبيعية من الرسالة الأخيرة.',
    attachmentInstruction:
      'يحتوي ملف Markdown المرفق على المحادثة المؤقتة كاملة. اقرأه أولًا، وتعامل معه بوصفه السياق السابق، ثم تابع بصورة طبيعية من رسالته الأخيرة.',
    transcriptStart: '--- بداية سجل المحادثة ---',
    transcriptEnd: '--- نهاية سجل المحادثة ---',
    userRole: 'المستخدم',
    unsentDraftHeading: 'مسودة غير مرسلة',
    attachmentDraftUnsupported:
      'تحتوي هذه المسودة على ملف أو صورة مرفقة. أزل المرفق قبل المتابعة حتى لا يتجاهله ChatGPT عند إغلاق الوضع المؤقت.',
  },
};

export function getTemporaryHandoffCopy(language: AppLanguage): TemporaryHandoffCopy {
  return COPIES[language] ?? EN;
}
