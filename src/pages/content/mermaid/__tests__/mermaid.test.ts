import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initMermaidForTest,
  _openFullscreenForTest,
  _renderMermaidForTest,
  _resetMermaidLoader,
  isGenericLanguageLabel,
  isMermaidCode,
  loadMermaid,
  normalizeMermaidCode,
  normalizeWhitespace,
  resolveMermaidTheme,
} from '../index';

// Mock the dynamic import of 'mermaid'
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

describe('Mermaid dynamic loading', () => {
  beforeEach(() => {
    _resetMermaidLoader();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    document.body.className = '';
  });

  describe('loadMermaid', () => {
    it('should load mermaid module successfully', async () => {
      const mermaid = await loadMermaid();
      expect(mermaid).not.toBeNull();
      expect(mermaid).toHaveProperty('initialize');
      expect(mermaid).toHaveProperty('render');
    });

    it('should cache the loaded instance on subsequent calls', async () => {
      const first = await loadMermaid();
      const second = await loadMermaid();
      expect(first).toBe(second);
    });

    it('should return cached instance without re-importing', async () => {
      // First call loads and caches
      const first = await loadMermaid();
      expect(first).not.toBeNull();

      // Second call returns cached instance immediately (no new import)
      const second = await loadMermaid();
      expect(second).toBe(first);
    });
  });

  describe('resolveMermaidTheme', () => {
    it('prefers an explicit Gemini light host over generic dark markers', () => {
      const page = document.implementation.createHTMLDocument();
      const themeHost = page.createElement('div');
      themeHost.className = 'theme-host light-theme';
      page.body.append(themeHost);
      page.body.classList.add('dark-theme');
      page.documentElement.classList.add('dark');
      page.body.dataset.theme = 'dark';

      expect(resolveMermaidTheme(page, true)).toBe('default');
    });

    it('prefers an explicit Gemini dark host over generic light markers', () => {
      const page = document.implementation.createHTMLDocument();
      const themeHost = page.createElement('div');
      themeHost.className = 'theme-host dark-theme';
      page.body.append(themeHost);
      page.body.classList.add('light-theme');
      page.documentElement.classList.add('light');
      page.body.dataset.theme = 'light';

      expect(resolveMermaidTheme(page, false)).toBe('dark');
    });

    it('uses generic page markers when Gemini exposes no theme host', () => {
      const darkPage = document.implementation.createHTMLDocument();
      darkPage.body.dataset.theme = 'dark';
      expect(resolveMermaidTheme(darkPage, false)).toBe('dark');

      const lightPage = document.implementation.createHTMLDocument();
      lightPage.body.dataset.theme = 'light';
      expect(resolveMermaidTheme(lightPage, true)).toBe('default');
    });

    it('falls back to a dark system preference when Gemini exposes no theme', () => {
      const page = document.implementation.createHTMLDocument();

      expect(resolveMermaidTheme(page, true)).toBe('dark');
    });

    it('falls back to the default theme when Gemini exposes no theme and the system is light', () => {
      const page = document.implementation.createHTMLDocument();

      expect(resolveMermaidTheme(page, false)).toBe('default');
    });
  });

  describe('fullscreen lifecycle', () => {
    it('removes document listeners for every close path', () => {
      vi.useFakeTimers();
      const removeSpy = vi.spyOn(document, 'removeEventListener');

      _openFullscreenForTest('<svg width="100" height="100"><path d="M0 0" /></svg>');
      document
        .querySelector<HTMLButtonElement>('.gv-mermaid-modal-toolbar button:last-child')!
        .click();

      expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));

      vi.runAllTimers();
      expect(document.querySelector('.gv-mermaid-modal')).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('rendered diagram theme marker', () => {
    const setPageTheme = (theme: 'dark' | 'light') => {
      document.body.className = theme === 'dark' ? 'dark-theme' : '';
    };

    const initializeTheme = async (theme: 'dark' | 'light') => {
      setPageTheme(theme);
      await _initMermaidForTest();

      const mermaid = await loadMermaid();
      expect(mermaid?.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: theme === 'dark' ? 'dark' : 'default' }),
      );
    };

    const renderDiagram = async (
      failLightExport = false,
      source = 'flowchart TD\nA --> B\nB --> C',
    ): Promise<HTMLElement | null> => {
      const host = document.createElement('code-block');
      const code = document.createElement('code');
      host.appendChild(code);
      document.body.appendChild(host);

      const mermaid = await loadMermaid();
      (mermaid?.render as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, source: string) => {
          if (source.endsWith('%%{init: {"theme":"default"}}%%')) {
            if (failLightExport) throw new Error('light export failed');
            return { svg: '<svg data-export-theme="light" viewBox="0 0 120 80"></svg>' };
          }
          return '<svg data-page-theme="active" viewBox="0 0 120 80"></svg>';
        },
      );

      await _renderMermaidForTest(code, source);
      return host.parentElement;
    };

    const renderIntoTheme = async (
      initialTheme: 'dark' | 'light',
      renderTheme: 'dark' | 'light' = initialTheme,
    ): Promise<HTMLElement | null> => {
      await initializeTheme(initialTheme);
      setPageTheme(renderTheme);
      return renderDiagram();
    };

    it('marks rendered Mermaid wrappers with the active dark theme', async () => {
      const wrapper = await renderIntoTheme('dark');

      expect(wrapper?.dataset.gvMermaidTheme).toBe('dark');
      expect(
        wrapper
          ?.querySelector<HTMLTemplateElement>('template.gv-mermaid-light-export')
          ?.content.querySelector('svg')
          ?.getAttribute('data-export-theme'),
      ).toBe('light');
      const mermaid = await loadMermaid();
      const renderMock = mermaid?.render as unknown as ReturnType<typeof vi.fn>;
      expect(renderMock).toHaveBeenCalledTimes(2);
      expect(renderMock.mock.calls[1][1]).toBe(
        'flowchart TD\nA --> B\nB --> C\n%%{init: {"theme":"default"}}%%',
      );
    });

    it('keeps existing frontmatter before the cross-version light theme directive', async () => {
      await initializeTheme('dark');
      const mermaid = await loadMermaid();
      const renderMock = mermaid?.render as unknown as ReturnType<typeof vi.fn>;
      const source = `---
title: Existing metadata
config:
  theme: dark
---
flowchart TD
A --> B
B --> C`;

      await renderDiagram(false, source);

      expect(renderMock.mock.calls[1][1]).toBe(`${source}\n%%{init: {"theme":"default"}}%%`);
    });

    it('marks rendered Mermaid wrappers with the active light theme', async () => {
      const wrapper = await renderIntoTheme('light');

      expect(wrapper?.dataset.gvMermaidTheme).toBe('light');
      expect(wrapper?.querySelector('template.gv-mermaid-light-export')).toBeNull();
    });

    it('keeps the page diagram when light export rendering fails', async () => {
      await initializeTheme('dark');

      const wrapper = await renderDiagram(true);

      expect(wrapper?.querySelector('.gv-mermaid-diagram svg')).toBeTruthy();
      expect(wrapper?.querySelector('template.gv-mermaid-light-export')).toBeNull();
    });

    it('keeps the dark marker after the page switches to light mode', async () => {
      const wrapper = await renderIntoTheme('dark', 'light');

      expect(wrapper?.dataset.gvMermaidTheme).toBe('dark');
    });

    it('keeps the light marker after the page switches to dark mode', async () => {
      const wrapper = await renderIntoTheme('light', 'dark');

      expect(wrapper?.dataset.gvMermaidTheme).toBe('light');
    });

    it('does not retain a reset Mermaid theme after reinitialization', async () => {
      await initializeTheme('dark');
      _resetMermaidLoader();

      const wrapperAfterReset = await renderDiagram();
      expect(wrapperAfterReset?.dataset.gvMermaidTheme).toBeUndefined();

      await initializeTheme('light');
      setPageTheme('dark');
      const wrapperAfterReinitialization = await renderDiagram();

      expect(wrapperAfterReinitialization?.dataset.gvMermaidTheme).toBe('light');
    });

    it('does not write a marker when Mermaid has not initialized', async () => {
      setPageTheme('dark');

      const wrapper = await renderDiagram();

      expect(wrapper?.dataset.gvMermaidTheme).toBeUndefined();
    });

    it('updates the marker when Mermaid initializes again without a reset', async () => {
      await initializeTheme('dark');
      await initializeTheme('light');
      setPageTheme('dark');

      const wrapper = await renderDiagram();

      expect(wrapper?.dataset.gvMermaidTheme).toBe('light');
    });
  });

  describe('isMermaidCode', () => {
    it('should detect flowchart syntax', () => {
      const code = `flowchart TD
        A[Start] --> B{Is it working?}
        B -- Yes --> C[Great!]
        B -- No --> D[Fix it]
        D --> B`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect graph syntax', () => {
      const code = `graph LR
        A[Start] --> B[Process]
        B --> C[End]
        C --> D[Done]`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect sequenceDiagram syntax', () => {
      const code = `sequenceDiagram
        participant Alice
        participant Bob
        Alice->>Bob: Hello Bob
        Bob-->>Alice: Hi Alice`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect classDiagram syntax', () => {
      const code = `classDiagram
        class Animal {
          +String name
          +makeSound()
        }
        Animal <|-- Duck
        Animal <|-- Fish`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect erDiagram syntax', () => {
      const code = `erDiagram
        CUSTOMER ||--o{ ORDER : places
        ORDER ||--|{ LINE-ITEM : contains
        CUSTOMER }|..|{ DELIVERY-ADDRESS : uses`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect gantt syntax', () => {
      const code = `gantt
        title A Gantt Diagram
        dateFormat  YYYY-MM-DD
        section Section
        A task           :a1, 2024-01-01, 30d`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect pie chart syntax', () => {
      const code = `pie title Pets adopted by volunteers
        "Dogs" : 386
        "Cats" : 85
        "Rats" : 15
        "Others" : 35`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect gitGraph syntax', () => {
      const code = `gitGraph
        commit
        branch develop
        checkout develop
        commit
        checkout main
        merge develop`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect mermaid comment prefix (%%)', () => {
      const code = `%% This is a mermaid diagram
        graph TD
        A --> B
        B --> C`;
      expect(isMermaidCode(code)).toBe(true);
    });

    // C4 diagrams
    it('should detect C4Context syntax', () => {
      const code = `C4Context
        title System Context diagram
        Person(customerA, "Customer A")
        System(systemA, "System A")
        Rel(customerA, systemA, "Uses")`;
      expect(isMermaidCode(code)).toBe(true);
    });

    // New v11 diagram types (both -beta and non-beta forms)
    it('should detect xychart-beta syntax', () => {
      const code = `xychart-beta
        title "Sales Revenue"
        x-axis [jan, feb, mar, apr]
        y-axis "Revenue (in $)" 4000 --> 11000
        bar [5000, 6000, 7500, 8200]`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect xychart syntax (without -beta)', () => {
      const code = `xychart
        title "Sales Revenue"
        x-axis [jan, feb, mar, apr]
        y-axis "Revenue (in $)" 4000 --> 11000
        bar [5000, 6000, 7500, 8200]`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect block-beta syntax', () => {
      const code = `block-beta
        columns 3
        a["Block A"] b["Block B"] c["Block C"]
        d["Block D"]:3
        e["Block E"] f["Block F"]`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect block syntax (without -beta)', () => {
      const code = `block
        columns 3
        a["Block A"] b["Block B"] c["Block C"]
        d["Block D"]:3
        e["Block E"] f["Block F"]`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect packet-beta syntax', () => {
      const code = `packet-beta
        title TCP Header
        0-15: "Source Port"
        16-31: "Destination Port"
        32-63: "Sequence Number"`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect packet syntax (without -beta)', () => {
      const code = `packet
        title TCP Header
        0-15: "Source Port"
        16-31: "Destination Port"
        32-63: "Sequence Number"`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect architecture syntax', () => {
      const code = `architecture
        group api(cloud)[API]
        service db(database)[Database]
        service web(server)[Web Server]
        db:L -- R:web`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect kanban syntax', () => {
      const code = `kanban
        Todo
          id1[Task 1]
          id2[Task 2]
        "In Progress"
          id3[Task 3]`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect radar-beta syntax', () => {
      const code = `radar-beta
        title Skills Assessment
        axis1 "JavaScript"
        axis2 "TypeScript"
        axis3 "React"
        curve a: 5, 4, 3`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect treemap syntax', () => {
      const code = `treemap
        root("Project")
          src("Source")
            core("Core")
            features("Features")
          tests("Tests")`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect sankey syntax (without -beta)', () => {
      const code = `sankey
        Agricultural "ichael",Fossil fuels,17.5
        Biofuel imports,Liquid,35.8
        Biomass imports,Solid,15.5
        Coal imports,Coal,12.3`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should detect requirement syntax (without Diagram suffix)', () => {
      const code = `requirement
        functionalRequirement test_req {
          id: 1
          text: "The system shall do something"
          risk: high
        }`;
      expect(isMermaidCode(code)).toBe(true);
    });

    it('should reject code shorter than 50 chars', () => {
      expect(isMermaidCode('graph TD\n  A --> B')).toBe(false);
    });

    it('should reject code with fewer than 3 non-empty lines', () => {
      const code = `flowchart TD
        A[Start] --> B[End]`;
      expect(isMermaidCode(code)).toBe(false);
    });

    it('should reject code with incomplete endings', () => {
      const code = `flowchart TD
        A[Start] --> B{Decision}
        B -- Yes --> C[Process]
        C -->`;
      expect(isMermaidCode(code)).toBe(false);
    });

    it('should reject non-mermaid code', () => {
      const code = `function hello() {
        console.log("Hello World");
        return true;
        // some more code here to pass length check
      }`;
      expect(isMermaidCode(code)).toBe(false);
    });

    it('should be case-insensitive for keywords', () => {
      const code = `FLOWCHART TD
        A[Start] --> B[Process]
        B --> C[End]
        C --> D[Done]`;
      expect(isMermaidCode(code)).toBe(true);
    });
  });

  describe('normalizeWhitespace', () => {
    it('should replace non-breaking spaces with standard spaces', () => {
      const input = 'graph\u00A0TD\u00A0A-->B';
      expect(normalizeWhitespace(input)).toBe('graph TD A-->B');
    });

    it('should replace em spaces', () => {
      const input = 'graph\u2003TD';
      expect(normalizeWhitespace(input)).toBe('graph TD');
    });

    it('should replace en spaces', () => {
      const input = 'graph\u2002TD';
      expect(normalizeWhitespace(input)).toBe('graph TD');
    });

    it('should replace thin spaces', () => {
      const input = 'graph\u2009TD';
      expect(normalizeWhitespace(input)).toBe('graph TD');
    });

    it('should replace ideographic (CJK full-width) spaces', () => {
      const input = 'graph\u3000TD';
      expect(normalizeWhitespace(input)).toBe('graph TD');
    });

    it('should remove zero-width spaces', () => {
      const input = 'graph\u200BTD';
      expect(normalizeWhitespace(input)).toBe('graphTD');
    });

    it('should remove zero-width non-joiner', () => {
      const input = 'graph\u200CTD';
      expect(normalizeWhitespace(input)).toBe('graphTD');
    });

    it('should remove zero-width joiner', () => {
      const input = 'graph\u200DTD';
      expect(normalizeWhitespace(input)).toBe('graphTD');
    });

    it('should remove BOM character', () => {
      const input = '\uFEFFgraph TD';
      expect(normalizeWhitespace(input)).toBe('graph TD');
    });

    it('should handle mixed special whitespace', () => {
      const input = 'graph\u00A0TD\u200B\u2003A\u2009-->\u3000B';
      expect(normalizeWhitespace(input)).toBe('graph TD A --> B');
    });

    it('should leave standard whitespace unchanged', () => {
      const input = 'graph TD\n  A --> B\n  B --> C';
      expect(normalizeWhitespace(input)).toBe('graph TD\n  A --> B\n  B --> C');
    });
  });

  describe('normalizeMermaidCode', () => {
    it('moves a trailing comment after linkStyle onto its own line', () => {
      const input = `graph TD
        A --> B
        linkStyle 0 stroke:#FF5722,stroke-width:3px; %% emphasize the edge`;

      expect(normalizeMermaidCode(input)).toBe(`graph TD
        A --> B
        linkStyle 0 stroke:#FF5722,stroke-width:3px;
        %% emphasize the edge`);
    });

    it('handles trailing comments on other style directives', () => {
      const input = `graph TD
        classDef result fill:#C8E6C9; %% result style
        class A result; %% apply result style`;

      expect(normalizeMermaidCode(input)).toBe(`graph TD
        classDef result fill:#C8E6C9;
        %% result style
        class A result;
        %% apply result style`);
    });

    it('leaves standalone comments and diagram text unchanged', () => {
      const input = `graph TD
        %% standalone comment
        A[Progress %% complete] --> B`;

      expect(normalizeMermaidCode(input)).toBe(input);
    });

    it('quotes unquoted subgraph titles that contain parentheses', () => {
      const input = `graph LR
        subgraph 流量层 (日活十亿)
          A --> B
        end`;

      expect(normalizeMermaidCode(input)).toBe(`graph LR
        subgraph "流量层 (日活十亿)"
          A --> B
        end`);
    });

    it('leaves quoted and id-based subgraph titles unchanged', () => {
      const input = `graph LR
        subgraph "流量层 (日活十亿)"
        end
        subgraph traffic["流量层 (日活十亿)"]
        end`;

      expect(normalizeMermaidCode(input)).toBe(input);
    });

    it('repairs a translated empty activation when the participant is later deactivated', () => {
      const input = `sequenceDiagram
        participant 你
        激活->>你:
        你->>系统: 修复
        deactivate 你`;

      expect(normalizeMermaidCode(input)).toBe(`sequenceDiagram
        participant 你
        activate 你
        你->>系统: 修复
        deactivate 你`);
    });

    it('does not reinterpret a participant named 激活 or an unmatched empty message', () => {
      const input = `sequenceDiagram
        participant 激活
        participant 你
        激活->>你:
        你->>系统: 修复`;

      expect(normalizeMermaidCode(input)).toBe(input);
    });
  });

  describe('isGenericLanguageLabel', () => {
    it('should return true for null (no label)', () => {
      expect(isGenericLanguageLabel(null)).toBe(true);
    });

    it('should return true for generic English labels', () => {
      expect(isGenericLanguageLabel('code')).toBe(true);
      expect(isGenericLanguageLabel('text')).toBe(true);
      expect(isGenericLanguageLabel('plaintext')).toBe(true);
      expect(isGenericLanguageLabel('snippet')).toBe(true);
      expect(isGenericLanguageLabel('example')).toBe(true);
    });

    it('should return true for generic Chinese labels', () => {
      expect(isGenericLanguageLabel('代码段')).toBe(true);
      expect(isGenericLanguageLabel('代码')).toBe(true);
      expect(isGenericLanguageLabel('示例')).toBe(true);
    });

    it('should return true for generic Traditional Chinese labels', () => {
      expect(isGenericLanguageLabel('程式碼片段')).toBe(true);
    });

    it('should return true for generic Japanese labels', () => {
      expect(isGenericLanguageLabel('コード スニペット')).toBe(true);
    });

    it('should return true for the remaining verified Gemini localized labels', () => {
      const labels = [
        'مقتطف الرمز',
        'Fragmento de código',
        'Extrait de code',
        '코드 스니펫',
        'Snippet de código',
        'Фрагмент кода',
      ];

      labels.forEach((label) => {
        expect(isGenericLanguageLabel(label)).toBe(true);
      });
    });

    it('should return false for specific programming languages', () => {
      expect(isGenericLanguageLabel('python')).toBe(false);
      expect(isGenericLanguageLabel('javascript')).toBe(false);
      expect(isGenericLanguageLabel('typescript')).toBe(false);
      expect(isGenericLanguageLabel('rust')).toBe(false);
      expect(isGenericLanguageLabel('matlab')).toBe(false);
    });

    it('should return true for "mermaid" as it is in the generic set... wait no', () => {
      // "mermaid" is NOT in the generic set — it's handled separately in processCodeBlocks
      expect(isGenericLanguageLabel('mermaid')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isGenericLanguageLabel('Code')).toBe(true);
      expect(isGenericLanguageLabel('TEXT')).toBe(true);
      expect(isGenericLanguageLabel('Plaintext')).toBe(true);
    });
  });
});
