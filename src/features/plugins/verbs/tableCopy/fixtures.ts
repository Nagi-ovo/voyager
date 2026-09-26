import { chatgptAdapter } from '../../sites/adapters/chatgpt';
import { deepseekAdapter } from '../../sites/adapters/deepseek';

// Synthetic fixtures based on the bundled semantic markers, not live-browser evidence.
const TABLE =
  '<table id="answer-table"><thead><tr><th>Name</th><th>Note</th><th>Empty</th></tr></thead>' +
  '<tbody><tr><td>Alpha | Beta</td><td><code>code</code><br>next</td><td></td></tr>' +
  '<tr><td>=SUM(A1:A2)</td><td>"quoted"</td><td></td></tr></tbody></table>';
const OTHER = '<table><tr><td>Do not copy</td></tr></table>';

export const TABLE_COPY_FIXTURES = [
  {
    name: 'DeepSeek',
    adapter: deepseekAdapter,
    html:
      '<main><div class="ds-message"><div class="ds-collapsible-text">' +
      OTHER +
      '</div></div>' +
      '<div class="ds-message"><div class="ds-assistant-message-main-content" id="answer">' +
      TABLE +
      '</div></div><aside>' +
      OTHER +
      '</aside></main>',
  },
  {
    name: 'ChatGPT',
    adapter: chatgptAdapter,
    html:
      '<main><section data-message-author-role="user">' +
      OTHER +
      '</section>' +
      '<section data-message-author-role="assistant"><div class="markdown" id="answer">' +
      TABLE +
      '</div></section><aside>' +
      OTHER +
      '</aside></main>',
  },
] as const;
