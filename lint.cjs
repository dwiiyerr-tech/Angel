const fs = require('fs');
const glob = require('glob');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const files = glob.sync(['src/**/*.{js,cjs,mjs}', 'test/**/*.{js,cjs,mjs}', 'scripts/**/*.{js,cjs,mjs}', '*.{js,cjs,mjs}'], {
  ignore: ['node_modules/**']
});

const globals = new Set([
  'console', 'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout',
  'Date', 'process', 'Math', 'Number', 'JSON', 'String', 'Array', 'Promise',
  'AbortController', 'AbortSignal', 'Buffer', 'fetch', 'URL', 'URLSearchParams',
  'Error', 'RegExp', 'Object', 'Boolean', 'Set', 'Map', 'BigInt', 'parseFloat',
  'parseInt', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'global', 'globalThis',
  'exports', 'module', 'require', '__dirname', '__filename',
  'describe', 'it', 'before', 'beforeEach', 'after', 'afterEach', 'expect', 'assert', 'test'
]);

let hasErrors = false;

for (const f of files) {
  const code = fs.readFileSync(f, 'utf8');
  try {
    const ast = parse(code, { sourceType: 'module', allowReturnOutsideFunction: true });
    let undeclared = [];

    traverse(ast, {
      Identifier(path) {
        if (path.isReferencedIdentifier()) {
          const name = path.node.name;
          if (!path.scope.hasBinding(name) && !globals.has(name)) {
            undeclared.push({ name, line: path.node.loc.start ? path.node.loc.start.line : '?' });
          }
        }
      }
    });

    if (undeclared.length > 0) {
      console.log(`${f}: Undeclared:`, undeclared.map(u => `${u.name} (L${u.line})`).join(', '));
      hasErrors = true;
    }
  } catch (e) {
    console.error(`Error parsing ${f}:`, e.message);
    hasErrors = true;
  }
}

if (hasErrors) {
  process.exit(1);
} else {
  console.log(`[lint] Clean! Scanned ${files.length} JavaScript files.`);
  process.exit(0);
}

