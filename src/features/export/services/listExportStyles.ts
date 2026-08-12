export function buildListExportStyles(scope: string, important = false): string {
  const bang = important ? ' !important' : '';

  return `
      ${scope} ol {
        list-style-type: decimal${bang};
        list-style-position: outside${bang};
        margin: 0.5em 0${bang};
        padding-inline-start: 2.5em${bang};
      }

      ${scope} ul {
        list-style-type: disc${bang};
        list-style-position: outside${bang};
        margin: 0.5em 0${bang};
        padding-inline-start: 2.5em${bang};
      }

      ${scope} li {
        display: list-item${bang};
      }

      ${scope} ol > li::marker,
      ${scope} ul > li::marker {
        content: normal${bang};
      }
  `;
}
