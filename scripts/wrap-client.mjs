import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const clientPath = join(process.cwd(), 'lib', 'client.js');
let content = readFileSync(clientPath, 'utf8');

// If not already wrapped in window.__ModuleLoader__.load
if (!content.includes('window.__ModuleLoader__.load')) {
  const wrapped = `window.__ModuleLoader__.load({
  id: "dsh-agy-safe",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");

${content.replace(/export const inject =/g, 'var inject =').replace(/export function apply/g, 'function apply')}

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
`;
  writeFileSync(clientPath, wrapped, 'utf8');
  console.log('Successfully wrapped lib/client.js with window.__ModuleLoader__.load');
}
