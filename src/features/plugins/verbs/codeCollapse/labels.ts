const labels = {
  en: ['Expand code', 'Collapse code', 'Expand all code', 'Collapse all code', 'Code folding'],
  zh: ['展开代码', '折叠代码', '展开全部代码', '折叠全部代码', '代码折叠'],
  zh_TW: ['展開程式碼', '摺疊程式碼', '展開全部程式碼', '摺疊全部程式碼', '程式碼摺疊'],
  ja: [
    'コードを展開',
    'コードを折りたたむ',
    'すべてのコードを展開',
    'すべてのコードを折りたたむ',
    'コードの折りたたみ',
  ],
  ko: ['코드 펼치기', '코드 접기', '모든 코드 펼치기', '모든 코드 접기', '코드 접기'],
  fr: [
    'Déplier le code',
    'Replier le code',
    'Déplier tout le code',
    'Replier tout le code',
    'Repli du code',
  ],
  es: [
    'Expandir código',
    'Contraer código',
    'Expandir todo el código',
    'Contraer todo el código',
    'Plegado de código',
  ],
  pt: [
    'Expandir código',
    'Recolher código',
    'Expandir todo o código',
    'Recolher todo o código',
    'Recolhimento de código',
  ],
  ru: [
    'Развернуть код',
    'Свернуть код',
    'Развернуть весь код',
    'Свернуть весь код',
    'Сворачивание кода',
  ],
  ar: ['توسيع الكود', 'طي الكود', 'توسيع كل الأكواد', 'طي كل الأكواد', 'طي الأكواد'],
} as const;

export function codeCollapseLabels(language: string) {
  const normalized = language.toLowerCase().replaceAll('_', '-');
  const locale = /^zh-(tw|hk|mo|hant)(-|$)/.test(normalized) ? 'zh_TW' : normalized.split('-')[0];
  const values = labels[locale as keyof typeof labels] ?? labels.en;
  return {
    expand: values[0],
    collapse: values[1],
    expandAll: values[2],
    collapseAll: values[3],
    toolbar: values[4],
  };
}
