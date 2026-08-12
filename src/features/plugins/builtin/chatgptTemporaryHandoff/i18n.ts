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
}

const EN: TemporaryHandoffCopy = {
  button: 'Save & continue',
  confirmTitle: 'Continue this temporary chat?',
  confirmBody:
    'Voyager will download a Markdown backup, leave temporary mode, and place the conversation in a normal chat. Nothing will be sent automatically.',
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
};

const ZH: TemporaryHandoffCopy = {
  button: '保存并继续',
  confirmTitle: '把这个临时对话继续下去？',
  confirmBody:
    'Voyager 会下载 Markdown 备份、退出临时模式，并把对话交接到普通聊天中。不会自动发送。',
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
};

const COPIES: Record<AppLanguage, TemporaryHandoffCopy> = {
  en: EN,
  zh: ZH,
  zh_TW: {
    ...ZH,
    button: '儲存並繼續',
    confirmTitle: '要繼續這個暫時對話嗎？',
    confirmBody:
      'Voyager 會下載 Markdown 備份、離開暫時模式，並把對話交接到一般聊天中。不會自動傳送。',
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
  },
  ja: {
    ...EN,
    button: '保存して続ける',
    confirmTitle: 'この一時チャットを続けますか？',
    confirmBody:
      'Voyager は Markdown のバックアップを保存し、一時モードを終了して通常のチャットへ会話を引き継ぎます。自動送信はしません。',
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
  },
  ko: {
    ...EN,
    button: '저장하고 계속',
    confirmTitle: '이 임시 채팅을 계속할까요?',
    confirmBody:
      'Voyager가 Markdown 백업을 저장하고 임시 모드를 종료한 뒤 일반 채팅으로 대화를 이어 줍니다. 자동으로 전송하지 않습니다.',
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
  },
  fr: {
    ...EN,
    button: 'Enregistrer et continuer',
    confirmTitle: 'Continuer cette discussion temporaire ?',
    confirmBody:
      'Voyager téléchargera une sauvegarde Markdown, quittera le mode temporaire et transférera la discussion vers un chat normal. Rien ne sera envoyé automatiquement.',
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
  },
  es: {
    ...EN,
    button: 'Guardar y continuar',
    confirmTitle: '¿Continuar este chat temporal?',
    confirmBody:
      'Voyager descargará una copia Markdown, saldrá del modo temporal y pasará la conversación a un chat normal. No enviará nada automáticamente.',
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
  },
  pt: {
    ...EN,
    button: 'Salvar e continuar',
    confirmTitle: 'Continuar este chat temporário?',
    confirmBody:
      'O Voyager baixará um backup em Markdown, sairá do modo temporário e levará a conversa para um chat normal. Nada será enviado automaticamente.',
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
  },
  ru: {
    ...EN,
    button: 'Сохранить и продолжить',
    confirmTitle: 'Продолжить этот временный чат?',
    confirmBody:
      'Voyager скачает резервную копию Markdown, выйдет из временного режима и перенесёт разговор в обычный чат. Ничего не будет отправлено автоматически.',
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
  },
  ar: {
    ...EN,
    button: 'حفظ ومتابعة',
    confirmTitle: 'هل تريد متابعة هذه المحادثة المؤقتة؟',
    confirmBody:
      'سيحمّل Voyager نسخة Markdown احتياطية، ثم يغادر الوضع المؤقت وينقل المحادثة إلى دردشة عادية. لن يُرسل أي شيء تلقائيًا.',
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
  },
};

export function getTemporaryHandoffCopy(language: AppLanguage): TemporaryHandoffCopy {
  return COPIES[language] ?? EN;
}
