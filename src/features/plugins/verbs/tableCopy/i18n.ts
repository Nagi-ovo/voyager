import type { AppLanguage } from '@/utils/language';

export interface TableCopyLabels {
  markdown: string;
  tsv: string;
  busy: string;
  copied: string;
  failed: string;
  empty: string;
  unsupported: string;
  limit: string;
}

// Primitive-local copy follows builtin/chatgptTemporaryHandoff/i18n.ts.
// No shared locale keys or new context fields are required.
export const TABLE_COPY_LABELS: Record<AppLanguage, TableCopyLabels> = {
  en: {
    markdown: 'Copy Markdown',
    tsv: 'Copy TSV',
    busy: 'Copying...',
    copied: 'Copied',
    failed: 'Copy failed. Check clipboard permission and try again.',
    empty: 'This table has no cells to copy.',
    unsupported: 'Cannot copy nested tables, merged cells, multiple header rows, or uneven rows.',
    limit: 'This table exceeds the copy size limit.',
  },
  zh: {
    markdown: '复制 Markdown',
    tsv: '复制 TSV',
    busy: '正在复制...',
    copied: '已复制',
    failed: '复制失败。请检查剪贴板权限后重试。',
    empty: '此表格没有可复制的单元格。',
    unsupported: '无法复制嵌套表格、合并单元格、多行表头或列数不一致的表格。',
    limit: '此表格超过复制大小限制。',
  },
  zh_TW: {
    markdown: '複製 Markdown',
    tsv: '複製 TSV',
    busy: '正在複製...',
    copied: '已複製',
    failed: '複製失敗。請檢查剪貼簿權限後重試。',
    empty: '此表格沒有可複製的儲存格。',
    unsupported: '無法複製巢狀表格、合併儲存格、多列表頭或欄數不一致的表格。',
    limit: '此表格超過複製大小限制。',
  },
  ja: {
    markdown: 'Markdown をコピー',
    tsv: 'TSV をコピー',
    busy: 'コピー中...',
    copied: 'コピーしました',
    failed: 'コピーに失敗しました。クリップボードの権限を確認して再試行してください。',
    empty: 'コピーできるセルがありません。',
    unsupported: '入れ子の表、結合セル、複数行の見出し、列数が異なる行はコピーできません。',
    limit: '表がコピーのサイズ制限を超えています。',
  },
  ko: {
    markdown: 'Markdown 복사',
    tsv: 'TSV 복사',
    busy: '복사 중...',
    copied: '복사됨',
    failed: '복사하지 못했습니다. 클립보드 권한을 확인하고 다시 시도하세요.',
    empty: '복사할 셀이 없습니다.',
    unsupported: '중첩 표, 병합된 셀, 여러 머리글 행 또는 열 수가 다른 행은 복사할 수 없습니다.',
    limit: '표가 복사 크기 제한을 초과합니다.',
  },
  fr: {
    markdown: 'Copier en Markdown',
    tsv: 'Copier en TSV',
    busy: 'Copie...',
    copied: 'Copié',
    failed: 'Échec de la copie. Vérifiez les permissions du presse-papiers et réessayez.',
    empty: 'Ce tableau ne contient aucune cellule à copier.',
    unsupported:
      'Impossible de copier les tableaux imbriqués, les cellules fusionnées, les en-têtes multilignes ou les lignes de tailles différentes.',
    limit: 'Ce tableau dépasse la taille maximale de copie.',
  },
  es: {
    markdown: 'Copiar Markdown',
    tsv: 'Copiar TSV',
    busy: 'Copiando...',
    copied: 'Copiado',
    failed: 'No se pudo copiar. Revisa los permisos del portapapeles e inténtalo de nuevo.',
    empty: 'Esta tabla no tiene celdas para copiar.',
    unsupported:
      'No se pueden copiar tablas anidadas, celdas combinadas, varias filas de encabezado ni filas desiguales.',
    limit: 'Esta tabla supera el límite de tamaño de copia.',
  },
  pt: {
    markdown: 'Copiar Markdown',
    tsv: 'Copiar TSV',
    busy: 'Copiando...',
    copied: 'Copiado',
    failed: 'Falha ao copiar. Verifique a permissão da área de transferência e tente novamente.',
    empty: 'Esta tabela não tem células para copiar.',
    unsupported:
      'Não é possível copiar tabelas aninhadas, células mescladas, cabeçalhos com várias linhas ou linhas desiguais.',
    limit: 'Esta tabela excede o limite de tamanho da cópia.',
  },
  ru: {
    markdown: 'Копировать Markdown',
    tsv: 'Копировать TSV',
    busy: 'Копирование...',
    copied: 'Скопировано',
    failed: 'Не удалось скопировать. Проверьте доступ к буферу обмена и повторите попытку.',
    empty: 'В таблице нет ячеек для копирования.',
    unsupported:
      'Нельзя копировать вложенные таблицы, объединённые ячейки, многострочные заголовки или строки разной длины.',
    limit: 'Таблица превышает ограничение размера копирования.',
  },
  ar: {
    markdown: 'نسخ Markdown',
    tsv: 'نسخ TSV',
    busy: 'جارٍ النسخ...',
    copied: 'تم النسخ',
    failed: 'تعذر النسخ. تحقق من إذن الحافظة وحاول مرة أخرى.',
    empty: 'لا توجد خلايا لنسخها في هذا الجدول.',
    unsupported:
      'لا يمكن نسخ الجداول المتداخلة أو الخلايا المدمجة أو العناوين متعددة الصفوف أو الصفوف غير المتساوية.',
    limit: 'يتجاوز هذا الجدول الحد الأقصى لحجم النسخ.',
  },
};
